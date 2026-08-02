import { config } from '../../core/config.mjs'
import { dashscopeProvider } from './dashscope.mjs'
import { s2sProvider } from './s2s.mjs'

const PROVIDER_METHODS = [
  'model',
  'voice',
  'isConfigured',
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
  'conversationItemId',
  'conversationItemCreate',
  'responseCreate',
  'responseCancel',
  'userTextItem',
  'functionOutputItem',
]

// Optional behavioural declarations. A provider only lists the guarantees of
// the Realtime specification it does not uphold; omitting the block means the
// implementation is fully compliant. See DEFAULT_CAPABILITIES in
// realtime-provider.mjs for the compensations each flag enables.
const CAPABILITY_FLAGS = [
  'acknowledgesSessionUpdate',
  'singleResponseSlot',
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
  for (const flag of Object.keys(provider.capabilities || {})) {
    if (!CAPABILITY_FLAGS.includes(flag)) {
      throw new Error(
        `Realtime Provider ${provider.key} 声明了未知能力：${flag}`,
      )
    }
    if (typeof provider.capabilities[flag] !== 'boolean') {
      throw new Error(
        `Realtime Provider ${provider.key} 的能力 ${flag} 必须是布尔值`,
      )
    }
  }
  return provider
}

validateRealtimeProvider(dashscopeProvider)
validateRealtimeProvider(s2sProvider)

const providers = new Map([
  ['dashscope', dashscopeProvider],
  // Compatibility alias for internal callers while provider selection moves
  // to stable external names.
  ['qwen', dashscopeProvider],
  ['speech-to-speech', s2sProvider],
  // Compatibility alias. Public configuration and UI use the full project
  // name so it cannot be confused with the generic speech-to-speech concept.
  ['s2s', s2sProvider],
])

export function resolveRealtimeProvider(requested) {
  const key = String(requested || config.audioProvider || '')
    .trim()
    .toLowerCase()
  const provider = providers.get(key)
  if (!provider) {
    throw new Error(`不支持的 Realtime 供应商：${requested || config.audioProvider}`)
  }
  return provider
}

export function listRealtimeProviders() {
  const seen = new Set()
  return [...providers.values()]
    .filter(provider => {
      if (seen.has(provider.key)) return false
      seen.add(provider.key)
      return true
    })
    .filter(provider => provider.isConfigured())
    .map(provider => ({
      key: provider.key,
      label: provider.label,
      model: provider.model(),
      configured: provider.isConfigured(),
    }))
}

export function describeActiveRealtime(requested) {
  const provider = resolveRealtimeProvider(requested)
  return {
    provider: provider.key,
    label: provider.label,
    model: provider.model(),
    voice: provider.voice(),
    inputSampleRate: provider.inputSampleRate,
    configured: provider.isConfigured(),
    providers: listRealtimeProviders(),
  }
}

/**
 * Exposed for tests and callers that need direct provider access.
 * New code should use resolveRealtimeProvider() instead.
 */
export const REALTIME_PROVIDERS = Object.fromEntries(providers)
