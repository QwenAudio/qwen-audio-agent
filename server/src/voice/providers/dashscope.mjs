import { providerRuntimeConfiguration } from './runtime-configuration.mjs'
import { config, realtimeUrl } from '../../core/config.mjs'
import { PERMISSION_DECISIONS } from '../../../../shared/permission-decisions.mjs'
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
} from '../../frontend/frontend-tools.mjs'
import { isRecoverableRealtimeInactivityError, RealtimeConfigurationError } from '../realtime-errors.mjs'
import { openAiCompatibleProtocol } from './openai-compatible-protocol.mjs'

const connection = providerRuntimeConfiguration('dashscope')

function classifyError(message) {
  if (isRecoverableRealtimeInactivityError(message)) return 'inactivity'
  // DashScope exposes one response slot per realtime session. A gateway
  // response can race the tail of another model/tool response before its
  // lifecycle events reach us; let RealtimeFrontend replay it after idle.
  if (/another response is in progress|cannot create response while .*response.*in progress/i.test(message)) {
    return 'response_slot_busy'
  }
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
  return resolveDashScopeRealtimeModelProfile(connection.model, config.realtimeModelCatalogs)
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
  if (profile.sessionConstraints.workspaceEndpoint) {
    // This API requires a workspace endpoint. Reject the known incompatible public
    // endpoints, but allow user-managed proxies instead of enforcing a host allowlist.
    let endpoint
    try {
      endpoint = new URL(connection.endpoint)
    } catch {
      throw new RealtimeConfigurationError('请配置有效的 QWEN_AUDIO_REALTIME_URL WebSocket 服务地址')
    }
    if (['dashscope.aliyuncs.com', 'dashscope-intl.aliyuncs.com', 'dashscope-us.aliyuncs.com'].includes(endpoint.hostname)) {
      throw new RealtimeConfigurationError(
        `${profile.id} 需要百炼业务空间专属地址；请将 QWEN_AUDIO_REALTIME_URL（桌面版“服务地址”）设为该业务空间的 WebSocket 地址，并使用对应的 API Key`,
      )
    }
  }
  const voice = String(sessionOptions.voice || '').trim() || dashscopeProvider.voice()
  // The selected API defines known incompatible voices, not a full allowlist.
  // Unknown/cloned voices remain the upstream provider's responsibility.
  if (profile.sessionConstraints.unsupportedVoices?.includes(voice)) {
    const suggestion = profile.sessionDefaults.voice
      ? `请改用该模型的默认音色 ${profile.sessionDefaults.voice}`
      : '请清空音色以使用服务默认值，或选择该 API 支持的音色'
    throw new RealtimeConfigurationError(
      `音色 ${voice} 不支持模型 ${profile.id}；${suggestion}`,
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

  model: () => connection.model,
  modelCatalog: () => listDashScopeRealtimeModelProfiles(config.realtimeModelCatalogs),
  modelProfile: activeModelProfile,
  voice: () => String(connection.voice || '').trim() || activeModelProfile().sessionDefaults.voice,
  isConfigured: () => connection.configured,
  missingConfigurationMessage: '请先选择 dashscope 并配置 QWEN_AUDIO_REALTIME_API_KEY',
  connectTimeoutMessage: '连接 Qwen Audio Realtime 超时',

  url: () => realtimeUrl(connection.endpoint, connection.model),
  headers: () => ({ Authorization: `Bearer ${connection.credential}` }),
  classifyError,
  validateSessionOptions,

  buildSession: ({ configured, agentContext, sessionOptions }) => {
    const profile = activeModelProfile()
    const voice = String(sessionOptions?.voice || '').trim() || dashscopeProvider.voice()
    const session = {
      instructions: buildFrontendInstructions(agentContext),
    }
    if (profile.modelCapabilities.functionCalling) {
      session.tools = frontendTools(agentContext)
    }
    if (!configured) {
      session.modalities = responseModalities(profile)
      if (profile.api === 'omni-v2') {
        // Keep the client audio contract unchanged: mono PCM16, 16 kHz in /
        // 24 kHz out. Omni v2 uses nested audio configuration on first setup only.
        session.audio = {
          input: { format: { type: 'pcm', sample_rate: dashscopeProvider.inputSampleRate } },
          output: {
            format: { type: 'pcm', sample_rate: dashscopeProvider.outputSampleRate },
            ...(voice ? { voice } : {}),
          },
        }
      } else {
        if (profile.modelCapabilities.audioOutput) {
          if (voice) session.voice = voice
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
