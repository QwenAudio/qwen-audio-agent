// Browser-safe model catalog shared by Gateway, Desktop and CLI. Provider files
// own model declarations; this module assembles and queries the immutable data.
import { DEFAULT_DASHSCOPE_REALTIME_MODEL, dashscopeModels } from './realtime-models/dashscope.mjs'
import { stepfunModels } from './realtime-models/stepfun.mjs'
import { gptLiveModels } from './realtime-models/gpt-live.mjs'
import { googleLiveModels } from './realtime-models/google-live.mjs'
import { doubaoSeeduplexModels } from './realtime-models/doubao-seeduplex.mjs'

export * from './realtime-models/dashscope.mjs'
export * from './realtime-models/stepfun.mjs'
export * from './realtime-models/gpt-live.mjs'
export * from './realtime-models/google-live.mjs'
export * from './realtime-models/doubao-seeduplex.mjs'

export const REALTIME_MODEL_BUILTINS = Object.freeze({
  dashscope: dashscopeModels,
  stepfun: stepfunModels,
  'gpt-live': gptLiveModels,
  'google-live': googleLiveModels,
  'doubao-seeduplex': doubaoSeeduplexModels,
})

// Model parameters come only from provider code, never from user configuration.
export const BUILTIN_REALTIME_MODEL_CATALOGS = Object.freeze(Object.fromEntries(
  Object.entries(REALTIME_MODEL_BUILTINS).map(([provider, definition]) => [provider, Object.freeze({
    environment: definition.environment,
    defaultModel: definition.defaultModel,
    profiles: Object.freeze(Object.entries(definition.models).map(([id, model]) => {
      const preset = definition.apis[model.api]
      if (!preset) throw new TypeError('Unsupported model API: ' + provider + '/' + id + '/' + model.api)
      return Object.freeze({
        id,
        label: model.label,
        api: model.api,
        family: preset.family,
        sessionDefaults: Object.freeze({
          voice: model.voice,
          turnDetection: model.turnDetection
            ? Object.freeze({ type: model.turnDetection }) : preset.turnDetection,
        }),
        modelCapabilities: preset.defaultModelCapabilities,
        transportCapabilities: preset.transportCapabilities,
        sessionConstraints: preset.sessionConstraints,
      })
    })),
  })]),
))

export const DASHSCOPE_REALTIME_MODEL_PROFILES = BUILTIN_REALTIME_MODEL_CATALOGS.dashscope.profiles

export function realtimeModelCatalog(provider = 'dashscope', catalogs = BUILTIN_REALTIME_MODEL_CATALOGS) {
  return catalogs && Object.hasOwn(catalogs, provider) ? catalogs[provider] : null
}

const UNKNOWN_MODEL_CAPABILITIES = Object.freeze({
  textInput: false, audioInput: false, imageInput: false, videoInput: false,
  textOutput: false, audioOutput: false, functionCalling: false,
})
const UNKNOWN_TRANSPORT_CAPABILITIES = Object.freeze({
  textInput: false, audioInput: false, imageInput: false, imageBufferInput: false,
})
const UNKNOWN_SESSION_DEFAULTS = Object.freeze({ voice: null, turnDetection: null })
const UNKNOWN_SESSION_CONSTRAINTS = Object.freeze({})

function unknownModelProfile(id) {
  return Object.freeze({
    id, label: id, api: null, family: 'unknown',
    sessionDefaults: UNKNOWN_SESSION_DEFAULTS,
    modelCapabilities: UNKNOWN_MODEL_CAPABILITIES,
    transportCapabilities: UNKNOWN_TRANSPORT_CAPABILITIES,
    sessionConstraints: UNKNOWN_SESSION_CONSTRAINTS,
  })
}

export function resolveRealtimeModelProfile(model, provider = 'dashscope', catalogs = BUILTIN_REALTIME_MODEL_CATALOGS) {
  const catalog = realtimeModelCatalog(provider, catalogs)
  const id = String(model || catalog?.defaultModel || '').trim()
  return catalog?.profiles.find(profile => profile.id === id) || unknownModelProfile(id)
}

export function resolveDashScopeRealtimeModelProfile(model = DEFAULT_DASHSCOPE_REALTIME_MODEL, catalogs = BUILTIN_REALTIME_MODEL_CATALOGS) {
  const id = String(model || '').trim() || DEFAULT_DASHSCOPE_REALTIME_MODEL
  return resolveRealtimeModelProfile(id, 'dashscope', catalogs)
}

export function listDashScopeRealtimeModelProfiles(catalogs = BUILTIN_REALTIME_MODEL_CATALOGS) {
  return realtimeModelCatalog('dashscope', catalogs)?.profiles || Object.freeze([])
}
