import { config, realtimeUrl } from '../../core/config.mjs'
import { PERMISSION_DECISIONS } from '../../../../shared/permission-decisions.mjs'
import {
  DASHSCOPE_OMNI_38_FLASH_REALTIME_MODEL,
  DASHSCOPE_OMNI_FLASH_REALTIME_MODEL,
  DASHSCOPE_OMNI_PLUS_REALTIME_MODEL,
  listDashScopeRealtimeModelProfiles,
  resolveDashScopeRealtimeModelProfile,
} from '../../../../shared/realtime-provider-catalog.mjs'
import {
  buildFrontendInstructions,
  frontendTools,
  resultResponseInstructions,
  speakResponseInstructions,
  permissionResponseInstructions,
} from '../../frontend/frontend-tools.mjs'
import { isRecoverableRealtimeInactivityError, RealtimeConfigurationError } from '../realtime-errors.mjs'
import { openAiCompatibleProtocol } from './openai-compatible-protocol.mjs'

function classifyError(message) {
  if (isRecoverableRealtimeInactivityError(message)) return 'inactivity'
  if (/user is speaking/i.test(message)) return 'input_busy'
  if (/already has (?:a pending response request|an active response)|another response is in progress/i.test(message)) {
    return 'response_slot_busy'
  }
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

function validateSessionOptions({ sessionOptions = {} } = {}) {
  const profile = activeModelProfile()
  if (profile.id === DASHSCOPE_OMNI_38_FLASH_REALTIME_MODEL) {
    // 3.8 requires a workspace endpoint. Reject the known incompatible public
    // endpoints, but allow user-managed proxies instead of enforcing a host allowlist.
    let endpoint
    try {
      endpoint = new URL(config.audioRealtimeBaseUrl)
    } catch {
      throw new RealtimeConfigurationError('请配置有效的 QWEN_AUDIO_REALTIME_BASE_URL WebSocket 服务地址')
    }
    if (['dashscope.aliyuncs.com', 'dashscope-intl.aliyuncs.com', 'dashscope-us.aliyuncs.com'].includes(endpoint.hostname)) {
      throw new RealtimeConfigurationError(
        `${profile.id} 需要百炼业务空间专属地址；请将 QWEN_AUDIO_REALTIME_BASE_URL（桌面版“服务地址”）设为该业务空间的 WebSocket 地址，并使用对应的 API Key`,
      )
    }
  }
  const voice = String(sessionOptions.voice || '').trim() || dashscopeProvider.voice()
  // Known mismatch, not a complete voice allowlist. Cherry belongs to the older
  // Omni generation and causes silent closes on 3.5 (#334). Unknown/cloned
  // voices remain the provider's responsibility; do not infer their model from
  // their IDs. See https://help.aliyun.com/zh/model-studio/omni-voice-list
  if (
    voice === 'Cherry'
    && [DASHSCOPE_OMNI_FLASH_REALTIME_MODEL, DASHSCOPE_OMNI_PLUS_REALTIME_MODEL].includes(profile.id)
  ) {
    throw new RealtimeConfigurationError(
      `音色 ${voice} 不支持模型 ${profile.id}；请改用该模型的默认音色 ${profile.sessionDefaults.voice}`,
    )
  }
}

export const dashscopeProvider = {
  key: 'dashscope',
  label: 'DashScope Realtime',
  aliases: ['qwen'],
  inputSampleRate: 16000,
  outputSampleRate: 24000,
  protocol: openAiCompatibleProtocol,

  get capabilities() {
    return {
      perResponseInstructions: true,
      singleResponseSlot: true,
      sessionOutputVoice: true,
      conversationItemIdEcho: activeModelProfile().family !== 'omni',
      imageRequiresAudioStart: true,
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
  validateSessionOptions,

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
      if (profile.id === DASHSCOPE_OMNI_38_FLASH_REALTIME_MODEL) {
        // Keep the client audio contract unchanged: mono PCM16, 16 kHz in /
        // 24 kHz out. 3.8 uses the nested audio configuration on first setup only.
        session.audio = {
          input: { format: { type: 'pcm', sample_rate: dashscopeProvider.inputSampleRate } },
          output: {
            format: { type: 'pcm', sample_rate: dashscopeProvider.outputSampleRate },
            voice: sessionVoice || dashscopeProvider.voice(),
          },
        }
      } else {
        if (profile.modelCapabilities.audioOutput) {
          session.voice = sessionVoice || dashscopeProvider.voice()
          session.output_audio_format = 'pcm'
        }
        if (profile.transportCapabilities.audioInput) {
          session.input_audio_format = 'pcm'
        }
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
          `permission_id=${permission.id}`,
          `task_id=${permission.taskId}`,
          `operation=${permission.summary}`,
          `allowed_decisions=${PERMISSION_DECISIONS.join(',')}`,
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
