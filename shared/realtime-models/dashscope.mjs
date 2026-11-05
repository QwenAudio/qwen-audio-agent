import { apiProfile, defineProviderModels } from './profile.mjs'

export const DASHSCOPE_AUDIO_30_REALTIME_MODEL = 'qwen-audio-3.0-realtime-plus'
export const DASHSCOPE_AUDIO_31_REALTIME_MODEL = 'qwen-audio-3.1-realtime-plus'
export const DASHSCOPE_AUDIO_31_FLASH_REALTIME_MODEL = 'qwen-audio-3.1-realtime-flash'
export const DEFAULT_DASHSCOPE_REALTIME_MODEL = DASHSCOPE_AUDIO_31_REALTIME_MODEL
export const DEFAULT_DASHSCOPE_REALTIME_VOICE = 'longanqian_v3.1'
export const DASHSCOPE_AUDIO_FLASH_REALTIME_MODEL = 'qwen-audio-3.0-realtime-flash'
export const DASHSCOPE_OMNI_38_FLASH_REALTIME_MODEL = 'qwen3.8-omni-flash-realtime'
export const DASHSCOPE_OMNI_FLASH_REALTIME_MODEL = 'qwen3.5-omni-flash-realtime'
export const DASHSCOPE_OMNI_PLUS_REALTIME_MODEL = 'qwen3.5-omni-plus-realtime'

export const dashscopeModels = defineProviderModels(DEFAULT_DASHSCOPE_REALTIME_MODEL, {
  audio: apiProfile('audio', 'smart_turn'),
  omni: apiProfile('omni', 'semantic_vad', {
    visual: true,
    sessionConstraints: { unsupportedVoices: Object.freeze(['Cherry']) },
  }),
  'omni-v2': apiProfile('omni', 'semantic_vad', {
    visual: true, sessionConstraints: { workspaceEndpoint: true },
  }),
}, {
  [DASHSCOPE_OMNI_38_FLASH_REALTIME_MODEL]: {
    label: 'Qwen3.8 Omni Flash Realtime', api: 'omni-v2', voice: 'Tina',
  },
  [DASHSCOPE_OMNI_FLASH_REALTIME_MODEL]: {
    label: 'Qwen3.5 Omni Flash Realtime', api: 'omni', voice: 'Ethan',
  },
  [DASHSCOPE_OMNI_PLUS_REALTIME_MODEL]: {
    label: 'Qwen3.5 Omni Plus Realtime', api: 'omni', voice: 'Ethan',
  },
  [DASHSCOPE_AUDIO_31_REALTIME_MODEL]: {
    label: 'Qwen Audio 3.1 Realtime Plus', api: 'audio', voice: DEFAULT_DASHSCOPE_REALTIME_VOICE,
    turnDetection: 'smart_turn_v2',
  },
  [DASHSCOPE_AUDIO_31_FLASH_REALTIME_MODEL]: {
    label: 'Qwen Audio 3.1 Realtime Flash', api: 'audio', voice: DEFAULT_DASHSCOPE_REALTIME_VOICE,
    turnDetection: 'smart_turn_v2',
  },
  [DASHSCOPE_AUDIO_30_REALTIME_MODEL]: {
    label: 'Qwen Audio 3.0 Realtime Plus', api: 'audio', voice: 'longanqian',
  },
  [DASHSCOPE_AUDIO_FLASH_REALTIME_MODEL]: {
    label: 'Qwen Audio 3.0 Realtime Flash', api: 'audio', voice: 'longanqian',
  },
})
