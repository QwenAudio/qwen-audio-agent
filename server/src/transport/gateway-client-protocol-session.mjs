import { randomUUID } from 'node:crypto'
import {
  GATEWAY_CLIENT_IMPLEMENTED_CAPABILITIES,
  GATEWAY_CLIENT_PROTOCOL_VERSION,
  GatewayClientProtocolEvent,
  GatewaySessionHelloSchema,
  gatewayHelloAsLegacyConnect,
  negotiateGatewayClientCapabilities,
  normalizeGatewayClientProtocolMessage,
  supportsGatewayClientProtocol,
} from '../../../shared/gateway-client-protocol.mjs'
import { parseGatewayClientMessage } from '../../../shared/protocol/gateway-events.mjs'

function eventId() {
  return `evt_gateway_${randomUUID().replaceAll('-', '')}`
}

export class GatewayClientProtocolSession {
  constructor({
    sessionId,
    supportedCapabilities = GATEWAY_CLIENT_IMPLEMENTED_CAPABILITIES,
    createEventId = eventId,
    maxPendingServerEvents = 128,
  } = {}) {
    this.sessionId = String(sessionId || 'main')
    this.supportedCapabilities = [...supportedCapabilities]
    this.createEventId = createEventId
    this.maxPendingServerEvents = Math.max(1, Number(maxPendingServerEvents) || 128)
    this.mode = 'pending'
    this.protocolVersion = null
    this.capabilities = []
    this.pendingServerEvents = []
  }

  receive(value) {
    if (this.mode === 'pending' && value?.type === GatewayClientProtocolEvent.SESSION_HELLO) {
      return this.#acceptHello(value)
    }

    if (this.mode === 'pending') {
      const parsed = this.#parseLegacy(value)
      if (!parsed) return { event: null }
      this.mode = 'legacy'
      return { event: parsed, pending: this.#drainPending() }
    }

    if (this.mode === 'legacy') {
      return { event: this.#parseLegacy(value) }
    }

    if (value?.type === GatewayClientProtocolEvent.SESSION_HELLO) {
      return this.#error('bad_event', 'session.hello is only valid as the first message', {
        requestEventId: value?.event_id,
      })
    }

    try {
      return { event: normalizeGatewayClientProtocolMessage(value) }
    } catch (error) {
      return this.#error(error.code || 'bad_event', error.message, {
        requestEventId: value?.event_id,
      })
    }
  }

  encode(event) {
    if (this.mode === 'pending') {
      this.pendingServerEvents.push(event)
      if (this.pendingServerEvents.length > this.maxPendingServerEvents) {
        this.pendingServerEvents.shift()
      }
      return null
    }
    if (this.mode === 'legacy') return event
    if (event?.event_id) return event
    return {
      ...event,
      event_id: this.createEventId(),
    }
  }

  #acceptHello(value) {
    const parsed = GatewaySessionHelloSchema.safeParse(value)
    if (!parsed.success) {
      return this.#error('bad_event', 'invalid session.hello', {
        requestEventId: value?.event_id,
        close: true,
      })
    }
    if (!supportsGatewayClientProtocol(parsed.data.protocol)) {
      return this.#error(
        'protocol_version_unsupported',
        `Gateway supports ${GATEWAY_CLIENT_PROTOCOL_VERSION}`,
        { requestEventId: parsed.data.event_id, close: true },
      )
    }

    this.mode = 'v6'
    this.protocolVersion = GATEWAY_CLIENT_PROTOCOL_VERSION
    this.capabilities = negotiateGatewayClientCapabilities(
      parsed.data.capabilities,
      this.supportedCapabilities,
    )
    return {
      event: gatewayHelloAsLegacyConnect(parsed.data),
      reply: {
        type: GatewayClientProtocolEvent.SESSION_READY,
        event_id: this.createEventId(),
        request_event_id: parsed.data.event_id,
        protocol_version: this.protocolVersion,
        session_id: this.sessionId,
        capabilities: this.capabilities,
      },
      pending: this.#drainPending(),
    }
  }

  #parseLegacy(value) {
    try {
      return parseGatewayClientMessage(value)
    } catch {
      // 5.x silently ignored malformed and unknown messages. Preserve that
      // behavior until the compatibility alias is retired.
      return null
    }
  }

  #drainPending() {
    const pending = this.pendingServerEvents
    this.pendingServerEvents = []
    return pending
  }

  #error(code, message, { requestEventId, close = false } = {}) {
    if (this.mode === 'pending') this.mode = 'v6'
    return {
      event: null,
      close,
      reply: {
        type: 'error',
        event_id: this.createEventId(),
        ...(requestEventId ? { request_event_id: String(requestEventId) } : {}),
        error: {
          code: String(code),
          message: String(message).slice(0, 500),
        },
      },
      pending: this.#drainPending(),
    }
  }
}
