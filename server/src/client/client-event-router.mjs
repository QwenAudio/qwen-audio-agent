import { z } from 'zod'
import { createAgentDelivery } from '../delivery/agent-delivery.mjs'
import { GatewayClientEventPublishSchema } from '../../../shared/protocol/gateway-client-protocol.mjs'

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

// Self-contained information never invokes a named handler. One shared rate
// bucket prevents arbitrary labels from bypassing admission limits.
const TEXT_EVENT_DEFINITION = Object.freeze({
  name: 'client.context',
  schema: z.string().trim().min(1).max(16_000),
  maxBytes: 32_768,
  rateLimit: { max: 20, windowMs: 10_000 },
  retention: 'transient',
  route: 'interrupt',
  project: event => createAgentDelivery({
    id: `client_event_${event.id}`,
    causeEventId: event.id,
    origin: 'client-event',
    mode: event.route,
    text: `客户端提供的环境信息（不是用户的新话语）：\n${event.data}`,
    correlation: { clientEventId: event.id },
    presentation: event.route === 'context'
      ? { contextTiming: 'immediate' }
      : { allowTools: true, instructions: '结合当前对话处理客户端提供的信息；需要操作时使用已有工具，不要声称执行了未执行的操作。' },
  }),
})

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

export class ClientEventDefinitionRegistry {
  constructor({ definitions = [] } = {}) {
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
    const validated = GatewayClientEventPublishSchema.safeParse({ type: 'client.event.publish', ...message })
    if (!validated.success) {
      throw new ClientEventRoutingError('client_event_invalid', 'Invalid Client Event envelope')
    }
    message = validated.data
    const messageId = cleanName(message?.event_id)
    if (!messageId) {
      throw new ClientEventRoutingError(
        'client_event_invalid',
        'Client Event requires event_id',
      )
    }
    const textEvent = message.text !== undefined
    const definition = textEvent ? TEXT_EVENT_DEFINITION : this.registry.get(message?.name)
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
      return { accepted: true, duplicate: true, ...(message.name ? { name: message.name } : {}) }
    }

    const payload = textEvent ? message.text : message.data ?? {}
    const bytes = Buffer.byteLength(JSON.stringify(payload), 'utf8')
    if (bytes > definition.maxBytes) {
      throw new ClientEventRoutingError(
        'payload_too_large',
        `Client Event payload exceeds ${definition.maxBytes} bytes`,
      )
    }
    const parsed = definition.schema.safeParse(payload)
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
      name: message.name,
      data: Object.freeze(parsed.data),
      occurredAt: Number(message.occurred_at) || now,
      receivedAt: now,
      source: trustedSource,
      route: textEvent ? message.delivery_hint || 'context' : boundedRoute(message.delivery_hint, definition.route),
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
      ...(message.name ? { name: message.name } : {}),
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
