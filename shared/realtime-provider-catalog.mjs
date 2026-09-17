import { createHash } from 'node:crypto'
import {
  DEFAULT_DASHSCOPE_REALTIME_MODEL,
  resolveDashScopeRealtimeModelProfile,
  realtimeModelCatalog,
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
  REALTIME_PROVIDERS,
  realtimeRuntimeEnvironment,
  realtimeSettingsConnection,
  realtimeSettingsFromEnvironment,
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
  if (family !== 'audio' && family !== 'omni') return ''
  const settings = realtimeSettingsFromEnvironment({
    ...env,
    QWEN_AUDIO_REALTIME_PROVIDER: 'dashscope',
    QWEN_AUDIO_REALTIME_MODEL: model,
  })
  return family === 'audio' ? settings.audioRealtimeVoice : settings.omniRealtimeVoice
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

export function assertRealtimeFrontendModel(active) {
  const catalog = realtimeModelCatalog(active.provider)
  if (catalog && !catalog.profiles.some(profile => profile.id === active.model)) {
    throw new Error(`${catalog.environment}=${active.model} 不属于 ${active.provider}；请为当前 Provider 选择正确的模型`)
  }
}

export function resolveRealtimeFrontendConfiguration(env = process.env) {
  const provider = normalizeRealtimeProvider(env.QWEN_AUDIO_REALTIME_PROVIDER)
  const settings = realtimeSettingsFromEnvironment({
    ...env,
    QWEN_AUDIO_REALTIME_PROVIDER: provider,
  })
  const connection = realtimeSettingsConnection(settings)
  const runtime = realtimeRuntimeEnvironment(settings)
  const endpoint = withoutTrailing(connection.endpoint, /[/?]+$/)
  const model = connection.model
  const voice = connection.voice
  const credential = connection.credential
  const required = PROVIDERS[provider].requiredConfiguration
  const configured = Boolean(runtime[required.key])
  const environmentAliases = PROVIDERS[provider].settings
    .find(field => field.key === required.field).environment
    .filter(key => key !== required.key)
  const identity = { provider, endpoint, model, voice, credential }
  const signature = createHash('sha256')
    .update(JSON.stringify(identity))
    .digest('hex')
  const active = Object.freeze({
    provider,
    label: PROVIDERS[provider].label,
    configured,
    endpoint,
    model: model || null,
    voice,
    credentialConfigured: Boolean(credential),
    requiredConfiguration: PROVIDERS[provider].requiredConfiguration,
    signature,
  })

  return {
    active,
    credential,
    missingConfigurationMessage: `缺少 ${PROVIDERS[provider].requiredConfiguration.key}`
      + (environmentAliases.length ? `（也支持 ${environmentAliases.join('、')}）` : '')
      + '。请运行 qwenaudio config 查看配置文件位置。',
  }
}
