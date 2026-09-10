export const MEMORY_PROVIDER_PROTOCOL_VERSION = 2
export const LEGACY_MEMORY_PROVIDER_PROTOCOL_VERSION = 1

const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  LEGACY_MEMORY_PROVIDER_PROTOCOL_VERSION,
  MEMORY_PROVIDER_PROTOCOL_VERSION,
])

const PROVIDER_KEY = /^[a-z0-9][a-z0-9-]*$/u

function clean(value, maxChars) {
  return [...String(value || '').replace(/\s+/g, ' ').trim()]
    .slice(0, maxChars)
    .join('')
}

export function describeMemoryProvider(provider) {
  const description = provider?.describe?.()
  const protocolVersion = Number(description?.protocolVersion)
  if (
    !description
    || !SUPPORTED_PROTOCOL_VERSIONS.has(protocolVersion)
    || !PROVIDER_KEY.test(String(description.key || ''))
    || !String(description.label || '').trim()
  ) {
    throw new TypeError(
      'MemoryProvider describe() returned an invalid identity or protocol version',
    )
  }
  return {
    protocolVersion,
    key: String(description.key),
    label: clean(description.label, 120),
    capabilities: {
      semanticQuery: protocolVersion >= 2
        && description.capabilities?.semanticQuery === true,
      sessionObservation: protocolVersion >= 2
        && description.capabilities?.sessionObservation === true,
      audioStreamObservation: protocolVersion >= 2
        && description.capabilities?.audioStreamObservation === true,
    },
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
 * Protocol v2 optional capabilities:
 *   query(ownerId, query, options, context) -> MemoryQueryResult
 *   observe(ownerId, exchange, context) -> void
 *   flush(ownerId, context) -> void
 *   observeAudio(ownerId, event, context) -> void
 *
 * Providers advertise semanticQuery/sessionObservation/audioStreamObservation
 * from describe(). observeAudio() runs on the accepted PCM16 input hot path
 * and receives chunk, speech_started, speech_stopped, and session_ended events.
 * It must therefore be synchronous, bounded, and free of remote I/O. A
 * provider that owns sessionObservation replaces the built-in Markdown
 * extractor and preference learner; the two learning pipelines never run in
 * parallel. Such providers also own retention, sensitive-data filtering, and
 * deletion policy for the exchanges they observe.
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
  const description = describeMemoryProvider(value)
  if (description.capabilities.semanticQuery && typeof value.query !== 'function') {
    throw new TypeError(`${name} advertises semanticQuery but has no query method`)
  }
  if (description.capabilities.sessionObservation && typeof value.observe !== 'function') {
    throw new TypeError(`${name} advertises sessionObservation but has no observe method`)
  }
  if (
    description.capabilities.audioStreamObservation
    && typeof value.observeAudio !== 'function'
  ) {
    throw new TypeError(
      `${name} advertises audioStreamObservation but has no observeAudio method`,
    )
  }
  if (value.flush != null && typeof value.flush !== 'function') {
    throw new TypeError(`${name} flush must be a function when provided`)
  }
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
