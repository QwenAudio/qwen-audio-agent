import { providerRuntimeConfiguration } from './runtime-configuration.mjs'
import { config } from '../../core/config.mjs'
import {
  realtimeModelCatalog,
  resolveRealtimeModelProfile,
} from '../../../../shared/realtime-model-catalog.mjs'
import { PERMISSION_DECISIONS } from '../../../../shared/permission-decisions.mjs'
import {
  buildFrontendInstructions,
  frontendTools,
  speakResponseInstructions,
} from '../../frontend/frontend-tools.mjs'
import { isRecoverableRealtimeInactivityError } from '../realtime-errors.mjs'
import { createDoubaoSeeduplexProtocol } from './doubao-seeduplex-protocol.mjs'

const connection = providerRuntimeConfiguration('doubao-seeduplex')

function modelProfile() {
  return resolveRealtimeModelProfile(
    connection.model,
    'doubao-seeduplex',
    config.realtimeModelCatalogs,
  )
}

function cleanText(value) {
  return String(value || '').trim()
}

export const doubaoSeeduplexProvider = {
  key: 'doubao-seeduplex',
  label: 'Doubao Seeduplex Realtime',
  aliases: ['doubao', 'seeduplex', 'volcengine'],
  inputSampleRate: 16000,
  outputSampleRate: 24000,
  createProtocol: createDoubaoSeeduplexProtocol,
  capabilities: {
    // The Seeduplex duplex endpoint starts its own responses from audio/text
    // input; Gateway response.create is translated to speech_text_buffer.commit.
    singleResponseSlot: true,
    conversationItemIdEcho: false,
    acknowledgesConversationItems: false,
    automaticToolResponses: true,
    perResponseInstructions: false,
    sessionOutputVoice: true,
  },
  model: () => connection.model,
  modelProfile,
  modelCatalog: () => realtimeModelCatalog('doubao-seeduplex', config.realtimeModelCatalogs).profiles,
  voice: () => cleanText(connection.voice) || modelProfile().sessionDefaults.voice,
  isConfigured: () => connection.configured,
  missingConfigurationMessage: '请先选择 doubao-seeduplex 并配置 QWEN_AUDIO_REALTIME_API_KEY',
  connectTimeoutMessage: '连接 Doubao Seeduplex Realtime 超时',
  url: () => connection.endpoint,
  headers: () => ({ 'X-Api-Key': connection.credential }),
  classifyError: message => {
    if (isRecoverableRealtimeInactivityError(message)) return 'inactivity'
    if (/no active response|no response.*cancel/i.test(message)) return 'no_active_response'
    if (/invalid.*api.*key|authentication|unauthorized|forbidden|unexpected server response: (?:401|403)|quota|arrearage/i.test(message)) return 'fatal'
    if (/content|audit|safety|risk|risky|inspection/i.test(message)) return 'content_safety'
    return 'other'
  },

  buildSession: ({ agentContext, sessionOptions }) => {
    const voice = cleanText(sessionOptions?.voice) || doubaoSeeduplexProvider.voice()
    return {
      model: doubaoSeeduplexProvider.model(),
      instructions: buildFrontendInstructions(agentContext),
      audio: {
        input: {
          format: { type: 'pcm', rate: 16000 },
        },
        output: {
          format: { type: 'pcm', rate: 24000 },
          ...(voice ? { voice } : {}),
          speed: 0,
          loudness: 0,
        },
      },
      tools: createDoubaoSeeduplexProtocol().doubaoTools(frontendTools(agentContext)),
    }
  },

  buildSpeakResponse: content => ({
    instructions: speakResponseInstructions(content),
  }),

  buildResultInjection: content => ({
    item: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: content }],
    },
    response: {
      instructions: content,
    },
  }),

  buildPermissionInjection: permission => ({
    item: {
      type: 'message',
      role: 'user',
      content: [{
        type: 'input_text',
        text: [
          '<permission_request>',
          `permission_id=${permission.id}`,
          `task_id=${permission.taskId}`,
          `operation=${permission.summary}`,
          `allowed_decisions=${PERMISSION_DECISIONS.join(',')}`,
          '</permission_request>',
        ].join('\n'),
      }],
    },
    response: {
      instructions: `请简短询问用户是否同意授权：${permission.summary}`,
    },
  }),
}
