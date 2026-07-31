import { config } from '../../core/config.mjs'
import { dashscopeProvider } from './dashscope.mjs'

const PROVIDER_METHODS = [
  'model',
  'voice',
  'apiKey',
  'url',
  'headers',
  'classifyError',
  'buildSession',
  'buildSpeakResponse',
  'buildResultInjection',
  'buildPermissionInjection',
]

const PROTOCOL_METHODS = [
  'encodeOutgoing',
  'normalizeIncoming',
  'sessionUpdate',
  'audioAppend',
  'conversationItemCreate',
  'responseCreate',
  'responseCancel',
  'userTextItem',
  'functionOutputItem',
]

export function validateRealtimeProvider(provider) {
  if (!provider?.key || !provider.label) {
    throw new Error('Realtime Provider 必须定义 key 和 label')
  }
  for (const method of PROVIDER_METHODS) {
    if (typeof provider[method] !== 'function') {
      throw new Error(`Realtime Provider ${provider.key} 缺少 ${method}()`)
    }
  }
  if (!Number.isFinite(provider.inputSampleRate)) {
    throw new Error(`Realtime Provider ${provider.key} 缺少 inputSampleRate`)
  }
  if (!Number.isFinite(provider.outputSampleRate)) {
    throw new Error(`Realtime Provider ${provider.key} 缺少 outputSampleRate`)
  }
  for (const method of PROTOCOL_METHODS) {
    if (typeof provider.protocol?.[method] !== 'function') {
      throw new Error(
        `Realtime Provider ${provider.key} protocol 缺少 ${method}()`,
      )
    }
  }
  return provider
}

validateRealtimeProvider(dashscopeProvider)

const providers = new Map([
  ['dashscope', dashscopeProvider],
  // Compatibility alias for internal callers while provider selection moves
  // to stable external names.
  ['qwen', dashscopeProvider],
])

export function resolveRealtimeProvider() {
  const provider = providers.get(config.audioProvider)
  if (!provider) {
    throw new Error(`不支持的 Realtime 供应商：${config.audioProvider}`)
  }
  return provider
}

export function describeActiveRealtime() {
  const provider = resolveRealtimeProvider()
  return {
    provider: provider.key,
    label: provider.label,
    model: provider.model(),
    voice: provider.voice(),
    inputSampleRate: provider.inputSampleRate,
    configured: Boolean(provider.apiKey()),
  }
}

/**
 * Exposed for tests and callers that need direct provider access.
 * New code should use resolveRealtimeProvider() instead.
 */
export const REALTIME_PROVIDERS = Object.fromEntries(providers)
