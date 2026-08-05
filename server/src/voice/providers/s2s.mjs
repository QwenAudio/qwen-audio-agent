import { config } from '../../core/config.mjs'
import {
  buildFrontendInstructions,
  frontendTools,
  resultResponseInstructions,
  speakResponseInstructions,
  permissionResponseInstructions,
} from '../frontend-tools.mjs'
import { gaRealtimeProtocol } from './ga-protocol.mjs'

const INPUT_SAMPLE_RATE = 16000
const OUTPUT_SAMPLE_RATE = 24000

function classifyError(message) {
  if (/session_limit_reached|session slots? (?:are|is) in use/i.test(message)) {
    return 'capacity_busy'
  }
  // The single per-session response slot refuses concurrent response.create
  // requests. The frontend retries these transparently (singleResponseSlot).
  if (/another response is in progress/i.test(message)) return 'response_slot_busy'
  if (/no active response/i.test(message)) return 'no_active_response'
  return 'other'
}

/**
 * Thin profile for a user-managed huggingface/speech-to-speech endpoint. The
 * upstream process owns all model, STT, TTS and voice choices; this profile
 * only describes its OpenAI Realtime wire contract.
 */
export const s2sProvider = {
  key: 'speech-to-speech',
  label: 'Hugging Face Speech-to-Speech',
  inputSampleRate: INPUT_SAMPLE_RATE,
  outputSampleRate: OUTPUT_SAMPLE_RATE,
  // Fully local ASR -> LLM -> TTS can take substantially longer than a cloud
  // model before producing its first response event.
  responseStartTimeoutMs: 60_000,
  protocol: gaRealtimeProtocol,

  capabilities: {
    // speech-to-speech applies session.update without sending session.updated.
    acknowledgesSessionUpdate: false,
    // One response slot per session: a gateway response.create can race a
    // server-side VAD turn and gets refused instead of queued.
    singleResponseSlot: true,
    // The service echoes response metadata, so Gateway-created responses can
    // be distinguished from automatic server-VAD responses without relying on
    // event arrival order.
    responseMetadataCorrelation: true,
  },

  model: () => null,
  voice: () => null,
  isConfigured: () => config.speechToSpeechConfigured,
  missingConfigurationMessage: '请先配置 SPEECH_TO_SPEECH_REALTIME_URL',
  connectTimeoutMessage: `连接 Hugging Face speech-to-speech 服务超时（${config.speechToSpeechRealtimeUrl}），请确认 speech-to-speech 服务已启动`,

  url: () => config.speechToSpeechRealtimeUrl,
  headers: () => config.speechToSpeechAuthToken
    ? { Authorization: `Bearer ${config.speechToSpeechAuthToken}` }
    : {},
  classifyError,

  buildSession: ({ agentContext }) => {
    const textOnly = agentContext?.textOnly === true
    return {
      // The GA schema requires a session type discriminator.
      type: 'realtime',
      instructions: buildFrontendInstructions(agentContext),
      // GA tools are flat objects rather than the beta { type, function } shape.
      tools: frontendTools(agentContext).map(tool => ({
        type: 'function',
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters,
      })),
      output_modalities: textOnly ? ['text'] : ['audio'],
      audio: {
        input: {
          // speech-to-speech treats an omitted input format as its native
          // 16 kHz PCM pipeline rate. OpenAI's GA AudioPCM schema only accepts
          // 24 kHz when the format is explicit, so declaring 16 kHz here would
          // make the entire session.update invalid.
          turn_detection: textOnly
            ? null
            : { type: 'server_vad', interrupt_response: true },
        },
        output: {
          // Negotiate the common client playback rate explicitly. The
          // upstream service resamples its internal 16 kHz pipeline output.
          format: {
            type: 'audio/pcm',
            rate: OUTPUT_SAMPLE_RATE,
          },
        },
      },
    }
  },

  buildSpeakResponse: (content, { textOnly = false } = {}) => ({
    conversation: 'none',
    modalities: textOnly ? ['text'] : ['audio'],
    instructions: speakResponseInstructions(content),
    tool_choice: 'none',
  }),

  buildResultInjection: (content, { textOnly = false } = {}) => ({
    item: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: content }],
    },
    response: {
      modalities: textOnly ? ['text'] : ['audio'],
      tool_choice: 'none',
      instructions: resultResponseInstructions,
    },
  }),

  buildPermissionInjection: (permission, { textOnly = false } = {}) => ({
    item: {
      type: 'message',
      role: 'user',
      content: [{
        type: 'input_text',
        text: [
          '<backend_permission_request>',
          `authorization_id=${permission.id}`,
          `operation=${permission.summary}`,
          '</backend_permission_request>',
        ].join('\n'),
      }],
    },
    response: {
      modalities: textOnly ? ['text'] : ['audio'],
      tool_choice: 'none',
      instructions: permissionResponseInstructions,
    },
  }),
}
