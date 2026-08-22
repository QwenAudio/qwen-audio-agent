import { parseEnv } from 'node:util'
import {
  backendDefinition,
  normalizeBackendProtocol,
  resolveBackendOwnership,
} from '../../shared/backend-catalog.mjs'
import {
  normalizeOrbSkinId,
  resolveOrbSkinId,
} from '../../shared/orb-skin-catalog.mjs'
import {
  DEFAULT_DASHSCOPE_REALTIME_MODEL,
  DEFAULT_DASHSCOPE_REALTIME_URL,
  DEFAULT_REALTIME_PROVIDER,
  DEFAULT_SPEECH_TO_SPEECH_REALTIME_URL,
  normalizeRealtimeProvider,
} from '../../shared/realtime-provider-catalog.mjs'
import { normalizeDesktopLanguage } from './i18n.mjs'

const DEFAULTS = {
  gatewayUrl: 'http://127.0.0.1:3101',
  orbStyle: 'fluid',
  orbSkin: 'fluid',
  autoHideSeconds: 60,
  wakeShortcut: 'CommandOrControl+Shift+Space',
  nativeInputEnabled: false,
  nativeInputShortcut: 'CommandOrControl+Shift+D',
  wakeWordEnabled: false,
  dashscopeApiKey: '',
  realtimeBaseUrl: DEFAULT_DASHSCOPE_REALTIME_URL,
  realtimeProvider: DEFAULT_REALTIME_PROVIDER,
  agentProtocol: 'none',
  realtimeModel: DEFAULT_DASHSCOPE_REALTIME_MODEL,
  audioRealtimeVoice: '',
  omniRealtimeVoice: '',
  speechToSpeechRealtimeUrl: '',
  speechToSpeechAuthToken: '',
  backendModel: '',
  backendOwnership: 'owned',
  backendUrl: '',
  backendCredential: '',
  nodePath: '',
  language: 'auto',
}

const SETTING_KEYS = {
  gatewayUrl: 'QWEN_AUDIO_AGENT_URL',
  orbStyle: 'QWEN_AUDIO_ORB_STYLE',
  orbSkin: 'QWEN_AUDIO_ORB_SKIN',
  autoHideSeconds: 'QWEN_AUDIO_DESKTOP_AUTO_HIDE_SECONDS',
  wakeShortcut: 'QWEN_AUDIO_DESKTOP_WAKE_SHORTCUT',
  nativeInputEnabled: 'QWEN_AUDIO_NATIVE_INPUT_ENABLED',
  nativeInputShortcut: 'QWEN_AUDIO_NATIVE_INPUT_SHORTCUT',
  wakeWordEnabled: 'QWEN_AUDIO_WAKE_WORD_ENABLED',
  dashscopeApiKey: 'DASHSCOPE_API_KEY',
  realtimeBaseUrl: 'QWEN_AUDIO_REALTIME_BASE_URL',
  realtimeProvider: 'QWEN_AUDIO_REALTIME_PROVIDER',
  agentProtocol: 'AGENT_PROTOCOL',
  realtimeModel: 'QWEN_AUDIO_REALTIME_MODEL',
  audioRealtimeVoice: 'QWEN_AUDIO_REALTIME_VOICE',
  omniRealtimeVoice: 'QWEN_OMNI_REALTIME_VOICE',
  speechToSpeechRealtimeUrl: 'SPEECH_TO_SPEECH_REALTIME_URL',
  speechToSpeechAuthToken: 'SPEECH_TO_SPEECH_AUTH_TOKEN',
  backendModel: 'QWEN_AUDIO_AGENT_BACKEND_MODEL',
  backendOwnership: 'QWEN_AUDIO_AGENT_BACKEND_OWNERSHIP',
  nodePath: 'QWEN_AUDIO_AGENT_NODE_PATH',
  language: 'QWEN_AUDIO_DESKTOP_LANGUAGE',
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

function cleanRealtimeUrl(value, fallback, label = '服务地址') {
  const text = String(value || fallback).trim()
  const url = new URL(text)
  if (!['ws:', 'wss:'].includes(url.protocol)) {
    throw new Error(`${label}只支持 WS 或 WSS`)
  }
  return text.replace(/\/+$/, '')
}

function cleanBackendUrl(value, label = '后台服务地址') {
  const text = String(value || '').trim()
  if (!text) return ''
  const url = new URL(text)
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) {
    throw new Error(`${label}只支持 HTTP、HTTPS、WS 或 WSS`)
  }
  if (url.username || url.password) {
    throw new Error(`${label}不能包含用户名或密码，请使用独立的访问令牌`)
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

function cleanAutoHideSeconds(value) {
  const seconds = Number(value)
  if (seconds === 0) return 0
  if (!Number.isInteger(seconds) || seconds < 30 || seconds > 3600) {
    return DEFAULTS.autoHideSeconds
  }
  return seconds
}

function cleanShortcut(value, fallback) {
  const shortcut = String(value || fallback).trim()
  const parts = shortcut.split('+')
  const key = parts.pop() || ''
  const modifiers = new Set(parts)
  const validModifiers = parts.every(part => (
    ['CommandOrControl', 'Alt', 'Shift'].includes(part)
  )) && modifiers.size === parts.length
  const validKey = (
    key === 'Space'
    || /^[A-Z0-9]$/.test(key)
    || /^F(?:[1-9]|1\d|2[0-4])$/.test(key)
    || ['Up', 'Down', 'Left', 'Right'].includes(key)
  )
  const functionKey = /^F(?:[1-9]|1\d|2[0-4])$/.test(key)
  const hasCommandModifier = (
    modifiers.has('CommandOrControl') || modifiers.has('Alt')
  )
  if (!validModifiers || !validKey || (!functionKey && !hasCommandModifier)) {
    return fallback
  }
  return [
    modifiers.has('CommandOrControl') ? 'CommandOrControl' : '',
    modifiers.has('Alt') ? 'Alt' : '',
    modifiers.has('Shift') ? 'Shift' : '',
    key,
  ].filter(Boolean).join('+')
}

function cleanWakeShortcut(value) {
  const shortcut = String(value || DEFAULTS.wakeShortcut).trim()
  if (shortcut === 'CommandOrControl+Space') {
    return DEFAULTS.wakeShortcut
  }
  return cleanShortcut(shortcut, DEFAULTS.wakeShortcut)
}

function cleanNativeInputShortcut(value) {
  return cleanShortcut(value, DEFAULTS.nativeInputShortcut)
}

function encoded(value) {
  const text = String(value ?? '')
  if (/^[A-Za-z0-9_./:@+-]*$/.test(text)) return text
  return `"${text.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

export function parseSettings(content = '', fallback = {}) {
  const values = parseEnv(content)
  const agentProtocol = cleanAgentProtocol(configured(
    values,
    'AGENT_PROTOCOL',
    fallback.AGENT_PROTOCOL || DEFAULTS.agentProtocol,
  ))
  const backend = backendDefinition(agentProtocol)
  const backendUrl = backend?.baseUrlEnvironment
    ? String(configured(
      values,
      backend.baseUrlEnvironment,
      fallback[backend.baseUrlEnvironment] || '',
    ) || '').trim()
    : ''
  const backendOwnership = backend
    ? resolveBackendOwnership(agentProtocol, {
      baseUrlConfigured: Boolean(backendUrl),
      requestedOwnership: configured(
        values,
        'QWEN_AUDIO_AGENT_BACKEND_OWNERSHIP',
        fallback.QWEN_AUDIO_AGENT_BACKEND_OWNERSHIP || '',
      ),
    })
    : DEFAULTS.backendOwnership
  const credentialEnvironment = backend?.externalService?.credentialEnvironment
  const backendCredential = credentialEnvironment
    ? String(configured(
      values,
      credentialEnvironment,
      fallback[credentialEnvironment] || '',
    ) || '').trim()
    : ''
  const realtimeProvider = normalizeRealtimeProvider(configured(
    values,
    'QWEN_AUDIO_REALTIME_PROVIDER',
    fallback.QWEN_AUDIO_REALTIME_PROVIDER || DEFAULTS.realtimeProvider,
  ))
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
  const configuredRealtimeBaseUrl = configured(
    values,
    'QWEN_AUDIO_REALTIME_BASE_URL',
    configured(
      values,
      'QWEN_AUDIO_REALTIME_URL',
      fallback.QWEN_AUDIO_REALTIME_BASE_URL
      || fallback.QWEN_AUDIO_REALTIME_URL
      || (fallback.DASHSCOPE_WORKSPACE_ID
        ? `wss://${fallback.DASHSCOPE_WORKSPACE_ID}.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime`
        : DEFAULTS.realtimeBaseUrl),
    ),
  )
  const configuredOrbStyle = configured(
    values,
    'QWEN_AUDIO_ORB_STYLE',
    fallback.QWEN_AUDIO_ORB_STYLE || '',
  )
  const configuredOrbSkin = configured(
    values,
    'QWEN_AUDIO_ORB_SKIN',
    fallback.QWEN_AUDIO_ORB_SKIN || '',
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
  const realtimeModel = String(configured(
    values,
    'QWEN_AUDIO_REALTIME_MODEL',
    fallback.QWEN_AUDIO_REALTIME_MODEL || DEFAULTS.realtimeModel,
  ) || DEFAULTS.realtimeModel).trim()
  const audioRealtimeVoice = String(configured(
    values,
    'QWEN_AUDIO_REALTIME_VOICE',
    fallback.QWEN_AUDIO_REALTIME_VOICE || DEFAULTS.audioRealtimeVoice,
  ) || '').trim()
  const omniRealtimeVoice = String(configured(
    values,
    'QWEN_OMNI_REALTIME_VOICE',
    fallback.QWEN_OMNI_REALTIME_VOICE || DEFAULTS.omniRealtimeVoice,
  ) || '').trim()
  return {
    gatewayUrl: configured(
      values,
      'QWEN_AUDIO_AGENT_URL',
      fallback.QWEN_AUDIO_AGENT_URL || DEFAULTS.gatewayUrl,
    ) || DEFAULTS.gatewayUrl,
    orbStyle: ['fluid', 'goo'].includes(
      String(configuredOrbStyle).toLowerCase(),
    ) ? String(configuredOrbStyle).toLowerCase() : DEFAULTS.orbStyle,
    // 旧配置只有 QWEN_AUDIO_ORB_STYLE 时自动收敛为 orbSkin。
    orbSkin: resolveOrbSkinId({
      orbSkin: configuredOrbSkin,
      orbStyle: configuredOrbStyle,
    }),
    autoHideSeconds: cleanAutoHideSeconds(configured(
      values,
      'QWEN_AUDIO_DESKTOP_AUTO_HIDE_SECONDS',
      configured(
        values,
        'QWEN_AUDIO_DESKTOP_AUTO_SLEEP_SECONDS',
        fallback.QWEN_AUDIO_DESKTOP_AUTO_HIDE_SECONDS
          ?? fallback.QWEN_AUDIO_DESKTOP_AUTO_SLEEP_SECONDS
          ?? DEFAULTS.autoHideSeconds,
      ),
    )),
    wakeShortcut: cleanWakeShortcut(configured(
      values,
      'QWEN_AUDIO_DESKTOP_WAKE_SHORTCUT',
      fallback.QWEN_AUDIO_DESKTOP_WAKE_SHORTCUT ?? DEFAULTS.wakeShortcut,
    )),
    nativeInputEnabled: String(configured(
      values,
      'QWEN_AUDIO_NATIVE_INPUT_ENABLED',
      fallback.QWEN_AUDIO_NATIVE_INPUT_ENABLED || '',
    )).toLowerCase() === 'true',
    nativeInputShortcut: cleanNativeInputShortcut(configured(
      values,
      'QWEN_AUDIO_NATIVE_INPUT_SHORTCUT',
      fallback.QWEN_AUDIO_NATIVE_INPUT_SHORTCUT
        ?? DEFAULTS.nativeInputShortcut,
    )),
    wakeWordEnabled: String(
      configured(
        values,
        'QWEN_AUDIO_WAKE_WORD_ENABLED',
        fallback.QWEN_AUDIO_WAKE_WORD_ENABLED || '',
      ),
    ).toLowerCase() === 'true',
    dashscopeApiKey: String(configuredApiKey || '').trim(),
    realtimeBaseUrl: String(configuredRealtimeBaseUrl || '').trim()
      || DEFAULTS.realtimeBaseUrl,
    realtimeProvider,
    agentProtocol,
    realtimeModel,
    audioRealtimeVoice,
    omniRealtimeVoice,
    speechToSpeechRealtimeUrl: String(
      configuredS2sUrl
      || (realtimeProvider === 'speech-to-speech'
        ? DEFAULT_SPEECH_TO_SPEECH_REALTIME_URL
        : DEFAULTS.speechToSpeechRealtimeUrl),
    ).trim(),
    speechToSpeechAuthToken: String(configuredS2sToken || '').trim(),
    backendModel: String(configured(
      values,
      'QWEN_AUDIO_AGENT_BACKEND_MODEL',
      fallback.QWEN_AUDIO_AGENT_BACKEND_MODEL || DEFAULTS.backendModel,
    ) || '').trim(),
    backendOwnership,
    backendUrl,
    backendCredential,
    nodePath: String(configured(
      values,
      'QWEN_AUDIO_AGENT_NODE_PATH',
      fallback.QWEN_AUDIO_AGENT_NODE_PATH || DEFAULTS.nodePath,
    ) || '').trim(),
    language: normalizeDesktopLanguage(configured(
      values,
      'QWEN_AUDIO_DESKTOP_LANGUAGE',
      fallback.QWEN_AUDIO_DESKTOP_LANGUAGE || DEFAULTS.language,
    )),
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
  const realtimeModel = String(
    settings.realtimeModel || DEFAULTS.realtimeModel,
  ).trim() || DEFAULTS.realtimeModel
  const audioRealtimeVoice = String(
    settings.audioRealtimeVoice ?? DEFAULTS.audioRealtimeVoice,
  ).trim()
  const omniRealtimeVoice = String(
    settings.omniRealtimeVoice ?? DEFAULTS.omniRealtimeVoice,
  ).trim()
  const agentProtocol = cleanAgentProtocol(
    settings.agentProtocol ?? DEFAULTS.agentProtocol,
  )
  const backend = backendDefinition(agentProtocol)
  const backendUrl = backend?.baseUrlEnvironment
    ? cleanBackendUrl(settings.backendUrl ?? DEFAULTS.backendUrl)
    : ''
  const backendOwnership = backend
    ? resolveBackendOwnership(agentProtocol, {
      baseUrlConfigured: Boolean(backendUrl),
      requestedOwnership: settings.backendOwnership
        ?? DEFAULTS.backendOwnership,
    })
    : DEFAULTS.backendOwnership
  if (backendOwnership === 'external' && !backendUrl) {
    throw new Error('请填写外部后台服务地址')
  }
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
    orbSkin: normalizeOrbSkinId(settings.orbSkin) || DEFAULTS.orbSkin,
    autoHideSeconds: cleanAutoHideSeconds(
      settings.autoHideSeconds ?? DEFAULTS.autoHideSeconds,
    ),
    wakeShortcut: cleanWakeShortcut(
      settings.wakeShortcut ?? DEFAULTS.wakeShortcut,
    ),
    nativeInputEnabled: Boolean(settings.nativeInputEnabled),
    nativeInputShortcut: cleanNativeInputShortcut(
      settings.nativeInputShortcut ?? DEFAULTS.nativeInputShortcut,
    ),
    wakeWordEnabled: Boolean(settings.wakeWordEnabled),
    dashscopeApiKey: String(
      settings.dashscopeApiKey ?? DEFAULTS.dashscopeApiKey,
    ).trim(),
    realtimeBaseUrl: cleanRealtimeUrl(
      settings.realtimeBaseUrl,
      DEFAULTS.realtimeBaseUrl,
      'Qwen Audio 服务地址',
    ),
    realtimeProvider,
    agentProtocol,
    realtimeModel,
    audioRealtimeVoice,
    omniRealtimeVoice,
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
    backendOwnership,
    backendUrl,
    backendCredential: backend?.externalService?.credentialEnvironment
      ? String(settings.backendCredential ?? DEFAULTS.backendCredential).trim()
      : '',
    nodePath: String(
      settings.nodePath ?? DEFAULTS.nodePath,
    ).trim(),
    language: normalizeDesktopLanguage(settings.language),
  }
}

export function realtimeSettingsConfigured(settings = {}) {
  const provider = normalizeRealtimeProvider(
    settings.realtimeProvider ?? DEFAULTS.realtimeProvider,
  )
  if (provider === 'dashscope') {
    try {
      cleanRealtimeUrl(
        settings.realtimeBaseUrl,
        DEFAULTS.realtimeBaseUrl,
        'Qwen Audio 服务地址',
      )
      return Boolean(String(settings.dashscopeApiKey || '').trim())
    } catch {
      return false
    }
  }
  try {
    return Boolean(cleanRealtimeUrl(
      settings.speechToSpeechRealtimeUrl,
      DEFAULT_SPEECH_TO_SPEECH_REALTIME_URL,
    ))
  } catch {
    return false
  }
}

// Applies a just-saved settings patch to a live environment, mirroring the
// key mapping of updateSettingsContent. Without this the desktop process
// keeps serving the values it loaded first — the config file is only read
// into environment slots that are still unset, so a freshly saved API Key
// would look ignored until the app itself restarts.
export function applySettingsEnvironment(settings = {}, env = process.env) {
  const normalized = normalizeSettings(settings)
  const backend = backendDefinition(normalized.agentProtocol)
  const entries = Object.entries(SETTING_KEYS)
    .filter(([field]) => settings[field] !== undefined)
    .map(([field, key]) => [key, normalized[field]])
  if (settings.backendUrl !== undefined && backend?.baseUrlEnvironment) {
    entries.push([backend.baseUrlEnvironment, normalized.backendUrl])
  }
  const credentialEnvironment = backend?.externalService?.credentialEnvironment
  if (settings.backendCredential !== undefined && credentialEnvironment) {
    entries.push([credentialEnvironment, normalized.backendCredential])
  }
  for (const [key, value] of entries) {
    const text = String(value ?? '')
    // A cleared value releases the slot so runtime defaults apply again,
    // instead of pinning the stale override forever.
    if (text === '') delete env[key]
    else env[key] = text
  }
  return env
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
  const backend = backendDefinition(normalized.agentProtocol)
  if (settings.backendUrl !== undefined && backend?.baseUrlEnvironment) {
    values[backend.baseUrlEnvironment] = encoded(normalized.backendUrl)
  }
  const credentialEnvironment = backend?.externalService?.credentialEnvironment
  if (settings.backendCredential !== undefined && credentialEnvironment) {
    values[credentialEnvironment] = encoded(normalized.backendCredential)
  }
  const removed = new Set([
    ['audioRealtimeVoice', 'QWEN_AUDIO_REALTIME_VOICE'],
    ['omniRealtimeVoice', 'QWEN_OMNI_REALTIME_VOICE'],
    ['backendUrl', backend?.baseUrlEnvironment],
    ['backendCredential', credentialEnvironment],
  ].filter(([field, key]) => (
    Boolean(key) && settings[field] !== undefined && !normalized[field]
  )).map(([, key]) => key))
  // Legacy keys that were merged into auto-hide. Drop them so the saved
  // config no longer carries a divergent sleep timeout.
  const legacy = new Set([
    'QWEN_AUDIO_SLEEP_TIMEOUT_SECONDS',
    'QWEN_AUDIO_DESKTOP_AUTO_SLEEP_SECONDS',
  ])
  const seen = new Set()
  const lines = content.split(/\r?\n/).map(line => {
    const match = line.match(/^([A-Z][A-Z0-9_]*)\s*=/)
    const key = match?.[1]
    if (key && legacy.has(key)) return null
    if (key && removed.has(key)) return null
    if (!key || !(key in values) || seen.has(key)) return line
    seen.add(key)
    return `${key}=${values[key]}`
  }).filter(line => line !== null)
  for (const key of Object.keys(values)) {
    if (!seen.has(key) && !removed.has(key)) lines.push(`${key}=${values[key]}`)
  }
  return `${lines.join('\n').replace(/\n+$/, '')}\n`
}
