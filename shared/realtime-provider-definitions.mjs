// Browser-safe configuration metadata. Protocol implementations and secrets
// stay in the Gateway; clients only consume these public field descriptions.
import {
  DEFAULT_DASHSCOPE_REALTIME_MODEL,
  DEFAULT_GPT_LIVE_REALTIME_MODEL,
  DEFAULT_GOOGLE_LIVE_REALTIME_MODEL,
  DEFAULT_STEPFUN_REALTIME_MODEL,
} from './realtime-model-catalog.mjs'

export const DEFAULT_REALTIME_PROVIDER = 'dashscope'
export const DEFAULT_DASHSCOPE_REALTIME_URL = 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime'
export const DEFAULT_STEPFUN_REALTIME_URL = 'wss://api.stepfun.com/v1/realtime'
export const DEFAULT_SPEECH_TO_SPEECH_REALTIME_URL = 'ws://127.0.0.1:8765/v1/realtime'
export const DEFAULT_MINICPM_O_REALTIME_URL = 'ws://127.0.0.1:8006/v1/realtime?mode=audio'
export const DEFAULT_GPT_LIVE_REALTIME_URL = 'wss://api.openai.com/v1/realtime'
export const DEFAULT_GOOGLE_LIVE_REALTIME_URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent'

// The desktop always presents these four slots, in this order. Providers
// only bind the slots they can configure; absent bindings render disabled.
export const REALTIME_SETTING_SLOTS = Object.freeze([
  Object.freeze({ slot: 'endpoint', label: '服务地址', type: 'url' }),
  Object.freeze({ slot: 'credential', label: 'API Key', type: 'password' }),
  Object.freeze({ slot: 'model', label: '模型', type: 'model' }),
  Object.freeze({ slot: 'voice', label: '音色', type: 'text' }),
])

function defineProvider(definition) {
  return Object.freeze({
    ...definition,
    aliases: Object.freeze(definition.aliases || []),
    requiredConfiguration: Object.freeze(definition.requiredConfiguration),
    settings: Object.freeze(definition.settings.map(field => Object.freeze({
      ...REALTIME_SETTING_SLOTS.find(slot => slot.slot === field.slot),
      default: '', ...field,
    }))),
  })
}

export const REALTIME_PROVIDERS = Object.freeze([
  defineProvider({
    key: 'dashscope', label: 'DashScope', aliases: ['qwen'],
    description: 'Qwen Realtime · DashScope 兼容协议',
    requiredConfiguration: { field: 'dashscopeApiKey', key: 'DASHSCOPE_API_KEY' },
    settings: [
      { key: 'dashscopeApiKey', env: 'DASHSCOPE_API_KEY', aliases: ['QWEN_AUDIO_REALTIME_API_KEY'],
        slot: 'credential', placeholder: 'sk-…',
        helpUrl: 'https://bailian.console.aliyun.com/?tab=model#/api-key' },
      { key: 'realtimeModel', env: 'QWEN_AUDIO_REALTIME_MODEL', slot: 'model', default: DEFAULT_DASHSCOPE_REALTIME_MODEL },
      { key: 'audioRealtimeVoice', env: 'QWEN_AUDIO_REALTIME_VOICE', slot: 'voice', modelFamily: 'audio' },
      { key: 'omniRealtimeVoice', env: 'QWEN_OMNI_REALTIME_VOICE', slot: 'voice', modelFamily: 'omni' },
      { key: 'realtimeBaseUrl', env: 'QWEN_AUDIO_REALTIME_BASE_URL', aliases: ['QWEN_AUDIO_REALTIME_URL'],
        slot: 'endpoint', default: DEFAULT_DASHSCOPE_REALTIME_URL,
        fallback: env => env.DASHSCOPE_WORKSPACE_ID
          ? `wss://${env.DASHSCOPE_WORKSPACE_ID}.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime` : '' },
    ],
  }),
  defineProvider({
    key: 'stepfun', label: 'StepFun',
    description: 'StepAudio 3 Realtime · 阶跃星辰',
    requiredConfiguration: { field: 'stepfunApiKey', key: 'STEPFUN_API_KEY' },
    settings: [
      { key: 'stepfunApiKey', env: 'STEPFUN_API_KEY', slot: 'credential', placeholder: 'sk-…' },
      { key: 'stepfunRealtimeModel', env: 'STEPFUN_REALTIME_MODEL', slot: 'model', default: DEFAULT_STEPFUN_REALTIME_MODEL },
      { key: 'stepfunRealtimeVoice', env: 'STEPFUN_REALTIME_VOICE', slot: 'voice', placeholder: '留空使用服务默认音色' },
      { key: 'stepfunRealtimeUrl', env: 'STEPFUN_REALTIME_URL', slot: 'endpoint', default: DEFAULT_STEPFUN_REALTIME_URL },
    ],
  }),
  defineProvider({
    key: 'gpt-live', label: 'GPT-Live', aliases: ['openai', 'gptlive', 'gpt-realtime'],
    description: 'GPT-Live · OpenAI Realtime',
    requiredConfiguration: { field: 'openaiApiKey', key: 'OPENAI_API_KEY' },
    settings: [
      { key: 'openaiApiKey', env: 'OPENAI_API_KEY', aliases: ['GPT_LIVE_API_KEY'],
        slot: 'credential', placeholder: 'sk-…',
        helpUrl: 'https://platform.openai.com/api-keys' },
      { key: 'gptLiveRealtimeModel', env: 'GPT_LIVE_REALTIME_MODEL', aliases: ['OPENAI_REALTIME_MODEL'],
        slot: 'model', default: DEFAULT_GPT_LIVE_REALTIME_MODEL },
      { key: 'gptLiveRealtimeVoice', env: 'GPT_LIVE_REALTIME_VOICE', aliases: ['OPENAI_REALTIME_VOICE'],
        slot: 'voice', placeholder: '留空使用服务默认音色' },
      { key: 'gptLiveRealtimeUrl', env: 'GPT_LIVE_REALTIME_URL', aliases: ['OPENAI_REALTIME_URL'],
        slot: 'endpoint', default: DEFAULT_GPT_LIVE_REALTIME_URL },
    ],
  }),
  defineProvider({
    key: 'google-live', label: 'Google Live', aliases: ['google', 'gemini-live', 'googlelive'],
    description: 'Gemini Live API · Google AI',
    requiredConfiguration: { field: 'googleApiKey', key: 'GOOGLE_API_KEY' },
    settings: [
      { key: 'googleApiKey', env: 'GOOGLE_API_KEY', aliases: ['GEMINI_API_KEY', 'GOOGLE_LIVE_API_KEY'],
        slot: 'credential', placeholder: 'AIza…',
        helpUrl: 'https://aistudio.google.com/apikey' },
      { key: 'googleLiveRealtimeModel', env: 'GOOGLE_LIVE_REALTIME_MODEL', aliases: ['GEMINI_LIVE_REALTIME_MODEL'],
        slot: 'model', default: DEFAULT_GOOGLE_LIVE_REALTIME_MODEL },
      { key: 'googleLiveRealtimeVoice', env: 'GOOGLE_LIVE_REALTIME_VOICE', aliases: ['GEMINI_LIVE_REALTIME_VOICE'],
        slot: 'voice', placeholder: '留空使用服务默认音色' },
      { key: 'googleLiveRealtimeUrl', env: 'GOOGLE_LIVE_REALTIME_URL', aliases: ['GEMINI_LIVE_REALTIME_URL'],
        slot: 'endpoint', default: DEFAULT_GOOGLE_LIVE_REALTIME_URL },
    ],
  }),
  defineProvider({
    key: 'speech-to-speech', label: 'Speech-to-Speech', aliases: ['s2s'],
    description: 'Speech-to-Speech · Hugging Face · 需单独启动本地服务',
    requiredConfiguration: { field: 'speechToSpeechRealtimeUrl', key: 'SPEECH_TO_SPEECH_REALTIME_URL' },
    settings: [
      { key: 'speechToSpeechRealtimeUrl', env: 'SPEECH_TO_SPEECH_REALTIME_URL', aliases: ['S2S_REALTIME_URL'],
        slot: 'endpoint', activeDefault: DEFAULT_SPEECH_TO_SPEECH_REALTIME_URL },
      { key: 'speechToSpeechAuthToken', env: 'SPEECH_TO_SPEECH_AUTH_TOKEN', aliases: ['S2S_API_KEY'],
        slot: 'credential', placeholder: '可选，用于 Bearer 认证' },
    ],
  }),
  defineProvider({
    key: 'minicpm-o', label: 'ModelBest', displayLabel: '面壁智能', aliases: ['minicpmo'],
    description: 'MiniCPM-o 4.5 · 面壁智能 · 本地或云端服务',
    modelLabel: 'MiniCPM-o 4.5',
    requiredConfiguration: { field: 'miniCpmORealtimeUrl', key: 'MINICPM_O_REALTIME_URL' },
    settings: [
      { key: 'miniCpmORealtimeUrl', env: 'MINICPM_O_REALTIME_URL', slot: 'endpoint', activeDefault: DEFAULT_MINICPM_O_REALTIME_URL },
      { key: 'miniCpmOAuthToken', env: 'MINICPM_O_AUTH_TOKEN', slot: 'credential', placeholder: '可选，用于 Bearer 认证' },
    ],
  }),
])

export const REALTIME_SETTING_KEYS = Object.freeze({
  realtimeProvider: 'QWEN_AUDIO_REALTIME_PROVIDER',
  ...Object.fromEntries(REALTIME_PROVIDERS.flatMap(provider => provider.settings.map(field => [field.key, field.env]))),
})

// A stable, allowlisted snapshot also serves form drafts and dirty detection.
export function realtimeSettingsValues(settings = {}) {
  return {
    realtimeProvider: settings.realtimeProvider || DEFAULT_REALTIME_PROVIDER,
    ...Object.fromEntries(REALTIME_PROVIDERS.flatMap(provider => provider.settings.map(field => [
      field.key, String(settings[field.key] ?? field.default),
    ]))),
  }
}
