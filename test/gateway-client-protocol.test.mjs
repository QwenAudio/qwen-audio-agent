import assert from 'node:assert/strict'
import test from 'node:test'
import {
  GATEWAY_CLIENT_IMPLEMENTED_CAPABILITIES,
  GATEWAY_CLIENT_KNOWN_CAPABILITIES,
  GATEWAY_CLIENT_PROTOCOL_VERSION,
  GatewayClientCapability,
  GatewayClientEnvelopeSchema,
  GatewayClientProtocolEvent,
  GatewaySessionHelloSchema,
  createGatewayClientProtocolMessage,
  createGatewaySessionHello,
  negotiateGatewayClientCapabilities,
  normalizeGatewayClientProtocolMessage,
  parseGatewayServerProtocolMessage,
  supportsGatewayClientProtocol,
} from '../shared/gateway-client-protocol.mjs'
import { GatewayClientProtocolSession } from '../server/src/transport/gateway-client-protocol-session.mjs'

function ids() {
  let value = 0
  return () => `evt_gateway_${++value}`
}

test('publishes a frozen capability vocabulary without advertising future stages', () => {
  assert.equal(GATEWAY_CLIENT_PROTOCOL_VERSION, '6.0.0')
  assert.equal(Object.isFrozen(GATEWAY_CLIENT_KNOWN_CAPABILITIES), true)
  assert.equal(Object.isFrozen(GATEWAY_CLIENT_IMPLEMENTED_CAPABILITIES), true)
  assert.ok(GATEWAY_CLIENT_KNOWN_CAPABILITIES.includes(GatewayClientCapability.CLIENT_EVENTS))
  assert.ok(GATEWAY_CLIENT_KNOWN_CAPABILITIES.includes(
    GatewayClientCapability.CLIENT_ACTION_ENTER_SLEEP,
  ))
  assert.ok(GATEWAY_CLIENT_KNOWN_CAPABILITIES.includes(GatewayClientCapability.SESSION_REPLAY))
  assert.equal(
    GATEWAY_CLIENT_IMPLEMENTED_CAPABILITIES.includes(GatewayClientCapability.CLIENT_EVENTS),
    false,
  )
  assert.equal(
    GATEWAY_CLIENT_IMPLEMENTED_CAPABILITIES.includes(
      GatewayClientCapability.CLIENT_ACTION_ENTER_SLEEP,
    ),
    false,
  )
})

test('validates the 6.0 envelope and rejects duplicate capabilities', () => {
  assert.equal(GatewayClientEnvelopeSchema.safeParse({
    type: 'response.cancel',
    event_id: 'evt_client_1',
  }).success, true)
  assert.equal(GatewayClientEnvelopeSchema.safeParse({
    type: 'response.cancel',
  }).success, false)

  const hello = createGatewaySessionHello({
    eventId: 'evt_client_hello',
    clientInstanceId: 'desktop_1',
    capabilities: [
      GatewayClientCapability.INPUT_TEXT,
      GatewayClientCapability.CLIENT_ACTION_ENTER_SLEEP,
    ],
  })
  assert.equal(GatewaySessionHelloSchema.safeParse(hello).success, true)
  assert.equal(GatewaySessionHelloSchema.safeParse({
    ...hello,
    capabilities: [
      GatewayClientCapability.INPUT_TEXT,
      GatewayClientCapability.INPUT_TEXT,
    ],
  }).success, false)
})

test('negotiates one supported 6.0 version and the capability intersection', () => {
  assert.equal(supportsGatewayClientProtocol({ min: '6.0.0', max: '6.0.0' }), true)
  assert.equal(supportsGatewayClientProtocol({ min: '5.9.0', max: '6.1.0' }), true)
  assert.equal(supportsGatewayClientProtocol({ min: '5.0.0', max: '5.9.9' }), false)
  assert.equal(supportsGatewayClientProtocol({ min: '6.1.0', max: '7.0.0' }), false)

  assert.deepEqual(negotiateGatewayClientCapabilities([
    GatewayClientCapability.CLIENT_EVENTS,
    GatewayClientCapability.INPUT_TEXT,
    GatewayClientCapability.INPUT_TEXT,
  ]), [GatewayClientCapability.INPUT_TEXT])
})

test('normalizes 6.0 event names into the existing business event vocabulary', () => {
  assert.deepEqual(normalizeGatewayClientProtocolMessage({
    type: GatewayClientProtocolEvent.INPUT_AUDIO_APPEND,
    event_id: 'evt_client_audio',
    audio: 'YQ==',
  }), {
    type: 'audio.append',
    event_id: 'evt_client_audio',
    audio: 'YQ==',
  })
  assert.deepEqual(normalizeGatewayClientProtocolMessage({
    type: GatewayClientProtocolEvent.CONVERSATION_ITEM_CREATE,
    event_id: 'evt_client_text',
    parts: [{ type: 'text', text: '你好' }],
  }).parts, [{ type: 'text', text: '你好' }])
  assert.equal(normalizeGatewayClientProtocolMessage({
    type: GatewayClientProtocolEvent.RESPONSE_CANCEL,
    event_id: 'evt_client_cancel',
  }).type, 'interrupt')
  assert.throws(() => normalizeGatewayClientProtocolMessage({
    type: 'provider.native.event',
    event_id: 'evt_client_unknown',
  }), error => error.code === 'unknown_type')
})

test('6.0 hello and 5.x connect enter the same legacy business path', () => {
  const pendingEvent = { type: 'voice.state', state: 'idle' }
  const modern = new GatewayClientProtocolSession({
    sessionId: 'voice-modern',
    createEventId: ids(),
  })
  assert.equal(modern.encode(pendingEvent), null)

  const hello = createGatewaySessionHello({
    eventId: 'evt_client_hello',
    clientType: 'desktop',
    clientInstanceId: 'desktop_1',
    clientLabel: 'Desktop',
    locale: 'zh-CN',
    timeZone: 'Asia/Shanghai',
    capabilities: [
      GatewayClientCapability.INPUT_AUDIO,
      GatewayClientCapability.INPUT_TEXT,
      GatewayClientCapability.CLIENT_EVENTS,
    ],
  })
  const accepted = modern.receive(hello)
  assert.equal(accepted.event.type, 'connect')
  assert.equal(accepted.event.clientType, 'desktop')
  assert.equal(accepted.event.inputEnabled, true)
  assert.equal(accepted.event.outputEnabled, true)
  assert.equal(accepted.event.textOnly, false)
  assert.deepEqual(accepted.reply.capabilities, [
    GatewayClientCapability.INPUT_AUDIO,
    GatewayClientCapability.INPUT_TEXT,
  ])
  assert.equal(accepted.reply.request_event_id, 'evt_client_hello')
  assert.deepEqual(accepted.pending, [pendingEvent])
  assert.equal(parseGatewayServerProtocolMessage(accepted.reply).type, 'session.ready')
  assert.match(modern.encode(pendingEvent).event_id, /^evt_gateway_/)

  const legacy = new GatewayClientProtocolSession({
    sessionId: 'voice-legacy',
    createEventId: ids(),
  })
  assert.equal(legacy.encode(pendingEvent), null)
  const connected = legacy.receive({
    type: 'connect',
    clientType: 'desktop',
    voiceEnabled: true,
  })
  assert.equal(connected.event.type, accepted.event.type)
  assert.equal(connected.reply, undefined)
  assert.deepEqual(connected.pending, [pendingEvent])
  assert.equal(legacy.encode(pendingEvent), pendingEvent)
})

test('returns correlated 6.0 errors and closes unsupported negotiations', () => {
  const unsupported = new GatewayClientProtocolSession({
    sessionId: 'voice-unsupported',
    createEventId: ids(),
  }).receive(createGatewaySessionHello({
    eventId: 'evt_client_unsupported',
    protocolMin: '7.0.0',
    protocolMax: '7.0.0',
    clientInstanceId: 'client_7',
  }))
  assert.equal(unsupported.close, true)
  assert.equal(unsupported.reply.request_event_id, 'evt_client_unsupported')
  assert.equal(unsupported.reply.error.code, 'protocol_version_unsupported')

  const session = new GatewayClientProtocolSession({
    sessionId: 'voice-errors',
    createEventId: ids(),
  })
  session.receive(createGatewaySessionHello({
    eventId: 'evt_client_hello',
    clientInstanceId: 'client_1',
  }))
  const unknown = session.receive(createGatewayClientProtocolMessage(
    'provider.native.event',
    {},
    { eventId: 'evt_client_unknown' },
  ))
  assert.equal(unknown.close, false)
  assert.equal(unknown.reply.request_event_id, 'evt_client_unknown')
  assert.equal(unknown.reply.error.code, 'unknown_type')
})

test('preserves the legacy silent-ignore behavior for malformed messages', () => {
  const session = new GatewayClientProtocolSession({ sessionId: 'legacy' })
  assert.equal(session.receive({ type: 'not-a-real-event' }).event, null)
  assert.equal(session.mode, 'pending')
})

test('bounds server events held while the client has not selected a protocol', () => {
  const session = new GatewayClientProtocolSession({
    sessionId: 'slow-client',
    maxPendingServerEvents: 2,
  })
  session.encode({ type: 'voice.state', state: 'idle' })
  session.encode({ type: 'voice.state', state: 'listening' })
  session.encode({ type: 'voice.state', state: 'processing' })

  const connected = session.receive({ type: 'connect', clientType: 'web' })
  assert.deepEqual(connected.pending, [
    { type: 'voice.state', state: 'listening' },
    { type: 'voice.state', state: 'processing' },
  ])
})
