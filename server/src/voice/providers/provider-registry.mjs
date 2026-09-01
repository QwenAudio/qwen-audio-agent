const PROVIDER_METHODS = [
  'model',
  'voice',
  'isConfigured',
  'url',
  'headers',
  'classifyError',
  'buildSession',
  'buildSpeakResponse',
  'buildResultInjection',
  'buildPermissionInjection',
]

const PROTOCOL_METHODS = [
  'encodeOutgoing',
  'normalizeIncoming',
  'sessionUpdate',
  'audioAppend',
  'conversationItemId',
  'conversationItemCreate',
  'responseCreate',
  'correlateResponseCreate',
  'responseCorrelationId',
  'responseCancel',
  'userTextItem',
  'functionOutputItem',
]

const CAPABILITY_FLAGS = [
  'acknowledgesSessionUpdate',
  'singleResponseSlot',
  'responseMetadataCorrelation',
  'perResponseInstructions',
  'conversationItemIdEcho',
  'sessionOutputVoice',
]

const MODEL_CAPABILITY_FLAGS = [
  'textInput',
  'audioInput',
  'imageInput',
  'videoInput',
  'textOutput',
  'audioOutput',
  'functionCalling',
]

const TRANSPORT_CAPABILITY_FLAGS = [
  'textInput',
  'audioInput',
  'imageInput',
  'observationInput',
  'nativeVideoInput',
]

const VISIBILITIES = new Set(['public', 'gateway-only'])

function cleanKey(value) {
  return String(value || '').trim().toLowerCase()
}

function validateCapabilitySet(provider, profile, property, requiredFlags) {
  const capabilities = profile[property]
  if (
    !capabilities
    || typeof capabilities !== 'object'
    || Array.isArray(capabilities)
    || requiredFlags.some(flag => typeof capabilities[flag] !== 'boolean')
    || Object.values(capabilities).some(value => typeof value !== 'boolean')
  ) {
    throw new Error(
      `Realtime Provider ${provider.key} modelProfile.${property} 不完整`,
    )
  }
}

function validateModelProfile(provider) {
  if (provider.modelProfile === undefined) return
  if (typeof provider.modelProfile !== 'function') {
    throw new Error(`Realtime Provider ${provider.key} modelProfile 必须是函数`)
  }
  const profile = provider.modelProfile()
  if (profile === null) return
  if (
    !profile
    || typeof profile !== 'object'
    || Array.isArray(profile)
    || ['id', 'label', 'family'].some(property => (
      typeof profile[property] !== 'string' || !profile[property].trim()
    ))
  ) {
    throw new Error(`Realtime Provider ${provider.key} modelProfile 无效`)
  }
  validateCapabilitySet(
    provider,
    profile,
    'modelCapabilities',
    MODEL_CAPABILITY_FLAGS,
  )
  validateCapabilitySet(
    provider,
    profile,
    'transportCapabilities',
    TRANSPORT_CAPABILITY_FLAGS,
  )
  if (
    !profile.sessionDefaults
    || typeof profile.sessionDefaults !== 'object'
    || (
      profile.sessionDefaults.voice !== null
      && (
        typeof profile.sessionDefaults.voice !== 'string'
        || !profile.sessionDefaults.voice.trim()
      )
    )
    || (
      profile.sessionDefaults.turnDetection !== null
      && (
        typeof profile.sessionDefaults.turnDetection !== 'object'
        || typeof profile.sessionDefaults.turnDetection.type !== 'string'
        || !profile.sessionDefaults.turnDetection.type.trim()
      )
    )
  ) {
    throw new Error(
      `Realtime Provider ${provider.key} modelProfile.sessionDefaults 不完整`,
    )
  }
}

export function validateRealtimeProtocol(protocol, providerKey = 'unknown') {
  if (!protocol || typeof protocol !== 'object') {
    throw new Error(`Realtime Provider ${providerKey} 未创建 protocol`)
  }
  for (const method of PROTOCOL_METHODS) {
    if (typeof protocol[method] !== 'function') {
      throw new Error(
        `Realtime Provider ${providerKey} protocol 缺少 ${method}()`,
      )
    }
  }
  if (
    protocol.connectionMessages !== undefined
    && typeof protocol.connectionMessages !== 'function'
  ) {
    throw new Error(
      `Realtime Provider ${providerKey} protocol.connectionMessages 必须是函数`,
    )
  }
  return protocol
}

export function validateRealtimeProvider(provider) {
  if (!provider?.key || !provider.label) {
    throw new Error('Realtime Provider 必须定义 key 和 label')
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(provider.key)) {
    throw new Error(`Realtime Provider key 无效：${provider.key}`)
  }
  for (const method of PROVIDER_METHODS) {
    if (typeof provider[method] !== 'function') {
      throw new Error(`Realtime Provider ${provider.key} 缺少 ${method}()`)
    }
  }
  if (!Number.isFinite(provider.inputSampleRate)) {
    throw new Error(`Realtime Provider ${provider.key} 缺少 inputSampleRate`)
  }
  if (!Number.isFinite(provider.outputSampleRate)) {
    throw new Error(`Realtime Provider ${provider.key} 缺少 outputSampleRate`)
  }
  if (
    provider.responseStartTimeoutMs !== undefined
    && (
      !Number.isFinite(provider.responseStartTimeoutMs)
      || provider.responseStartTimeoutMs <= 0
    )
  ) {
    throw new Error(
      `Realtime Provider ${provider.key} 的 responseStartTimeoutMs 必须是正数`,
    )
  }
  if (provider.createProtocol !== undefined) {
    if (typeof provider.createProtocol !== 'function') {
      throw new Error(
        `Realtime Provider ${provider.key} createProtocol 必须是函数`,
      )
    }
  } else {
    validateRealtimeProtocol(provider.protocol, provider.key)
  }
  for (const flag of Object.keys(provider.capabilities || {})) {
    if (!CAPABILITY_FLAGS.includes(flag)) {
      throw new Error(
        `Realtime Provider ${provider.key} 声明了未知能力：${flag}`,
      )
    }
    if (typeof provider.capabilities[flag] !== 'boolean') {
      throw new Error(
        `Realtime Provider ${provider.key} 的能力 ${flag} 必须是布尔值`,
      )
    }
  }
  const visibility = provider.visibility || 'public'
  if (!VISIBILITIES.has(visibility)) {
    throw new Error(
      `Realtime Provider ${provider.key} visibility 无效：${visibility}`,
    )
  }
  if (
    provider.aliases !== undefined
    && (
      !Array.isArray(provider.aliases)
      || provider.aliases.some(alias => !cleanKey(alias))
    )
  ) {
    throw new Error(`Realtime Provider ${provider.key} aliases 无效`)
  }
  validateModelProfile(provider)
  return provider
}

export function defineRealtimeProvider(provider) {
  return validateRealtimeProvider(provider)
}

export class RealtimeProviderRegistry {
  constructor({ providers = [], defaultProvider = '' } = {}) {
    this.providers = new Map()
    this.aliases = new Map()
    this.defaultProvider = cleanKey(defaultProvider)
    for (const provider of providers) this.register(provider)
  }

  register(provider) {
    validateRealtimeProvider(provider)
    const key = cleanKey(provider.key)
    const names = [key, ...(provider.aliases || []).map(cleanKey)]
    for (const name of names) {
      if (this.aliases.has(name)) {
        throw new Error(`Realtime Provider 名称已注册：${name}`)
      }
    }
    this.providers.set(key, provider)
    for (const name of names) this.aliases.set(name, key)
    return provider
  }

  resolve(requested = this.defaultProvider) {
    const name = cleanKey(requested || this.defaultProvider)
    const key = this.aliases.get(name)
    const provider = key ? this.providers.get(key) : null
    if (provider) return provider
    throw new Error(
      `不支持的 Realtime 前台：${name || requested}`
      + `（可选 ${[...this.providers.keys()].join('、')}）`,
    )
  }

  list({ includeGatewayOnly = false, configuredOnly = false } = {}) {
    return [...this.providers.values()].filter(provider => (
      (includeGatewayOnly || (provider.visibility || 'public') === 'public')
      && (!configuredOnly || provider.isConfigured())
    ))
  }
}

export function createRealtimeProviderRegistry(options = {}) {
  return new RealtimeProviderRegistry(options)
}
