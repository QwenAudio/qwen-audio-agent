import { parseEnv } from 'node:util'
import {
  backendDefinition,
  normalizeBackendProtocol,
} from '../../shared/backend-catalog.mjs'
import {
  DEFAULT_DASHSCOPE_REALTIME_MODEL,
  DEFAULT_REALTIME_PROVIDER,
  DEFAULT_SPEECH_TO_SPEECH_REALTIME_URL,
  normalizeRealtimeProvider,
} from '../../shared/realtime-provider-catalog.mjs'

const DEFAULTS = {
  gatewayUrl: 'http://127.0.0.1:3101',
  orbStyle: 'fluid',
  dashscopeApiKey: '',
  realtimeProvider: DEFAULT_REALTIME_PROVIDER,
  agentProtocol: 'none',
  realtimeModel: DEFAULT_DASHSCOPE_REALTIME_MODEL,
  speechToSpeechRealtimeUrl: '',
  speechToSpeechAuthToken: '',
  backendModel: '',
}

const SETTING_KEYS = {
  gatewayUrl: 'QWEN_AUDIO_AGENT_URL',
  orbStyle: 'QWEN_AUDIO_ORB_STYLE',
  dashscopeApiKey: 'DASHSCOPE_API_KEY',
  realtimeProvider: 'QWEN_AUDIO_REALTIME_PROVIDER',
  agentProtocol: 'AGENT_PROTOCOL',
  realtimeModel: 'QWEN_AUDIO_REALTIME_MODEL',
  speechToSpeechRealtimeUrl: 'SPEECH_TO_SPEECH_REALTIME_URL',
  speechToSpeechAuthToken: 'SPEECH_TO_SPEECH_AUTH_TOKEN',
  backendModel: 'QWEN_AUDIO_AGENT_BACKEND_MODEL',
}

function configured(values, key, fallback) {
  return Object.hasOwn(values, key) ? values[key] : fallback
}

function cleanUrl(value, fallback, label = '地址') {
  const text = String(value || fallback).trim()
  const url = new URL(text)
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`${label}只支持 HTTP 或 HTTPS`)
  }
  return url.origin
}

function cleanRealtimeUrl(value, fallback) {
  const text = String(value || fallback).trim()
  const url = new URL(text)
  if (!['ws:', 'wss:'].includes(url.protocol)) {
    throw new Error('Speech-to-Speech 服务地址只支持 WS 或 WSS')
  }
  return text.replace(/\/+$/, '')
}

function cleanAgentProtocol(value) {
  const protocol = normalizeBackendProtocol(value)
  if (!protocol) return DEFAULTS.agentProtocol
  if (!backendDefinition(protocol)) {
    throw new Error(`不支持的后台 Agent：${protocol}`)
  }
  return protocol
}

function encoded(value) {
  const text = String(value ?? '')
  if (/^[A-Za-z0-9_./:@+-]*$/.test(text)) return text
  return `"${text.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

export function parseSettings(content = '', fallback = {}) {
  const values = parseEnv(content)
  const configuredApiKey = configured(
    values,
    'DASHSCOPE_API_KEY',
    configured(
      values,
      'QWEN_AUDIO_REALTIME_API_KEY',
      fallback.DASHSCOPE_API_KEY
      || fallback.QWEN_AUDIO_REALTIME_API_KEY
      || DEFAULTS.dashscopeApiKey,
    ),
  )
  const configuredOrbStyle = configured(
    values,
    'QWEN_AUDIO_ORB_STYLE',
    fallback.QWEN_AUDIO_ORB_STYLE || '',
  )
  const configuredS2sUrl = configured(
    values,
    'SPEECH_TO_SPEECH_REALTIME_URL',
    configured(
      values,
      'S2S_REALTIME_URL',
      fallback.SPEECH_TO_SPEECH_REALTIME_URL
      || fallback.S2S_REALTIME_URL
      || DEFAULTS.speechToSpeechRealtimeUrl,
    ),
  )
  const configuredS2sToken = configured(
    values,
    'SPEECH_TO_SPEECH_AUTH_TOKEN',
    configured(
      values,
      'S2S_API_KEY',
      fallback.SPEECH_TO_SPEECH_AUTH_TOKEN
      || fallback.S2S_API_KEY
      || DEFAULTS.speechToSpeechAuthToken,
    ),
  )
  return {
    gatewayUrl: configured(
      values,
      'QWEN_AUDIO_AGENT_URL',
      fallback.QWEN_AUDIO_AGENT_URL || DEFAULTS.gatewayUrl,
    ) || DEFAULTS.gatewayUrl,
    orbStyle: ['fluid', 'goo'].includes(
      String(configuredOrbStyle).toLowerCase(),
    ) ? String(configuredOrbStyle).toLowerCase() : DEFAULTS.orbStyle,
    dashscopeApiKey: String(configuredApiKey || '').trim(),
    realtimeProvider: normalizeRealtimeProvider(configured(
      values,
      'QWEN_AUDIO_REALTIME_PROVIDER',
      fallback.QWEN_AUDIO_REALTIME_PROVIDER || DEFAULTS.realtimeProvider,
    )),
    agentProtocol: cleanAgentProtocol(configured(
      values,
      'AGENT_PROTOCOL',
      fallback.AGENT_PROTOCOL || DEFAULTS.agentProtocol,
    )),
    realtimeModel: String(configured(
      values,
      'QWEN_AUDIO_REALTIME_MODEL',
      fallback.QWEN_AUDIO_REALTIME_MODEL || DEFAULTS.realtimeModel,
    ) || DEFAULTS.realtimeModel).trim(),
    speechToSpeechRealtimeUrl: String(
      configuredS2sUrl || DEFAULTS.speechToSpeechRealtimeUrl,
    ).trim(),
    speechToSpeechAuthToken: String(configuredS2sToken || '').trim(),
    backendModel: String(configured(
      values,
      'QWEN_AUDIO_AGENT_BACKEND_MODEL',
      fallback.QWEN_AUDIO_AGENT_BACKEND_MODEL || DEFAULTS.backendModel,
    ) || '').trim(),
  }
}

export function normalizeSettings(settings = {}) {
  const realtimeProvider = normalizeRealtimeProvider(
    settings.realtimeProvider ?? DEFAULTS.realtimeProvider,
  )
  const requestedS2sUrl = String(
    settings.speechToSpeechRealtimeUrl
    ?? DEFAULTS.speechToSpeechRealtimeUrl,
  ).trim()
  return {
    gatewayUrl: cleanUrl(
      settings.gatewayUrl,
      DEFAULTS.gatewayUrl,
      'Gateway 地址',
    ),
    orbStyle: ['fluid', 'goo'].includes(
      String(settings.orbStyle || DEFAULTS.orbStyle).toLowerCase(),
    )
      ? String(settings.orbStyle || DEFAULTS.orbStyle).toLowerCase()
      : DEFAULTS.orbStyle,
    dashscopeApiKey: String(
      settings.dashscopeApiKey ?? DEFAULTS.dashscopeApiKey,
    ).trim(),
    realtimeProvider,
    agentProtocol: cleanAgentProtocol(
      settings.agentProtocol ?? DEFAULTS.agentProtocol,
    ),
    realtimeModel: [
      'qwen-audio-3.0-realtime-plus',
      'qwen-audio-3.0-realtime-flash',
    ].includes(String(settings.realtimeModel || '').trim())
      ? String(settings.realtimeModel).trim()
      : DEFAULTS.realtimeModel,
    speechToSpeechRealtimeUrl: requestedS2sUrl
      ? cleanRealtimeUrl(requestedS2sUrl, '')
      : realtimeProvider === 'speech-to-speech'
        ? DEFAULT_SPEECH_TO_SPEECH_REALTIME_URL
        : '',
    speechToSpeechAuthToken: String(
      settings.speechToSpeechAuthToken
      ?? DEFAULTS.speechToSpeechAuthToken,
    ).trim(),
    backendModel: String(
      settings.backendModel ?? DEFAULTS.backendModel,
    ).trim(),
  }
}

export function realtimeSettingsConfigured(settings = {}) {
  const provider = normalizeRealtimeProvider(
    settings.realtimeProvider ?? DEFAULTS.realtimeProvider,
  )
  if (provider === 'dashscope') {
    return Boolean(String(settings.dashscopeApiKey || '').trim())
  }
  try {
    return Boolean(cleanRealtimeUrl(
      settings.speechToSpeechRealtimeUrl,
      DEFAULTS.speechToSpeechRealtimeUrl,
    ))
  } catch {
    return false
  }
}

export function updateSettingsContent(content = '', settings = {}) {
  const normalized = normalizeSettings(settings)
  const values = Object.fromEntries(
    Object.entries(SETTING_KEYS)
      .filter(([field]) => settings[field] !== undefined)
      .map(([field, key]) => [
        key,
        encoded(normalized[field]),
      ]),
  )
  const seen = new Set()
  const lines = content.split(/\r?\n/).map(line => {
    const match = line.match(/^([A-Z][A-Z0-9_]*)\s*=/)
    const key = match?.[1]
    if (!key || !(key in values) || seen.has(key)) return line
    seen.add(key)
    return `${key}=${values[key]}`
  })
  for (const key of Object.keys(values)) {
    if (!seen.has(key)) lines.push(`${key}=${values[key]}`)
  }
  return `${lines.join('\n').replace(/\n+$/, '')}\n`
}
