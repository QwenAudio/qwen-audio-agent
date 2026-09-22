export const DEFAULT_DASHSCOPE_REALTIME_MODEL = 'qwen-audio-3.0-realtime-plus'
export const DEFAULT_DASHSCOPE_REALTIME_VOICE = 'longanqian'
export const DEFAULT_GPT_LIVE_REALTIME_MODEL = 'gpt-realtime-2.1'
export const DEFAULT_GOOGLE_LIVE_REALTIME_MODEL = 'gemini-3.8-live'
export const DEFAULT_DOUBAO_SEEDUPLEX_REALTIME_MODEL = '1.2.6.1'
export const DEFAULT_DOUBAO_SEEDUPLEX_REALTIME_VOICE = 'zh_female_vv_jupiter_bigtts'

export const DASHSCOPE_AUDIO_FLASH_REALTIME_MODEL = 'qwen-audio-3.0-realtime-flash'
export const DASHSCOPE_OMNI_FLASH_REALTIME_MODEL = 'qwen3.5-omni-flash-realtime'
export const DASHSCOPE_OMNI_PLUS_REALTIME_MODEL = 'qwen3.5-omni-plus-realtime'
export const DEFAULT_STEPFUN_REALTIME_MODEL = 'stepaudio-3-realtime-preview'

const OMNI_MODEL_CAPABILITIES = Object.freeze({
  textInput: true, audioInput: true, imageInput: true, videoInput: true,
  textOutput: true, audioOutput: true, functionCalling: true,
})
const OMNI_TRANSPORT_CAPABILITIES = Object.freeze({
  textInput: true, audioInput: true, imageInput: false,
  imageBufferInput: true,
})
const LEGACY_MODEL_CAPABILITIES = Object.freeze({
  textInput: true, audioInput: true, imageInput: false, videoInput: false,
  textOutput: true, audioOutput: true, functionCalling: true,
})
const LEGACY_TRANSPORT_CAPABILITIES = Object.freeze({
  textInput: true, audioInput: true, imageInput: false,
  imageBufferInput: false,
})
const UNKNOWN_MODEL_CAPABILITIES = Object.freeze({
  textInput: false, audioInput: false, imageInput: false, videoInput: false,
  textOutput: false, audioOutput: false, functionCalling: false,
})
const UNKNOWN_TRANSPORT_CAPABILITIES = Object.freeze({
  textInput: false, audioInput: false, imageInput: false,
  imageBufferInput: false,
})
const OMNI_SESSION_DEFAULTS = Object.freeze({
  voice: 'Ethan',
  turnDetection: Object.freeze({ type: 'semantic_vad' }),
})
const AUDIO_SESSION_DEFAULTS = Object.freeze({
  voice: DEFAULT_DASHSCOPE_REALTIME_VOICE,
  turnDetection: Object.freeze({ type: 'smart_turn' }),
})
const UNKNOWN_SESSION_DEFAULTS = Object.freeze({
  voice: null,
  turnDetection: null,
})

export const DASHSCOPE_REALTIME_MODEL_PROFILES = Object.freeze([
  Object.freeze({
    id: DASHSCOPE_OMNI_FLASH_REALTIME_MODEL,
    label: 'Qwen3.5 Omni Flash Realtime',
    family: 'omni',
    sessionDefaults: OMNI_SESSION_DEFAULTS,
    modelCapabilities: OMNI_MODEL_CAPABILITIES,
    transportCapabilities: OMNI_TRANSPORT_CAPABILITIES,
  }),
  Object.freeze({
    id: DASHSCOPE_OMNI_PLUS_REALTIME_MODEL,
    label: 'Qwen3.5 Omni Plus Realtime',
    family: 'omni',
    sessionDefaults: OMNI_SESSION_DEFAULTS,
    modelCapabilities: OMNI_MODEL_CAPABILITIES,
    transportCapabilities: OMNI_TRANSPORT_CAPABILITIES,
  }),
  Object.freeze({
    id: DEFAULT_DASHSCOPE_REALTIME_MODEL,
    label: 'Qwen Audio 3.0 Realtime Plus',
    family: 'audio',
    sessionDefaults: AUDIO_SESSION_DEFAULTS,
    modelCapabilities: LEGACY_MODEL_CAPABILITIES,
    transportCapabilities: LEGACY_TRANSPORT_CAPABILITIES,
  }),
  Object.freeze({
    id: DASHSCOPE_AUDIO_FLASH_REALTIME_MODEL,
    label: 'Qwen Audio 3.0 Realtime Flash',
    family: 'audio',
    sessionDefaults: AUDIO_SESSION_DEFAULTS,
    modelCapabilities: LEGACY_MODEL_CAPABILITIES,
    transportCapabilities: LEGACY_TRANSPORT_CAPABILITIES,
  }),
])

const PROFILES_BY_ID = new Map(
  DASHSCOPE_REALTIME_MODEL_PROFILES.map(profile => [profile.id, profile]),
)

export function listDashScopeRealtimeModelProfiles() {
  return DASHSCOPE_REALTIME_MODEL_PROFILES
}

export function resolveDashScopeRealtimeModelProfile(
  model = DEFAULT_DASHSCOPE_REALTIME_MODEL,
) {
  const id = String(model || '').trim() || DEFAULT_DASHSCOPE_REALTIME_MODEL
  return PROFILES_BY_ID.get(id) || unknownModelProfile(id)
}

function unknownModelProfile(id) {
  return Object.freeze({
    id,
    label: id,
    family: 'unknown',
    sessionDefaults: UNKNOWN_SESSION_DEFAULTS,
    modelCapabilities: UNKNOWN_MODEL_CAPABILITIES,
    transportCapabilities: UNKNOWN_TRANSPORT_CAPABILITIES,
  })
}

const STEPFUN_PROFILES = Object.freeze([
  Object.freeze({
    id: DEFAULT_STEPFUN_REALTIME_MODEL,
    label: 'StepAudio 3 Realtime Preview',
    family: 'stepaudio',
    sessionDefaults: Object.freeze({
      // Omit voice to use the service default; never inherit a Qwen voice.
      voice: null,
      turnDetection: Object.freeze({ type: 'server_vad' }),
    }),
    modelCapabilities: LEGACY_MODEL_CAPABILITIES,
    transportCapabilities: LEGACY_TRANSPORT_CAPABILITIES,
  }),
])

const GPT_LIVE_PROFILES = Object.freeze([
  Object.freeze({
    id: DEFAULT_GPT_LIVE_REALTIME_MODEL,
    label: 'GPT Realtime 2.1',
    family: 'gpt-live',
    sessionDefaults: Object.freeze({
      voice: null,
      turnDetection: Object.freeze({ type: 'server_vad' }),
    }),
    modelCapabilities: LEGACY_MODEL_CAPABILITIES,
    transportCapabilities: LEGACY_TRANSPORT_CAPABILITIES,
  }),
])

const GOOGLE_LIVE_PROFILES = Object.freeze([
  Object.freeze({
    id: DEFAULT_GOOGLE_LIVE_REALTIME_MODEL,
    label: 'Gemini 3.8 Live',
    family: 'google-live',
    sessionDefaults: Object.freeze({
      voice: null,
      turnDetection: Object.freeze({ type: 'server_vad' }),
    }),
    modelCapabilities: OMNI_MODEL_CAPABILITIES,
    transportCapabilities: OMNI_TRANSPORT_CAPABILITIES,
  }),
])

const DOUBAO_SEEDUPLEX_PROFILES = Object.freeze([
  Object.freeze({
    id: DEFAULT_DOUBAO_SEEDUPLEX_REALTIME_MODEL,
    label: 'Doubao Seeduplex 3.0 Realtime',
    family: 'doubao-seeduplex',
    sessionDefaults: Object.freeze({
      voice: DEFAULT_DOUBAO_SEEDUPLEX_REALTIME_VOICE,
      turnDetection: Object.freeze({ type: 'server_vad' }),
    }),
    modelCapabilities: LEGACY_MODEL_CAPABILITIES,
    transportCapabilities: LEGACY_TRANSPORT_CAPABILITIES,
  }),
])

const MODEL_CATALOGS = Object.freeze({
  dashscope: Object.freeze({
    environment: 'QWEN_AUDIO_REALTIME_MODEL',
    defaultModel: DEFAULT_DASHSCOPE_REALTIME_MODEL,
    profiles: DASHSCOPE_REALTIME_MODEL_PROFILES,
  }),
  stepfun: Object.freeze({
    environment: 'STEPFUN_REALTIME_MODEL',
    defaultModel: DEFAULT_STEPFUN_REALTIME_MODEL,
    profiles: STEPFUN_PROFILES,
  }),
  'gpt-live': Object.freeze({
    environment: 'GPT_LIVE_REALTIME_MODEL',
    defaultModel: DEFAULT_GPT_LIVE_REALTIME_MODEL,
    profiles: GPT_LIVE_PROFILES,
  }),
  'google-live': Object.freeze({
    environment: 'GOOGLE_LIVE_REALTIME_MODEL',
    defaultModel: DEFAULT_GOOGLE_LIVE_REALTIME_MODEL,
    profiles: GOOGLE_LIVE_PROFILES,
  }),
  'doubao-seeduplex': Object.freeze({
    environment: 'DOUBAO_SEEDUPLEX_REALTIME_MODEL',
    defaultModel: DEFAULT_DOUBAO_SEEDUPLEX_REALTIME_MODEL,
    profiles: DOUBAO_SEEDUPLEX_PROFILES,
  }),
})

export function realtimeModelCatalog(provider = 'dashscope') {
  return MODEL_CATALOGS[provider] || null
}

export function resolveRealtimeModelProfile(model, provider = 'dashscope') {
  const catalog = realtimeModelCatalog(provider)
  const id = String(model || catalog?.defaultModel || '').trim()
  return catalog?.profiles.find(profile => profile.id === id) || unknownModelProfile(id)
}
