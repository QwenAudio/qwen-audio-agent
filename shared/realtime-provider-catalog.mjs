import { createHash } from 'node:crypto'
import {
  DEFAULT_DASHSCOPE_REALTIME_MODEL,
  DEFAULT_GPT_LIVE_REALTIME_MODEL,
  DEFAULT_GOOGLE_LIVE_REALTIME_MODEL,
  DEFAULT_STEPFUN_REALTIME_MODEL,
  resolveDashScopeRealtimeModelProfile,
} from './realtime-model-catalog.mjs'

export {
  DASHSCOPE_AUDIO_FLASH_REALTIME_MODEL,
  DASHSCOPE_OMNI_FLASH_REALTIME_MODEL,
  DASHSCOPE_OMNI_PLUS_REALTIME_MODEL,
  DASHSCOPE_REALTIME_MODEL_PROFILES,
  DEFAULT_DASHSCOPE_REALTIME_MODEL,
  DEFAULT_DASHSCOPE_REALTIME_VOICE,
  DEFAULT_GPT_LIVE_REALTIME_MODEL,
  DEFAULT_GOOGLE_LIVE_REALTIME_MODEL,
  DEFAULT_STEPFUN_REALTIME_MODEL,
  realtimeModelCatalog,
  resolveRealtimeModelProfile,
  listDashScopeRealtimeModelProfiles,
  resolveDashScopeRealtimeModelProfile,
} from './realtime-model-catalog.mjs'

import {
  DEFAULT_REALTIME_PROVIDER,
  DEFAULT_DASHSCOPE_REALTIME_URL,
  DEFAULT_GPT_LIVE_REALTIME_URL,
  DEFAULT_GOOGLE_LIVE_REALTIME_URL,
  DEFAULT_STEPFUN_REALTIME_URL,
  DEFAULT_SPEECH_TO_SPEECH_REALTIME_URL,
  DEFAULT_MINICPM_O_REALTIME_URL,
  REALTIME_PROVIDERS,
} from './realtime-provider-definitions.mjs'
export {
  DEFAULT_REALTIME_PROVIDER,
  DEFAULT_DASHSCOPE_REALTIME_URL,
  DEFAULT_GPT_LIVE_REALTIME_URL,
  DEFAULT_GOOGLE_LIVE_REALTIME_URL,
  DEFAULT_STEPFUN_REALTIME_URL,
  DEFAULT_SPEECH_TO_SPEECH_REALTIME_URL,
  DEFAULT_MINICPM_O_REALTIME_URL,
} from './realtime-provider-definitions.mjs'

const PROVIDERS = Object.fromEntries(REALTIME_PROVIDERS.map(provider => [provider.key, provider]))

const PROVIDER_ALIASES = new Map()
for (const provider of Object.values(PROVIDERS)) {
  PROVIDER_ALIASES.set(provider.key, provider.key)
  for (const alias of provider.aliases) {
    PROVIDER_ALIASES.set(alias, provider.key)
  }
}

function clean(value) {
  return String(value || '').trim()
}

function withoutTrailing(value, pattern) {
  return clean(value).replace(pattern, '')
}

export function resolveDashScopeRealtimeVoiceOverride(
  model = DEFAULT_DASHSCOPE_REALTIME_MODEL,
  env = process.env,
) {
  const family = resolveDashScopeRealtimeModelProfile(model).family
  if (family === 'audio') return clean(env.QWEN_AUDIO_REALTIME_VOICE)
  if (family === 'omni') return clean(env.QWEN_OMNI_REALTIME_VOICE)
  return ''
}

export function realtimeProviderNames() {
  return Object.keys(PROVIDERS)
}

export function normalizeRealtimeProvider(value, {
  fallback = DEFAULT_REALTIME_PROVIDER,
} = {}) {
  const requested = clean(value || fallback).toLowerCase()
  const provider = PROVIDER_ALIASES.get(requested)
  if (!provider) {
    throw new Error(
      `不支持的 Realtime 前台：${requested || value}`
      + `（可选 ${realtimeProviderNames().join('、')}）`,
    )
  }
  return provider
}

export function realtimeProviderDefinition(value) {
  const key = normalizeRealtimeProvider(value)
  return PROVIDERS[key]
}

export function resolveRealtimeFrontendConfiguration(env = process.env) {
  const provider = normalizeRealtimeProvider(env.QWEN_AUDIO_REALTIME_PROVIDER)
  const dashscopeApiKey = clean(
    env.QWEN_AUDIO_REALTIME_API_KEY || env.DASHSCOPE_API_KEY,
  )
  const dashscopeRealtimeUrl = withoutTrailing(
    env.QWEN_AUDIO_REALTIME_BASE_URL
    || env.QWEN_AUDIO_REALTIME_URL
    || (
      env.DASHSCOPE_WORKSPACE_ID
        ? `wss://${env.DASHSCOPE_WORKSPACE_ID}.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime`
        : DEFAULT_DASHSCOPE_REALTIME_URL
    ),
    /\?+$/,
  )
  const dashscopeModel = clean(env.QWEN_AUDIO_REALTIME_MODEL)
    || DEFAULT_DASHSCOPE_REALTIME_MODEL
  const dashscopeVoice = resolveDashScopeRealtimeVoiceOverride(
    dashscopeModel,
    env,
  )
  const stepfunApiKey = clean(env.STEPFUN_API_KEY)
  const stepfunRealtimeUrl = withoutTrailing(
    env.STEPFUN_REALTIME_URL || DEFAULT_STEPFUN_REALTIME_URL,
    /\?+$/,
  )
  const stepfunModel = clean(env.STEPFUN_REALTIME_MODEL) || DEFAULT_STEPFUN_REALTIME_MODEL
  const stepfunVoice = clean(env.STEPFUN_REALTIME_VOICE)
  const openaiApiKey = clean(env.OPENAI_API_KEY || env.GPT_LIVE_API_KEY)
  const gptLiveRealtimeUrl = withoutTrailing(
    env.GPT_LIVE_REALTIME_URL
    || env.OPENAI_REALTIME_URL
    || DEFAULT_GPT_LIVE_REALTIME_URL,
    /\?+$/,
  )
  const gptLiveModel = clean(
    env.GPT_LIVE_REALTIME_MODEL || env.OPENAI_REALTIME_MODEL,
  ) || DEFAULT_GPT_LIVE_REALTIME_MODEL
  const gptLiveVoice = clean(
    env.GPT_LIVE_REALTIME_VOICE || env.OPENAI_REALTIME_VOICE,
  )
  const googleApiKey = clean(
    env.GOOGLE_API_KEY || env.GEMINI_API_KEY || env.GOOGLE_LIVE_API_KEY,
  )
  const googleLiveRealtimeUrl = withoutTrailing(
    env.GOOGLE_LIVE_REALTIME_URL
    || env.GEMINI_LIVE_REALTIME_URL
    || DEFAULT_GOOGLE_LIVE_REALTIME_URL,
    /\?+$/,
  )
  const googleLiveModel = clean(
    env.GOOGLE_LIVE_REALTIME_MODEL || env.GEMINI_LIVE_REALTIME_MODEL,
  ) || DEFAULT_GOOGLE_LIVE_REALTIME_MODEL
  const googleLiveVoice = clean(
    env.GOOGLE_LIVE_REALTIME_VOICE || env.GEMINI_LIVE_REALTIME_VOICE,
  )
  const speechToSpeechRealtimeUrl = withoutTrailing(
    env.SPEECH_TO_SPEECH_REALTIME_URL
    || env.S2S_REALTIME_URL
    || DEFAULT_SPEECH_TO_SPEECH_REALTIME_URL,
    /\/+$/,
  )
  const speechToSpeechAuthToken = clean(
    env.SPEECH_TO_SPEECH_AUTH_TOKEN || env.S2S_API_KEY,
  )
  const speechToSpeechConfigured = Boolean(
    clean(env.SPEECH_TO_SPEECH_REALTIME_URL)
    || clean(env.S2S_REALTIME_URL)
    || provider === 'speech-to-speech'
  )
  const miniCpmORealtimeUrl = withoutTrailing(
    env.MINICPM_O_REALTIME_URL || DEFAULT_MINICPM_O_REALTIME_URL,
    /\/+$/,
  )
  const miniCpmOAuthToken = clean(env.MINICPM_O_AUTH_TOKEN)
  const miniCpmOConfigured = Boolean(
    clean(env.MINICPM_O_REALTIME_URL) || provider === 'minicpm-o'
  )
  const configurations = {
    dashscope: {
      configured: Boolean(dashscopeApiKey),
      identity: {
        endpoint: dashscopeRealtimeUrl,
        model: dashscopeModel,
        voice: dashscopeVoice,
        credential: dashscopeApiKey,
      },
    },
    stepfun: {
      configured: Boolean(stepfunApiKey),
      identity: {
        endpoint: stepfunRealtimeUrl,
        model: stepfunModel,
        voice: stepfunVoice,
        credential: stepfunApiKey,
      },
    },
    'gpt-live': {
      configured: Boolean(openaiApiKey),
      identity: {
        endpoint: gptLiveRealtimeUrl,
        model: gptLiveModel,
        voice: gptLiveVoice,
        credential: openaiApiKey,
      },
    },
    'google-live': {
      configured: Boolean(googleApiKey),
      identity: {
        endpoint: googleLiveRealtimeUrl,
        model: googleLiveModel,
        voice: googleLiveVoice,
        credential: googleApiKey,
      },
    },
    'speech-to-speech': {
      configured: speechToSpeechConfigured,
      identity: { endpoint: speechToSpeechRealtimeUrl, credential: speechToSpeechAuthToken },
    },
    'minicpm-o': {
      configured: miniCpmOConfigured,
      identity: { endpoint: miniCpmORealtimeUrl, credential: miniCpmOAuthToken },
    },
  }
  const { configured, identity: activeIdentity } = configurations[provider]
  const identity = { provider, ...activeIdentity }
  const signature = createHash('sha256')
    .update(JSON.stringify(identity))
    .digest('hex')

  return {
    provider,
    label: PROVIDERS[provider].label,
    configured,
    signature,
    dashscopeApiKey,
    dashscopeRealtimeUrl,
    dashscopeModel,
    dashscopeVoice,
    stepfunApiKey,
    stepfunRealtimeUrl,
    stepfunModel,
    stepfunVoice,
    openaiApiKey,
    gptLiveRealtimeUrl,
    gptLiveModel,
    gptLiveVoice,
    googleApiKey,
    googleLiveRealtimeUrl,
    googleLiveModel,
    googleLiveVoice,
    model: activeIdentity.model || null,
    endpoint: activeIdentity.endpoint,
    speechToSpeechRealtimeUrl,
    speechToSpeechAuthToken,
    speechToSpeechConfigured,
    miniCpmORealtimeUrl,
    miniCpmOAuthToken,
    miniCpmOConfigured,
    requiredConfiguration: PROVIDERS[provider].requiredConfiguration,
    missingConfigurationMessage: `缺少 ${PROVIDERS[provider].requiredConfiguration.key}。请运行 qwenaudio config 查看配置文件位置。`,
  }
}
