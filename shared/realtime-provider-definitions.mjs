// Browser-safe configuration metadata. Protocol implementations and secrets
// stay in the Gateway; clients only consume these public field descriptions.
import {
  DEFAULT_DASHSCOPE_REALTIME_MODEL,
  DEFAULT_GPT_LIVE_REALTIME_MODEL,
  DEFAULT_GOOGLE_LIVE_REALTIME_MODEL,
  DEFAULT_STEPFUN_REALTIME_MODEL,
  resolveDashScopeRealtimeModelProfile,
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
      environment: Object.freeze(field.environment || []),
    }))),
  })
}

export const REALTIME_PROVIDERS = Object.freeze([
  defineProvider({
    key: 'dashscope', label: 'DashScope', aliases: ['qwen'],
    description: 'Qwen Realtime · DashScope 兼容协议',
    requiredConfiguration: { field: 'dashscopeApiKey', key: 'DASHSCOPE_API_KEY' },
    settings: [
      { key: 'dashscopeApiKey',
        slot: 'credential', placeholder: 'sk-…',
        environment: ['DASHSCOPE_API_KEY'],
        helpUrl: 'https://bailian.console.aliyun.com/?tab=model#/api-key' },
      { key: 'realtimeModel', environment: ['QWEN_AUDIO_REALTIME_MODEL'], slot: 'model', default: DEFAULT_DASHSCOPE_REALTIME_MODEL },
      { key: 'audioRealtimeVoice', environment: ['QWEN_AUDIO_REALTIME_VOICE'], slot: 'voice', modelFamily: 'audio' },
      { key: 'omniRealtimeVoice', slot: 'voice', modelFamily: 'omni',
        environment: ['QWEN_OMNI_REALTIME_VOICE'] },
      { key: 'realtimeBaseUrl',
        slot: 'endpoint', default: DEFAULT_DASHSCOPE_REALTIME_URL,
        environment: ['QWEN_AUDIO_REALTIME_BASE_URL', 'QWEN_AUDIO_REALTIME_URL'] },
    ],
  }),
  defineProvider({
    key: 'stepfun', label: 'StepFun',
    description: 'StepAudio 3 Realtime · 阶跃星辰',
    requiredConfiguration: { field: 'stepfunApiKey', key: 'STEPFUN_API_KEY' },
    settings: [
      { key: 'stepfunApiKey', slot: 'credential', placeholder: 'sk-…',
        environment: ['STEPFUN_API_KEY'] },
      { key: 'stepfunRealtimeModel', slot: 'model', default: DEFAULT_STEPFUN_REALTIME_MODEL,
        environment: ['STEPFUN_REALTIME_MODEL'] },
      { key: 'stepfunRealtimeVoice', slot: 'voice', placeholder: '留空使用服务默认音色',
        environment: ['STEPFUN_REALTIME_VOICE'] },
      { key: 'stepfunRealtimeUrl', slot: 'endpoint', default: DEFAULT_STEPFUN_REALTIME_URL,
        environment: ['STEPFUN_REALTIME_URL'] },
    ],
  }),
  defineProvider({
    key: 'gpt-live', label: 'GPT-Live', aliases: ['openai', 'gptlive', 'gpt-realtime'],
    description: 'GPT-Live · OpenAI Realtime',
    requiredConfiguration: { field: 'openaiApiKey', key: 'OPENAI_API_KEY' },
    settings: [
      { key: 'openaiApiKey', environment: ['OPENAI_API_KEY', 'GPT_LIVE_API_KEY'],
        slot: 'credential', placeholder: 'sk-…',
        helpUrl: 'https://platform.openai.com/api-keys' },
      { key: 'gptLiveRealtimeModel', environment: ['GPT_LIVE_REALTIME_MODEL', 'OPENAI_REALTIME_MODEL'],
        slot: 'model', default: DEFAULT_GPT_LIVE_REALTIME_MODEL },
      { key: 'gptLiveRealtimeVoice', environment: ['GPT_LIVE_REALTIME_VOICE', 'OPENAI_REALTIME_VOICE'],
        slot: 'voice', placeholder: '留空使用服务默认音色' },
      { key: 'gptLiveRealtimeUrl', environment: ['GPT_LIVE_REALTIME_URL', 'OPENAI_REALTIME_URL'],
        slot: 'endpoint', default: DEFAULT_GPT_LIVE_REALTIME_URL },
    ],
  }),
  defineProvider({
    key: 'google-live', label: 'Google Live', aliases: ['google', 'gemini-live', 'googlelive'],
    description: 'Gemini Live API · Google AI',
    requiredConfiguration: { field: 'googleApiKey', key: 'GOOGLE_API_KEY' },
    settings: [
      { key: 'googleApiKey', environment: ['GOOGLE_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_LIVE_API_KEY'],
        slot: 'credential', placeholder: 'AIza…',
        helpUrl: 'https://aistudio.google.com/apikey' },
      { key: 'googleLiveRealtimeModel', environment: ['GOOGLE_LIVE_REALTIME_MODEL', 'GEMINI_LIVE_REALTIME_MODEL'],
        slot: 'model', default: DEFAULT_GOOGLE_LIVE_REALTIME_MODEL },
      { key: 'googleLiveRealtimeVoice', environment: ['GOOGLE_LIVE_REALTIME_VOICE', 'GEMINI_LIVE_REALTIME_VOICE'],
        slot: 'voice', placeholder: '留空使用服务默认音色' },
      { key: 'googleLiveRealtimeUrl', environment: ['GOOGLE_LIVE_REALTIME_URL', 'GEMINI_LIVE_REALTIME_URL'],
        slot: 'endpoint', default: DEFAULT_GOOGLE_LIVE_REALTIME_URL },
    ],
  }),
  defineProvider({
    key: 'speech-to-speech', label: 'Speech-to-Speech', aliases: ['s2s'],
    description: 'Speech-to-Speech · Hugging Face · 需单独启动本地服务',
    requiredConfiguration: { field: 'speechToSpeechRealtimeUrl', key: 'SPEECH_TO_SPEECH_REALTIME_URL' },
    settings: [
      { key: 'speechToSpeechRealtimeUrl',
        slot: 'endpoint', activeDefault: DEFAULT_SPEECH_TO_SPEECH_REALTIME_URL,
        environment: ['SPEECH_TO_SPEECH_REALTIME_URL', 'S2S_REALTIME_URL'] },
      { key: 'speechToSpeechAuthToken',
        slot: 'credential', placeholder: '可选，用于 Bearer 认证',
        environment: ['SPEECH_TO_SPEECH_AUTH_TOKEN', 'S2S_API_KEY'] },
    ],
  }),
  defineProvider({
    key: 'minicpm-o', label: 'ModelBest', displayLabel: '面壁智能', aliases: ['minicpmo'],
    description: 'MiniCPM-o 4.5 · 面壁智能 · 本地或云端服务',
    modelLabel: 'MiniCPM-o 4.5',
    requiredConfiguration: { field: 'miniCpmORealtimeUrl', key: 'MINICPM_O_REALTIME_URL' },
    settings: [
      { key: 'miniCpmORealtimeUrl', slot: 'endpoint', activeDefault: DEFAULT_MINICPM_O_REALTIME_URL,
        environment: ['MINICPM_O_REALTIME_URL'] },
      { key: 'miniCpmOAuthToken', slot: 'credential', placeholder: '可选，用于 Bearer 认证',
        environment: ['MINICPM_O_AUTH_TOKEN'] },
    ],
  }),
])

export const REALTIME_SETTING_FIELDS = Object.freeze([
  'realtimeProvider',
  ...REALTIME_PROVIDERS.flatMap(provider => provider.settings.map(field => field.key)),
])

export function realtimeProfileFieldKey(field) {
  return field.modelFamily ? field.modelFamily + 'Voice' : field.slot
}

function settingsProvider(value = DEFAULT_REALTIME_PROVIDER) {
  const key = String(value || DEFAULT_REALTIME_PROVIDER).trim().toLowerCase()
  const provider = REALTIME_PROVIDERS.find(item => item.key === key || item.aliases.includes(key))
  if (!provider) throw new Error('Unsupported realtime provider: ' + key)
  return provider
}

function providerEnvironmentValue(env, field) {
  const key = field.environment.find(name => env[name] !== undefined)
  return key === undefined ? undefined : String(env[key] ?? '').trim()
}

// Only the selected provider supplies its credential; explicit blanks clear it.
export function realtimeCredentialFromEnvironment(env = {}, providerName = env.QWEN_AUDIO_REALTIME_PROVIDER) {
  const provider = settingsProvider(providerName)
  const field = provider.settings.find(item => item.slot === 'credential')
  return field ? providerEnvironmentValue(env, field) ?? '' : ''
}

// Merge sources without repurposing another provider's configuration.
export function mergeRealtimeEnvironment(base = {}, overrides = {}) {
  // Provider-owned fields coexist. A selector change must not erase them.
  const result = { ...base, ...overrides }
  delete result.QWEN_AUDIO_REALTIME_API_KEY
  delete result.QWEN_AUDIO_REALTIME_ENDPOINT
  return result
}

// Provider-owned fields override draft fallbacks, including explicit blanks.
export function realtimeSettingsFromEnvironment(env = {}, drafts = {}) {
  const values = realtimeSettingsValues(drafts)
  const provider = settingsProvider(env.QWEN_AUDIO_REALTIME_PROVIDER ?? values.realtimeProvider)
  values.realtimeProvider = provider.key
  for (const candidate of REALTIME_PROVIDERS) {
    for (const field of candidate.settings) {
      const value = providerEnvironmentValue(env, field)
      if (value !== undefined) values[field.key] = value
    }
  }
  if (!['QWEN_AUDIO_REALTIME_BASE_URL', 'QWEN_AUDIO_REALTIME_URL'].some(key => env[key] !== undefined)
    && String(env.DASHSCOPE_WORKSPACE_ID || '').trim()) {
    values.realtimeBaseUrl = 'wss://' + String(env.DASHSCOPE_WORKSPACE_ID).trim()
      + '.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime'
  }
  for (const field of provider.settings) {
    if (field.slot === 'model') values[field.key] ||= field.default || ''
    if (field.slot === 'endpoint') values[field.key] ||= field.default || field.activeDefault || ''
  }
  return values
}

// A stable, allowlisted snapshot also serves form drafts and dirty detection.
export function realtimeSettingsValues(settings = {}) {
  return {
    realtimeProvider: settingsProvider(settings.realtimeProvider).key,
    ...Object.fromEntries(REALTIME_PROVIDERS.flatMap(provider => provider.settings.map(field => [
      field.key, String(settings[field.key] ?? field.default),
    ]))),
  }
}

export function realtimeSettingsProfileState(settings = {}) {
  const values = realtimeSettingsValues(settings)
  const profiles = Object.fromEntries(REALTIME_PROVIDERS.map(provider => [
    provider.key,
    Object.freeze(Object.fromEntries(provider.settings.map(field => [realtimeProfileFieldKey(field), values[field.key]]))),
  ]))
  return Object.freeze({
    activeProvider: values.realtimeProvider,
    profiles: Object.freeze(profiles),
  })
}

export function realtimeSettingsFromProfileState(state = {}) {
  const defaults = realtimeSettingsValues()
  const activeProvider = REALTIME_PROVIDERS.some(provider => provider.key === state.activeProvider)
    ? state.activeProvider
    : defaults.realtimeProvider
  const values = { realtimeProvider: activeProvider }
  for (const provider of REALTIME_PROVIDERS) {
    const profile = state.profiles?.[provider.key]
    for (const field of provider.settings) {
      values[field.key] = String(profile?.[realtimeProfileFieldKey(field)] ?? defaults[field.key])
    }
  }
  return values
}

export function realtimeRuntimeEnvironment(settings = {}) {
  const values = realtimeSettingsValues(settings)
  const environment = { QWEN_AUDIO_REALTIME_PROVIDER: values.realtimeProvider }
  for (const provider of REALTIME_PROVIDERS) {
    for (const field of provider.settings) {
      environment[field.environment[0]] = values[field.key]
    }
  }
  return environment
}

// Runtime normalization is internal data, never a public override namespace.
export function realtimeSettingsConnection(settings = {}) {
  const values = realtimeSettingsValues(settings)
  const provider = settingsProvider(values.realtimeProvider)
  const modelField = provider.settings.find(field => field.slot === 'model')
  const model = modelField ? values[modelField.key] || modelField.default : ''
  const family = provider.key === 'dashscope' ? resolveDashScopeRealtimeModelProfile(model).family : null
  const connection = { provider: provider.key, model, endpoint: '', credential: '', voice: '' }
  for (const field of provider.settings) {
    if (field.modelFamily && field.modelFamily !== family) continue
    connection[field.slot] = values[field.key]
      || (field.slot === 'endpoint' ? field.default || field.activeDefault || '' : '')
  }
  connection.model = model
  return connection
}

// Import only persisted transitional files, before merging configuration sources.
// Removed variables in the process environment are deliberately NOT supported.
export function migrateRealtimeFileEnvironment(input = {}) {
  const values = { ...input }
  const legacyKey = 'QWEN_AUDIO_REALTIME_API_KEY'
  const legacyEndpoint = 'QWEN_AUDIO_REALTIME_ENDPOINT'
  if (!Object.hasOwn(values, legacyKey) && !Object.hasOwn(values, legacyEndpoint)) return values
  const provider = settingsProvider(values.QWEN_AUDIO_REALTIME_PROVIDER)
  const move = (source, destination, credential = false) => {
    if (!destination || source === destination || !Object.hasOwn(values, source)) return
    if (credential && Object.hasOwn(values, destination)
      && String(values[source]).trim() !== String(values[destination]).trim()) {
      throw new Error('Realtime configuration migration conflict: ' + source + ' and ' + destination
        + ' differ. Keep the intended provider credential in ' + destination + ' and remove ' + source + '.')
    }
    if (!Object.hasOwn(values, destination)) values[destination] = values[source]
    delete values[source]
  }
  const fieldFor = slot => provider.settings.find(field => field.slot === slot)
  move(legacyKey, fieldFor('credential')?.environment[0], true)
  move(legacyEndpoint, fieldFor('endpoint')?.environment[0])
  const modelKey = 'QWEN_AUDIO_REALTIME_MODEL'
  const voiceKey = 'QWEN_AUDIO_REALTIME_VOICE'
  if (provider.key === 'stepfun') {
    // A historical DashScope model alongside StepFun is not a StepFun override.
    if (resolveDashScopeRealtimeModelProfile(values[modelKey] || '').family === 'unknown') {
      move(modelKey, fieldFor('model')?.environment[0])
    }
    move(voiceKey, fieldFor('voice')?.environment[0])
  } else if (provider.key === 'dashscope'
    && resolveDashScopeRealtimeModelProfile(values[modelKey]).family === 'omni') {
    move(voiceKey, 'QWEN_OMNI_REALTIME_VOICE')
  } else if (provider.key !== 'dashscope') {
    if (!values[modelKey]) delete values[modelKey]
    if (!values[voiceKey]) delete values[voiceKey]
  }
  delete values[legacyKey]
  delete values[legacyEndpoint]
  return values
}
