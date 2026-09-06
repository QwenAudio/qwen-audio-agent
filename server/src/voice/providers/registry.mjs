import { config } from '../../core/config.mjs'
import {
  listDashScopeRealtimeModelProfiles,
} from '../../../../shared/realtime-provider-catalog.mjs'
import { dashscopeProvider } from './dashscope.mjs'
import { s2sProvider } from './s2s.mjs'
import { miniCpmOProvider } from './minicpm-o.mjs'
import { createRealtimeProviderRegistry } from './provider-registry.mjs'

export {
  createRealtimeProviderRegistry,
  RealtimeProviderRegistry,
  validateRealtimeProtocol,
  validateRealtimeProvider,
} from './provider-registry.mjs'

export const defaultRealtimeProviderRegistry = createRealtimeProviderRegistry({
  providers: [dashscopeProvider, s2sProvider, miniCpmOProvider],
})

export function resolveRealtimeProvider(requested) {
  return defaultRealtimeProviderRegistry.resolve(
    requested || config.audioProvider,
  )
}

function providerDescriptor(provider) {
  return {
    key: provider.key,
    label: provider.label,
    model: provider.model(),
    realtimeModelIds: provider.modelCatalog?.().map(profile => profile.id)
      ?? (provider.key === 'dashscope'
        ? listDashScopeRealtimeModelProfiles().map(profile => profile.id)
        : null),
    configured: provider.isConfigured(),
  }
}

export function listRealtimeProviders({
  registry = defaultRealtimeProviderRegistry,
  includeGatewayOnly = false,
} = {}) {
  return registry.list({ includeGatewayOnly, configuredOnly: true })
    .map(providerDescriptor)
}

export function describeActiveRealtime(requested, {
  registry = defaultRealtimeProviderRegistry,
} = {}) {
  const provider = registry.resolve(requested || config.audioProvider)
  const modelProfile = provider.modelProfile?.() || null
  return {
    provider: provider.key,
    label: provider.label,
    model: provider.model(),
    modelProfile,
    modelCapabilities: modelProfile?.modelCapabilities || null,
    transportCapabilities: modelProfile?.transportCapabilities || null,
    modelCatalog: provider.modelCatalog?.()
      ?? (provider.key === 'dashscope'
        ? listDashScopeRealtimeModelProfiles()
        : []),
    voice: provider.voice(),
    inputSampleRate: provider.inputSampleRate,
    configured: provider.isConfigured(),
    configurationSignature: provider.configurationSignature?.()
      || config.realtimeConfigSignature,
    providers: listRealtimeProviders({ registry }),
  }
}

/**
 * Compatibility snapshot for callers that import the built-in providers.
 * Runtime extensions belong in a RealtimeProviderRegistry instance instead.
 */
export const REALTIME_PROVIDERS = Object.freeze({
  dashscope: dashscopeProvider,
  'speech-to-speech': s2sProvider,
  qwen: dashscopeProvider,
  s2s: s2sProvider,
  'minicpm-o': miniCpmOProvider,
  minicpmo: miniCpmOProvider,
})
