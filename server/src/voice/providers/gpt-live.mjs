import { config } from '../../core/config.mjs'
import {
  realtimeModelCatalog,
  resolveRealtimeModelProfile,
} from '../../../../shared/realtime-model-catalog.mjs'
import { PERMISSION_DECISIONS } from '../../../../shared/permission-decisions.mjs'
import {
  buildFrontendInstructions,
  frontendTools,
  permissionResponseInstructions,
  resultResponseInstructions,
  speakResponseInstructions,
} from '../../frontend/frontend-tools.mjs'
import { isRecoverableRealtimeInactivityError } from '../realtime-errors.mjs'
import { gaRealtimeProtocol } from './ga-protocol.mjs'

function modelProfile() {
  return resolveRealtimeModelProfile(config.gptLiveModel, 'gpt-live')
}

function gptLiveUrl() {
  const url = new URL(config.gptLiveRealtimeUrl)
  url.searchParams.set('model', config.gptLiveModel)
  return url.toString()
}

function gptLiveTools(agentContext) {
  return frontendTools(agentContext).map(tool => ({
    type: 'function',
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
  }))
}

export const gptLiveProvider = {
  key: 'gpt-live',
  label: 'GPT-Live',
  aliases: ['openai', 'gptlive', 'gpt-realtime'],
  inputSampleRate: 24000,
  outputSampleRate: 24000,
  protocol: gaRealtimeProtocol,
  capabilities: {
    responseMetadataCorrelation: true,
    perResponseInstructions: true,
    sessionOutputVoice: true,
  },

  model: () => config.gptLiveModel,
  modelProfile,
  modelCatalog: () => realtimeModelCatalog('gpt-live').profiles,
  voice: () => config.gptLiveVoice || null,
  isConfigured: () => Boolean(config.openaiApiKey),
  missingConfigurationMessage: '请先配置 OPENAI_API_KEY',
  connectTimeoutMessage: '连接 GPT-Live Realtime 超时',
  url: gptLiveUrl,
  headers: () => ({ Authorization: `Bearer ${config.openaiApiKey}` }),
  classifyError: message => {
    if (isRecoverableRealtimeInactivityError(message)) return 'inactivity'
    if (/another response is in progress|already has an active response/i.test(message)) return 'response_slot_busy'
    if (/no (?:active|ongoing) response|no response.*cancel/i.test(message)) return 'no_active_response'
    if (/invalid[_ -]?api[_ -]?key|authentication|unauthorized|forbidden|unexpected server response: (?:401|403)|model[_ -]?not[_ -]?found/i.test(message)) return 'fatal'
    if (/content[_ -]?(?:filter|moderation|safety|policy)|policy violation/i.test(message)) return 'content_safety'
    return 'other'
  },

  buildSession: ({ agentContext, sessionOptions }) => {
    const voice = String(sessionOptions?.voice || config.gptLiveVoice || '').trim()
    return {
      type: 'realtime',
      instructions: buildFrontendInstructions(agentContext),
      tools: gptLiveTools(agentContext),
      output_modalities: ['audio'],
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: 24000 },
          turn_detection: modelProfile().sessionDefaults.turnDetection,
        },
        output: {
          format: { type: 'audio/pcm', rate: 24000 },
          ...(voice ? { voice } : {}),
        },
      },
    }
  },

  buildSpeakResponse: content => ({
    conversation: 'none',
    modalities: ['audio'],
    instructions: speakResponseInstructions(content),
    tool_choice: 'none',
  }),

  buildResultInjection: (content, { allowTools = false } = {}) => ({
    item: gaRealtimeProtocol.userTextItem(content),
    response: {
      modalities: ['audio'],
      tool_choice: allowTools ? 'auto' : 'none',
      instructions: resultResponseInstructions,
    },
  }),

  buildPermissionInjection: permission => ({
    item: gaRealtimeProtocol.userTextItem([
      '<permission_request>',
      `permission_id=${permission.id}`,
      `task_id=${permission.taskId}`,
      `operation=${permission.summary}`,
      `allowed_decisions=${PERMISSION_DECISIONS.join(',')}`,
      '</permission_request>',
    ].join('\n')),
    response: { modalities: ['audio'], tool_choice: 'none', instructions: permissionResponseInstructions },
  }),
}
