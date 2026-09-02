import { z } from 'zod'
import { createAgentDelivery } from '../delivery/agent-delivery.mjs'

const ROUTE_PRIORITY = Object.freeze({
  handle: 0,
  context: 1,
  respond: 2,
  interrupt: 3,
})
const RESERVED_NAMESPACES = new Set([
  'client',
  'conversation',
  'gateway',
  'permission',
  'response',
  'session',
  'task',
])

function cleanName(value) {
  return String(value || '').trim()
}

function sourceKey(source = {}) {
  return [
    source.ownerId,
    source.sessionId,
    source.clientInstanceId,
  ].map(value => String(value || '')).join(':')
}

function boundedRoute(requested, maximum) {
  if (!requested) return maximum
  return ROUTE_PRIORITY[requested] <= ROUTE_PRIORITY[maximum]
    ? requested
    : maximum
}

export class ClientEventRoutingError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ClientEventRoutingError'
    this.code = code
  }
}

export const BUILTIN_CLIENT_EVENT_DEFINITIONS = Object.freeze([
  Object.freeze({
    name: 'desktop.presence.sleep_requested',
    schema: z.object({
      reason: z.string().trim().min(1).max(160).optional(),
      idle_ms: z.number().int().nonnegative().max(86_400_000).optional(),
    }).strict(),
    maxBytes: 1_024,
    rateLimit: Object.freeze({ max: 4, windowMs: 10_000 }),
    retention: 'latest',
    route: 'context',
    project: event => createAgentDelivery({
      id: `client_event_${event.id}`,
      causeEventId: event.id,
      mode: event.route,
      origin: 'client-event',
      text: [
        '<client_environment_event>',
        '客户端检测到一段时间没有交互，即将进入休眠。',
        Number.isFinite(event.data.idle_ms)
          ? `空闲时长：${event.data.idle_ms} 毫秒`
          : '',
        '这不是用户的新话语，仅用于同步客户端状态；不要回复，也不要调用工具。',
        '</client_environment_event>',
      ].filter(Boolean).join('\n'),
      correlation: { clientEventId: event.id },
      presentation: {
        contextTiming: 'immediate',
      },
    }),
  }),
])

export class ClientEventDefinitionRegistry {
  constructor({ definitions = BUILTIN_CLIENT_EVENT_DEFINITIONS } = {}) {
    this.definitions = new Map()
    for (const definition of definitions) this.register(definition)
  }

  register(definition = {}) {
    const name = cleanName(definition.name)
    const namespace = name.split('.')[0]
    if (!/^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)+$/.test(name)) {
      throw new TypeError(`invalid Client Event name: ${name || '<empty>'}`)
    }
    if (RESERVED_NAMESPACES.has(namespace)) {
      throw new TypeError(`reserved Client Event namespace: ${namespace}`)
    }
    if (this.definitions.has(name)) {
      throw new TypeError(`duplicate Client Event definition: ${name}`)
    }
    if (!definition.schema?.safeParse) {
      throw new TypeError(`Client Event ${name} requires a schema`)
    }
    const route = ROUTE_PRIORITY[definition.route] == null
      ? 'handle'
      : definition.route
    const retention = definition.retention === 'latest' ? 'latest' : 'transient'
    const normalized = Object.freeze({
      name,
      schema: definition.schema,
      maxBytes: Math.max(128, Math.min(65_536, Number(definition.maxBytes) || 4_096)),
      rateLimit: Object.freeze({
        max: Math.max(1, Math.min(1_000, Number(definition.rateLimit?.max) || 20)),
        windowMs: Math.max(
          100,
          Math.min(60_000, Number(definition.rateLimit?.windowMs) || 1_000),
        ),
      }),
      retention,
      route,
      coalesceKey: typeof definition.coalesceKey === 'function'
        ? definition.coalesceKey
        : null,
      handle: typeof definition.handle === 'function' ? definition.handle : null,
      project: typeof definition.project === 'function' ? definition.project : null,
    })
    this.definitions.set(name, normalized)
    return normalized
  }

  get(name) {
    return this.definitions.get(cleanName(name)) || null
  }

  list() {
    return [...this.definitions.values()]
  }
}

export class GatewayEventRouter {
  constructor({
    registry = new ClientEventDefinitionRegistry(),
    now = Date.now,
    duplicateTtlMs = 300_000,
    maxDuplicateIds = 1_024,
  } = {}) {
    this.registry = registry
    this.now = now
    this.duplicateTtlMs = duplicateTtlMs
    this.maxDuplicateIds = maxDuplicateIds
    this.seen = new Map()
    this.rateBuckets = new Map()
    this.latest = new Map()
  }

  // effects are supplied by the Gateway host, never decoded from Client data.
  // They let a registered deterministic handler request a narrow local state
  // transition without exposing Gateway internals or upgrading event authority.
  async publish(message, { source = {}, effects = {} } = {}) {
    const messageId = cleanName(message?.event_id)
    if (!messageId) {
      throw new ClientEventRoutingError(
        'client_event_invalid',
        'Client Event requires event_id',
      )
    }
    const definition = this.registry.get(message?.name)
    if (!definition) {
      throw new ClientEventRoutingError(
        'client_event_unsupported',
        `unsupported Client Event: ${cleanName(message?.name)}`,
      )
    }

    const now = this.now()
    this.#pruneSeen(now)
    const duplicateKey = `${sourceKey(source)}:${messageId}`
    if (this.seen.has(duplicateKey)) {
      return { accepted: true, duplicate: true, name: definition.name }
    }

    const bytes = Buffer.byteLength(JSON.stringify(message.data ?? null), 'utf8')
    if (bytes > definition.maxBytes) {
      throw new ClientEventRoutingError(
        'payload_too_large',
        `Client Event payload exceeds ${definition.maxBytes} bytes`,
      )
    }
    const parsed = definition.schema.safeParse(message.data ?? {})
    if (!parsed.success) {
      throw new ClientEventRoutingError(
        'client_event_invalid',
        `invalid ${definition.name} payload`,
      )
    }
    this.#admitRate(definition, source, now)

    const trustedSource = Object.freeze({
      ownerId: String(source.ownerId || ''),
      sessionId: String(source.sessionId || 'main'),
      clientType: String(source.clientType || 'web'),
      clientInstanceId: String(source.clientInstanceId || ''),
    })
    const event = Object.freeze({
      id: messageId,
      name: definition.name,
      data: Object.freeze(parsed.data),
      occurredAt: Number(message.occurred_at) || now,
      receivedAt: now,
      source: trustedSource,
      route: boundedRoute(message.delivery_hint, definition.route),
    })
    await definition.handle?.(event, effects)
    const delivery = definition.project?.(event) || null
    this.seen.set(duplicateKey, now)
    this.#boundSeen()

    if (definition.retention === 'latest') {
      const suffix = definition.coalesceKey?.(parsed.data, trustedSource) || ''
      this.latest.set(`${sourceKey(trustedSource)}:${definition.name}:${suffix}`, event)
    }
    return {
      accepted: true,
      duplicate: false,
      name: definition.name,
      event,
      delivery,
    }
  }

  latestEvents() {
    return [...this.latest.values()]
  }

  #admitRate(definition, source, now) {
    const key = `${sourceKey(source)}:${definition.name}`
    const current = this.rateBuckets.get(key)
    const bucket = !current || now - current.startedAt >= definition.rateLimit.windowMs
      ? { startedAt: now, count: 0 }
      : current
    bucket.count += 1
    this.rateBuckets.set(key, bucket)
    if (bucket.count > definition.rateLimit.max) {
      throw new ClientEventRoutingError(
        'rate_limited',
        `Client Event rate limit exceeded: ${definition.name}`,
      )
    }
  }

  #pruneSeen(now) {
    for (const [key, timestamp] of this.seen) {
      if (now - timestamp <= this.duplicateTtlMs) continue
      this.seen.delete(key)
    }
  }

  #boundSeen() {
    while (this.seen.size > this.maxDuplicateIds) {
      this.seen.delete(this.seen.keys().next().value)
    }
  }
}
