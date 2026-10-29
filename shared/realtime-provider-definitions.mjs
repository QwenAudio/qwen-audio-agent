// Browser-safe connection metadata. One active connection uses the same fields
// for every provider; model catalogs and wire adapters remain separate concerns.
import { realtimeModelCatalog } from './realtime-model-catalog.mjs'
import { legacyOmniVoiceFromEnvironment, legacyRealtimeEnvironment } from './realtime-legacy-environment.mjs'

export const DEFAULT_REALTIME_PROVIDER = 'dashscope'
export const DEFAULT_DASHSCOPE_REALTIME_URL = 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime'
export const DEFAULT_STEPFUN_REALTIME_URL = 'wss://api.stepfun.com/v1/realtime'
export const DEFAULT_SPEECH_TO_SPEECH_REALTIME_URL = 'ws://127.0.0.1:8765/v1/realtime'
export const DEFAULT_MINICPM_O_REALTIME_URL = 'ws://127.0.0.1:8006/v1/realtime?mode=audio'
export const DEFAULT_GPT_LIVE_REALTIME_URL = 'wss://api.openai.com/v1/realtime'
export const DEFAULT_GPT_LIVE_1_REALTIME_URL = 'wss://api.openai.com/v1/live/sessions'
export const DEFAULT_GOOGLE_LIVE_REALTIME_URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent'
export const DEFAULT_DOUBAO_SEEDUPLEX_REALTIME_URL = 'wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue'

export const REALTIME_SETTING_SLOTS = Object.freeze([
  { slot: 'model', key: 'realtimeModel', label: '模型', type: 'model', environment: ['QWEN_AUDIO_REALTIME_MODEL'] },
  { slot: 'credential', key: 'realtimeApiKey', label: 'API Key', type: 'password', environment: ['QWEN_AUDIO_REALTIME_API_KEY'] },
  { slot: 'endpoint', key: 'realtimeUrl', label: '服务地址', type: 'url', environment: ['QWEN_AUDIO_REALTIME_URL'] },
  { slot: 'voice', key: 'realtimeVoice', label: '音色', type: 'text', environment: ['QWEN_AUDIO_REALTIME_VOICE'] },
].map(field => Object.freeze({ ...field, environment: Object.freeze(field.environment) })))

function defineProvider({ endpoint, helpUrl, ...definition }) {
  const catalog = realtimeModelCatalog(definition.key)
  const required = REALTIME_SETTING_SLOTS.find(field => field.slot === (catalog ? 'credential' : 'endpoint'))
  return Object.freeze({
    ...definition,
    aliases: Object.freeze(definition.aliases || []),
    requiredConfiguration: Object.freeze({ field: required.key, key: required.environment[0] }),
    settings: Object.freeze(REALTIME_SETTING_SLOTS
      .filter(field => catalog || ['credential', 'endpoint'].includes(field.slot))
      .map(field => Object.freeze({
        ...field,
        default: field.slot === 'model' ? catalog.defaultModel : field.slot === 'endpoint' ? endpoint : '',
        ...(field.slot === 'credential' ? { helpUrl, placeholder: catalog ? 'API Key' : '可选，用于 Bearer 认证' } : {}),
      }))),
  })
}

export const REALTIME_PROVIDERS = Object.freeze([
  defineProvider({
    key: 'dashscope', label: 'DashScope', aliases: ['qwen'],
    description: 'Qwen Realtime · DashScope 兼容协议',
    endpoint: DEFAULT_DASHSCOPE_REALTIME_URL,
    helpUrl: 'https://bailian.console.aliyun.com/?tab=model#/api-key',
  }),
  defineProvider({
    key: 'stepfun', label: 'StepFun', description: 'StepAudio 3 Realtime · 阶跃星辰',
    endpoint: DEFAULT_STEPFUN_REALTIME_URL,
  }),
  defineProvider({
    key: 'gpt-live', label: 'GPT-Live', aliases: ['openai', 'gptlive', 'gpt-realtime'],
    description: 'GPT-Live · OpenAI Realtime', endpoint: DEFAULT_GPT_LIVE_REALTIME_URL,
    helpUrl: 'https://platform.openai.com/api-keys',
  }),
  defineProvider({
    key: 'gpt-live-1', label: 'GPT-Live 1', aliases: ['gptlive1', 'openai-live'],
    description: 'GPT-Live 1 · OpenAI Live API（全双工）', endpoint: DEFAULT_GPT_LIVE_1_REALTIME_URL,
    helpUrl: 'https://platform.openai.com/api-keys',
  }),
  defineProvider({
    key: 'google-live', label: 'Google Live', aliases: ['google', 'gemini-live', 'googlelive'],
    description: 'Gemini Live API · Google AI', endpoint: DEFAULT_GOOGLE_LIVE_REALTIME_URL,
    helpUrl: 'https://aistudio.google.com/apikey',
  }),
  defineProvider({
    key: 'doubao-seeduplex', label: 'Doubao Seeduplex', aliases: ['doubao', 'seeduplex', 'volcengine'],
    description: '豆包实时语音模型 3.0（Seeduplex）· 端到端全双工',
    endpoint: DEFAULT_DOUBAO_SEEDUPLEX_REALTIME_URL,
    helpUrl: 'https://console.volcengine.com/speech/app',
  }),
  defineProvider({
    key: 'speech-to-speech', label: 'Speech-to-Speech', aliases: ['s2s'],
    description: 'Speech-to-Speech · Hugging Face · 需单独启动本地服务',
    endpoint: DEFAULT_SPEECH_TO_SPEECH_REALTIME_URL,
  }),
  defineProvider({
    key: 'minicpm-o', label: 'ModelBest', displayLabel: '面壁智能', aliases: ['minicpmo'],
    description: 'MiniCPM-o 4.5 · 面壁智能 · 本地或云端服务', modelLabel: 'MiniCPM-o 4.5',
    endpoint: DEFAULT_MINICPM_O_REALTIME_URL,
  }),
])

export const REALTIME_SETTING_FIELDS = Object.freeze(['realtimeProvider', ...REALTIME_SETTING_SLOTS.map(field => field.key)])
export function realtimeProfileFieldKey(field) { return field.slot }

function settingsProvider(value = DEFAULT_REALTIME_PROVIDER) {
  const key = String(value || DEFAULT_REALTIME_PROVIDER).trim().toLowerCase()
  const provider = REALTIME_PROVIDERS.find(item => item.key === key || item.aliases.includes(key))
  if (!provider) throw new Error('Unsupported realtime provider: ' + key)
  return provider
}

export function realtimeCredentialFromEnvironment(env = {}, providerName = env.QWEN_AUDIO_REALTIME_PROVIDER) {
  return realtimeSettingsFromEnvironment({ ...env, QWEN_AUDIO_REALTIME_PROVIDER: providerName }).realtimeApiKey
}

// Normalize legacy names at the input boundary only. Never rewrite credentials
// belonging to backend Agents, MCP servers or other modules sharing config.env.
export function migrateRealtimeFileEnvironment(input = {}, providerName = input.QWEN_AUDIO_REALTIME_PROVIDER) {
  const provider = settingsProvider(providerName)
  return { ...input, ...legacyRealtimeEnvironment(input, provider.key) }
}

// Sources are merged low-to-high. A provider switch must not carry another
// provider's generic credential, URL, model or voice into the new connection.
export function mergeRealtimeEnvironment(base = {}, overrides = {}) {
  const previous = settingsProvider(base.QWEN_AUDIO_REALTIME_PROVIDER)
  const selected = settingsProvider(overrides.QWEN_AUDIO_REALTIME_PROVIDER ?? previous.key)
  const result = { ...base }
  if (previous.key !== selected.key) {
    for (const field of REALTIME_SETTING_SLOTS) delete result[field.environment[0]]
  }
  Object.assign(result, overrides)
  // A higher-priority legacy Omni voice (including blank) overrides a lower
  // canonical voice only for Omni. An explicit canonical value in the same
  // source still wins. Use the merged model when that source only sets voice.
  if (selected.key === 'dashscope'
    && overrides.QWEN_AUDIO_REALTIME_VOICE === undefined
    && legacyOmniVoiceFromEnvironment(overrides, result.QWEN_AUDIO_REALTIME_MODEL) !== undefined) {
    delete result.QWEN_AUDIO_REALTIME_VOICE
  }
  // Normalize each source before overlaying so a higher-priority legacy value
  // can still override a lower-priority canonical value of the same provider.
  // Keep model-dependent aliases in their original fields until final settings
  // resolution: another source may switch Omni to Audio (and back) afterwards.
  return {
    ...result,
    ...legacyRealtimeEnvironment(result, selected.key, { deferModelVoice: true }),
    ...legacyRealtimeEnvironment(overrides, selected.key, { deferModelVoice: true }),
  }
}

export function realtimeSettingsFromEnvironment(env = {}, drafts = {}) {
  const provider = settingsProvider(env.QWEN_AUDIO_REALTIME_PROVIDER ?? drafts.realtimeProvider)
  const sameProvider = settingsProvider(drafts.realtimeProvider).key === provider.key
  const normalized = migrateRealtimeFileEnvironment(env, provider.key)
  const values = sameProvider ? { ...drafts, realtimeProvider: provider.key } : { realtimeProvider: provider.key }
  for (const field of provider.settings) {
    const raw = normalized[field.environment[0]]
    if (raw !== undefined) values[field.key] = String(raw ?? '').trim()
  }
  return realtimeSettingsValues(values)
}

// A stable allowlisted active snapshot also serves form drafts and dirty checks.
export function realtimeSettingsValues(settings = {}) {
  const provider = settingsProvider(settings.realtimeProvider)
  const values = { realtimeProvider: provider.key, ...Object.fromEntries(REALTIME_SETTING_SLOTS.map(field => [field.key, ''])) }
  for (const field of provider.settings) {
    const value = String(settings[field.key] ?? '').trim()
    values[field.key] = ['model', 'endpoint'].includes(field.slot) ? value || field.default : value
  }
  return values
}

// Provider drafts exist only in the settings form's memory, not in config.env.
export function realtimeSettingsProfileState(settings = {}) {
  const values = realtimeSettingsValues(settings)
  const provider = settingsProvider(values.realtimeProvider)
  return Object.freeze({
    activeProvider: provider.key,
    profiles: Object.freeze({
      [provider.key]: Object.freeze(Object.fromEntries(provider.settings.map(field => [field.slot, values[field.key]]))),
    }),
  })
}

export function realtimeSettingsFromProfileState(state = {}) {
  const provider = settingsProvider(state.activeProvider)
  return realtimeSettingsValues({
    realtimeProvider: provider.key,
    ...Object.fromEntries(provider.settings.map(field => [field.key, state.profiles?.[provider.key]?.[field.slot]])),
  })
}

export function realtimeRuntimeEnvironment(settings = {}) {
  const values = realtimeSettingsValues(settings)
  return {
    QWEN_AUDIO_REALTIME_PROVIDER: values.realtimeProvider,
    ...Object.fromEntries(REALTIME_SETTING_SLOTS.map(field => [field.environment[0], values[field.key]])),
  }
}

export function realtimeSettingsConnection(settings = {}) {
  const values = realtimeSettingsValues(settings)
  return {
    provider: values.realtimeProvider,
    ...Object.fromEntries(REALTIME_SETTING_SLOTS.map(field => [field.slot, values[field.key]])),
  }
}
