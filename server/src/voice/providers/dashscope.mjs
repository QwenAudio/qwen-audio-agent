import { config, realtimeUrl } from '../../core/config.mjs'
import {
  listDashScopeRealtimeModelProfiles,
  resolveDashScopeRealtimeModelProfile,
} from '../../../../shared/realtime-provider-catalog.mjs'
import {
  buildFrontendInstructions,
  frontendTools,
  resultResponseInstructions,
  speakResponseInstructions,
  permissionResponseInstructions,
} from '../frontend-tools.mjs'
import { permissionReference } from '../tools/permission-reference.mjs'
import { isRecoverableRealtimeInactivityError } from '../realtime-errors.mjs'
import { openAiCompatibleProtocol } from './openai-compatible-protocol.mjs'

function classifyError(message) {
  if (isRecoverableRealtimeInactivityError(message)) return 'inactivity'
  if (/user is speaking/i.test(message)) return 'input_busy'
  if (/no active response/i.test(message)) return 'no_active_response'
  if (
    /data[_ -]?inspection[_ -]?failed|ip[_ -]?infringement[_ -]?suspect/i.test(message)
    || /inappropriate content|content[_ -]?(?:filter|moderation|safety|policy)/i.test(message)
    || /(?:input|output) data may contain/i.test(message)
  ) return 'content_safety'
  if (
    /invalid[_ -]?api[_ -]?key|incorrect api key|authentication failed|unauthorized|unexpected server response: (?:401|403)/i
      .test(message)
    || /\barrearage\b|account is not in good standing/i.test(message)
    || /allocationquota\.freetieronly|free allocated quota exceeded|free tier .* exhausted/i
      .test(message)
    || /model(?:\.|_)?accessdenied|model[_ -]?not[_ -]?found/i.test(message)
  ) return 'fatal'
  return 'other'
}

function activeModelProfile() {
  return resolveDashScopeRealtimeModelProfile(config.audioModel)
}

function responseModalities(profile) {
  const capabilities = profile.modelCapabilities
  return [
    capabilities.textOutput ? 'text' : null,
    capabilities.audioOutput ? 'audio' : null,
  ].filter(Boolean)
}

export const dashscopeProvider = {
  key: 'dashscope',
  label: 'Qwen-Audio-Realtime',
  aliases: ['qwen'],
  inputSampleRate: 16000,
  outputSampleRate: 24000,
  protocol: openAiCompatibleProtocol,

  get capabilities() {
    return {
      perResponseInstructions: true,
      sessionOutputVoice: true,
      conversationItemIdEcho: activeModelProfile().family !== 'omni',
    }
  },

  model: () => config.audioModel,
  modelCatalog: listDashScopeRealtimeModelProfiles,
  modelProfile: activeModelProfile,
  voice: () => config.audioVoice || activeModelProfile().sessionDefaults.voice,
  isConfigured: () => Boolean(config.dashscopeApiKey),
  missingConfigurationMessage: '请先配置 DASHSCOPE_API_KEY',
  connectTimeoutMessage: '连接 Qwen Audio Realtime 超时',

  url: () => realtimeUrl(config.audioRealtimeBaseUrl, config.audioModel),
  headers: () => ({ Authorization: `Bearer ${config.dashscopeApiKey}` }),
  classifyError,

  buildSession: ({ configured, agentContext, sessionOptions }) => {
    const profile = activeModelProfile()
    const sessionVoice = String(sessionOptions?.voice || '').trim()
    const session = {
      instructions: buildFrontendInstructions(agentContext),
    }
    if (profile.modelCapabilities.functionCalling) {
      session.tools = frontendTools(agentContext)
    }
    if (!configured) {
      session.modalities = responseModalities(profile)
      if (profile.modelCapabilities.audioOutput) {
        session.voice = sessionVoice || dashscopeProvider.voice()
        session.output_audio_format = 'pcm'
      }
      if (profile.transportCapabilities.audioInput) {
        session.input_audio_format = 'pcm'
      }
      session.turn_detection = profile.transportCapabilities.audioInput
        ? profile.sessionDefaults.turnDetection
        : null
    }
    return session
  },

  buildSpeakResponse: content => ({
    conversation: 'none',
    modalities: responseModalities(activeModelProfile()),
    instructions: speakResponseInstructions(content),
  }),

  buildResultInjection: (content, { allowTools = false } = {}) => ({
    item: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: content }],
    },
    response: {
      modalities: responseModalities(activeModelProfile()),
      tool_choice: allowTools ? 'auto' : 'none',
      instructions: resultResponseInstructions,
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
          `permission_id=${permissionReference(permission.id)}`,
          `task_id=${permission.taskId}`,
          `operation=${permission.summary}`,
          'allowed_decisions=once,always,reject',
          '</permission_request>',
        ].join('\n'),
      }],
    },
    response: {
      modalities: responseModalities(activeModelProfile()),
      tool_choice: 'none',
      instructions: permissionResponseInstructions,
    },
  }),
}
