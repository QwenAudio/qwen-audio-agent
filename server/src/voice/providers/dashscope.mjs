import { config, realtimeUrl } from '../../core/config.mjs'
import {
  TOOLS,
  buildFrontendInstructions,
  resultResponseInstructions,
  speakResponseInstructions,
  permissionResponseInstructions,
} from '../frontend-tools.mjs'
import { isRecoverableRealtimeInactivityError } from '../realtime-errors.mjs'
import { openAiCompatibleProtocol } from './openai-compatible-protocol.mjs'

function classifyError(message) {
  if (isRecoverableRealtimeInactivityError(message)) return 'inactivity'
  if (/user is speaking/i.test(message)) return 'input_busy'
  if (/no active response/i.test(message)) return 'no_active_response'
  return 'other'
}

export const dashscopeProvider = {
  key: 'dashscope',
  label: 'Qwen-Audio-Realtime',
  inputSampleRate: 16000,
  outputSampleRate: 24000,
  protocol: openAiCompatibleProtocol,

  model: () => config.audioModel,
  voice: () => config.audioVoice,
  isConfigured: () => Boolean(config.dashscopeApiKey),
  missingConfigurationMessage: '请先配置 DASHSCOPE_API_KEY',
  connectTimeoutMessage: '连接 Qwen Audio Realtime 超时',

  url: () => realtimeUrl(config.audioRealtimeBaseUrl, config.audioModel),
  headers: () => ({ Authorization: `Bearer ${config.dashscopeApiKey}` }),
  classifyError,

  buildSession: ({ configured, agentContext }) => {
    const textOnly = agentContext?.textOnly === true
    const session = {
      instructions: buildFrontendInstructions(agentContext),
      tools: TOOLS,
    }
    if (!configured) {
      session.modalities = textOnly ? ['text'] : ['text', 'audio']
      session.voice = config.audioVoice
      session.input_audio_format = 'pcm'
      session.output_audio_format = 'pcm'
      session.turn_detection = textOnly ? null : { type: 'smart_turn' }
    }
    return session
  },

  buildSpeakResponse: (content, { textOnly = false } = {}) => ({
    conversation: 'none',
    modalities: textOnly ? ['text'] : ['text', 'audio'],
    instructions: speakResponseInstructions(content),
  }),

  buildResultInjection: (content, { textOnly = false } = {}) => ({
    item: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: content }],
    },
    response: {
      modalities: textOnly ? ['text'] : ['text', 'audio'],
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
      modalities: textOnly ? ['text'] : ['text', 'audio'],
      tool_choice: 'none',
      instructions: permissionResponseInstructions,
    },
  }),
}
