export const MEMORY_PROVIDER_PROTOCOL_VERSION = 1

const PROVIDER_KEY = /^[a-z0-9][a-z0-9-]*$/u

function clean(value, maxChars) {
  return [...String(value || '').replace(/\s+/g, ' ').trim()]
    .slice(0, maxChars)
    .join('')
}

export function describeMemoryProvider(provider) {
  const description = provider?.describe?.()
  if (
    !description
    || Number(description.protocolVersion) !== MEMORY_PROVIDER_PROTOCOL_VERSION
    || !PROVIDER_KEY.test(String(description.key || ''))
    || !String(description.label || '').trim()
  ) {
    throw new TypeError(
      'MemoryProvider describe() returned an invalid identity or protocol version',
    )
  }
  return {
    protocolVersion: MEMORY_PROVIDER_PROTOCOL_VERSION,
    key: String(description.key),
    label: clean(description.label, 120),
  }
}

/**
 * Provider-neutral persistence port for frontend memory.
 *
 * Required methods:
 *   describe() -> { protocolVersion, key, label }
 *   list(ownerId, options) -> MemoryDocument[]
 *   apply(ownerId, changes, context) -> MemoryApplyResult | Promise<...>
 *
 * list() is deliberately synchronous because it supplies the latency-sensitive
 * Realtime prompt. Remote providers should keep a bounded local snapshot and
 * refresh it after apply(). Writes may be asynchronous.
 *
 * Optional lifecycle methods:
 *   health() -> { ok, ... }
 *   close()
 */
export function assertMemoryProvider(value, { name = 'MemoryProvider' } = {}) {
  if (!value || typeof value !== 'object') {
    throw new TypeError(`${name} must be an object`)
  }
  const missing = ['describe', 'list', 'apply']
    .filter(method => typeof value[method] !== 'function')
  if (missing.length) {
    throw new TypeError(`${name} is missing required methods: ${missing.join(', ')}`)
  }
  if (value.health != null && typeof value.health !== 'function') {
    throw new TypeError(`${name} health must be a function when provided`)
  }
  if (value.close != null && typeof value.close !== 'function') {
    throw new TypeError(`${name} close must be a function when provided`)
  }
  describeMemoryProvider(value)
  return value
}

export function normalizeMemoryProviderHealth(value) {
  const health = value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {}
  return {
    ...health,
    ok: health.ok !== false,
  }
}
