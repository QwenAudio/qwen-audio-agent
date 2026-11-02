export const DASHSCOPE_AUDIO_30_REALTIME_MODEL = 'qwen-audio-3.0-realtime-plus'
export const DASHSCOPE_AUDIO_31_REALTIME_MODEL = 'qwen-audio-3.1-realtime-plus'
export const DEFAULT_DASHSCOPE_REALTIME_MODEL = DASHSCOPE_AUDIO_31_REALTIME_MODEL
export const DEFAULT_GPT_LIVE_REALTIME_MODEL = 'gpt-realtime-2.1'
export const DEFAULT_GPT_LIVE_1_REALTIME_MODEL = 'gpt-live-1'
export const DEFAULT_GOOGLE_LIVE_REALTIME_MODEL = 'gemini-3.8-live'
export const DEFAULT_DOUBAO_SEEDUPLEX_REALTIME_MODEL = '1.2.6.1'
export const DEFAULT_DOUBAO_SEEDUPLEX_REALTIME_VOICE = 'zh_female_vv_jupiter_bigtts'
export const DASHSCOPE_AUDIO_FLASH_REALTIME_MODEL = 'qwen-audio-3.0-realtime-flash'
export const DASHSCOPE_OMNI_38_FLASH_REALTIME_MODEL = 'qwen3.8-omni-flash-realtime'
export const DASHSCOPE_OMNI_FLASH_REALTIME_MODEL = 'qwen3.5-omni-flash-realtime'
export const DASHSCOPE_OMNI_PLUS_REALTIME_MODEL = 'qwen3.5-omni-plus-realtime'
export const DEFAULT_STEPFUN_REALTIME_MODEL = 'stepaudio-3-realtime-preview'

function provider(defaultModel, models) {
  return Object.freeze({
    environment: 'QWEN_AUDIO_REALTIME_MODEL',
    defaultModel,
    models: Object.freeze(Object.fromEntries(
      Object.entries(models).map(([id, model]) => [id, Object.freeze(model)]),
    )),
  })
}

// Product order and built-in model choices stay independent of parsing and I/O.
export const REALTIME_MODEL_BUILTINS = Object.freeze({
  dashscope: provider(DEFAULT_DASHSCOPE_REALTIME_MODEL, {
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
      label: 'Qwen Audio 3.1 Realtime Plus', api: 'audio', voice: 'longanqian_v3.1',
      turnDetection: 'smart_turn_v2',
    },
    [DASHSCOPE_AUDIO_30_REALTIME_MODEL]: {
      label: 'Qwen Audio 3.0 Realtime Plus', api: 'audio', voice: 'longanqian',
    },
    [DASHSCOPE_AUDIO_FLASH_REALTIME_MODEL]: {
      label: 'Qwen Audio 3.0 Realtime Flash', api: 'audio', voice: 'longanqian',
    },
  }),
  stepfun: provider(DEFAULT_STEPFUN_REALTIME_MODEL, {
    [DEFAULT_STEPFUN_REALTIME_MODEL]: {
      label: 'StepAudio 3 Realtime Preview', api: 'stepfun', voice: null,
    },
  }),
  'gpt-live': provider(DEFAULT_GPT_LIVE_REALTIME_MODEL, {
    [DEFAULT_GPT_LIVE_REALTIME_MODEL]: {
      label: 'GPT Realtime 2.1', api: 'gpt-live', voice: null,
    },
  }),
  'gpt-live-1': provider(DEFAULT_GPT_LIVE_1_REALTIME_MODEL, {
    [DEFAULT_GPT_LIVE_1_REALTIME_MODEL]: {
      label: 'GPT-Live 1', api: 'gpt-live-1', voice: null,
    },
  }),
  'google-live': provider(DEFAULT_GOOGLE_LIVE_REALTIME_MODEL, {
    [DEFAULT_GOOGLE_LIVE_REALTIME_MODEL]: {
      label: 'Gemini 3.8 Live', api: 'google-live', voice: null,
    },
  }),
  'doubao-seeduplex': provider(DEFAULT_DOUBAO_SEEDUPLEX_REALTIME_MODEL, {
    [DEFAULT_DOUBAO_SEEDUPLEX_REALTIME_MODEL]: {
      label: 'Doubao Seeduplex 3.0 Realtime',
      api: 'doubao-seeduplex',
      voice: DEFAULT_DOUBAO_SEEDUPLEX_REALTIME_VOICE,
    },
  }),
})

export const DEFAULT_DASHSCOPE_REALTIME_VOICE = REALTIME_MODEL_BUILTINS.dashscope
  .models[DEFAULT_DASHSCOPE_REALTIME_MODEL].voice
