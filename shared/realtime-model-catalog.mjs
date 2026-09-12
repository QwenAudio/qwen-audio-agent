export const DEFAULT_DASHSCOPE_REALTIME_MODEL = 'qwen-audio-3.0-realtime-plus'
export const DEFAULT_DASHSCOPE_REALTIME_VOICE = 'longanqian'

export const DASHSCOPE_AUDIO_FLASH_REALTIME_MODEL = 'qwen-audio-3.0-realtime-flash'
export const DASHSCOPE_OMNI_FLASH_REALTIME_MODEL = 'qwen3.5-omni-flash-realtime'
export const DASHSCOPE_OMNI_PLUS_REALTIME_MODEL = 'qwen3.5-omni-plus-realtime'

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
const OMNI_REALTIME_VOICE_CAPABILITIES = Object.freeze({
  supportedVoices: Object.freeze([
    'Tina',
    'Cindy',
    'Liora Mira',
    'Sunnybobi',
    'Raymond',
    'Ethan',
    'Theo Calm',
    'Serena',
  ]),
})

export const DASHSCOPE_REALTIME_MODEL_PROFILES = Object.freeze([
  Object.freeze({
    id: DASHSCOPE_OMNI_FLASH_REALTIME_MODEL,
    label: 'Qwen3.5 Omni Flash Realtime',
    family: 'omni',
    sessionDefaults: OMNI_SESSION_DEFAULTS,
    voiceCapabilities: OMNI_REALTIME_VOICE_CAPABILITIES,
    modelCapabilities: OMNI_MODEL_CAPABILITIES,
    transportCapabilities: OMNI_TRANSPORT_CAPABILITIES,
  }),
  Object.freeze({
    id: DASHSCOPE_OMNI_PLUS_REALTIME_MODEL,
    label: 'Qwen3.5 Omni Plus Realtime',
    family: 'omni',
    sessionDefaults: OMNI_SESSION_DEFAULTS,
    voiceCapabilities: OMNI_REALTIME_VOICE_CAPABILITIES,
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
  return PROFILES_BY_ID.get(id) || Object.freeze({
    id,
    label: id,
    family: 'unknown',
    sessionDefaults: UNKNOWN_SESSION_DEFAULTS,
    modelCapabilities: UNKNOWN_MODEL_CAPABILITIES,
    transportCapabilities: UNKNOWN_TRANSPORT_CAPABILITIES,
  })
}
