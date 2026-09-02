import { randomUUID } from 'node:crypto'
import {
  GATEWAY_CLIENT_IMPLEMENTED_CAPABILITIES,
  GATEWAY_CLIENT_PROTOCOL_VERSION,
  GatewayClientProtocolEvent,
  GatewaySessionHelloSchema,
  gatewayClientProtocolCapabilityFor,
  gatewayHelloAsLegacyConnect,
  isGatewayClientRuntimeMessage,
  negotiateGatewayClientCapabilities,
  normalizeGatewayClientProtocolMessage,
  parseGatewayClientProtocolMessage,
  supportsGatewayClientProtocol,
} from '../../../shared/gateway-client-protocol.mjs'
import { parseGatewayClientMessage } from '../../../shared/protocol/gateway-events.mjs'
import { isReplayableGatewayEvent } from './gateway-client-replay-buffer.mjs'

function eventId() {
  return `evt_gateway_${randomUUID().replaceAll('-', '')}`
}

export class GatewayClientProtocolSession {
  constructor({
    sessionId,
    supportedCapabilities = GATEWAY_CLIENT_IMPLEMENTED_CAPABILITIES,
    createEventId = eventId,
    maxPendingServerEvents = 128,
    replayBuffer = null,
  } = {}) {
    this.sessionId = String(sessionId || 'main')
    this.supportedCapabilities = [...supportedCapabilities]
    this.createEventId = createEventId
    this.maxPendingServerEvents = Math.max(1, Number(maxPendingServerEvents) || 128)
    this.mode = 'pending'
    this.protocolVersion = null
    this.capabilities = []
    this.pendingServerEvents = []
    this.replayBuffer = replayBuffer
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
      // Client Actions are introduced by 6.0, but current first-party clients
      // still open with the 5.x connect alias during staged migration. Accept
      // only the typed result message here; every other legacy behavior stays
      // unchanged and GCP5 will move these clients to session.hello.
      if ([
        GatewayClientProtocolEvent.CLIENT_ACTION_RESULT,
        GatewayClientProtocolEvent.CLIENT_EVENT_PUBLISH,
      ].includes(value?.type)) {
        try {
          return { event: null, runtimeMessage: parseGatewayClientProtocolMessage(value) }
        } catch {
          return { event: null }
        }
      }
      return { event: this.#parseLegacy(value) }
    }

    if (value?.type === GatewayClientProtocolEvent.SESSION_HELLO) {
      return this.#error('bad_event', 'session.hello is only valid as the first message', {
        requestEventId: value?.event_id,
      })
    }

    if (isGatewayClientRuntimeMessage(value?.type)) {
      const requiredCapability = gatewayClientProtocolCapabilityFor(value.type)
      if (!this.capabilities.includes(requiredCapability)) {
        return this.#error(
          'capability_not_negotiated',
          `${requiredCapability} was not negotiated`,
          { requestEventId: value?.event_id },
        )
      }
      try {
        if (value.type === GatewayClientProtocolEvent.SESSION_REPLAY) {
          return { event: null, reply: this.#replay(value) }
        }
        return { event: null, runtimeMessage: parseGatewayClientProtocolMessage(value) }
      } catch (error) {
        return this.#error(error.code || 'bad_event', error.message, {
          requestEventId: value?.event_id,
        })
      }
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
    const encoded = event?.event_id ? event : {
      ...event,
      event_id: this.createEventId(),
    }
    if (this.replayBuffer && isReplayableGatewayEvent(encoded)) {
      return this.replayBuffer.append(encoded)
    }
    return encoded
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

  #replay(message) {
    const parsed = parseGatewayClientProtocolMessage(message)
    if (!this.replayBuffer) {
      const error = new Error('session replay is unavailable')
      error.code = 'replay_unavailable'
      throw error
    }
    const page = this.replayBuffer.replay(parsed.after_sequence, {
      limit: parsed.limit,
    })
    return {
      type: GatewayClientProtocolEvent.SESSION_REPLAY_RESULT,
      event_id: this.createEventId(),
      request_event_id: parsed.event_id,
      events: page.events,
      earliest_sequence: page.earliestSequence,
      latest_sequence: page.latestSequence,
      next_sequence: page.nextSequence,
      has_more: page.hasMore,
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
