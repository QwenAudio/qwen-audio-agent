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
  gatewayClientProtocolCapabilityFor,
  negotiateGatewayClientCapabilities,
  normalizeGatewayClientProtocolMessage,
  parseGatewayClientProtocolMessage,
  parseGatewayServerProtocolMessage,
  supportsGatewayClientProtocol,
} from '../shared/gateway-client-protocol.mjs'
import { GatewayClientProtocolSession } from '../server/src/transport/gateway-client-protocol-session.mjs'

function ids() {
  let value = 0
  return () => `evt_gateway_${++value}`
}

test('publishes a frozen capability vocabulary and only advertises implemented stages', () => {
  assert.equal(GATEWAY_CLIENT_PROTOCOL_VERSION, '6.0.0')
  assert.equal(Object.isFrozen(GATEWAY_CLIENT_KNOWN_CAPABILITIES), true)
  assert.equal(Object.isFrozen(GATEWAY_CLIENT_IMPLEMENTED_CAPABILITIES), true)
  assert.ok(GATEWAY_CLIENT_KNOWN_CAPABILITIES.includes(GatewayClientCapability.CLIENT_EVENTS))
  assert.ok(GATEWAY_CLIENT_KNOWN_CAPABILITIES.includes(
    GatewayClientCapability.CLIENT_ACTION_ENTER_SLEEP,
  ))
  assert.ok(GATEWAY_CLIENT_KNOWN_CAPABILITIES.includes(GatewayClientCapability.SESSION_REPLAY))
  assert.ok(GATEWAY_CLIENT_KNOWN_CAPABILITIES.includes(
    GatewayClientCapability.SESSION_OUTPUT_VOICE,
  ))
  assert.equal(
    GATEWAY_CLIENT_IMPLEMENTED_CAPABILITIES.includes(GatewayClientCapability.CLIENT_EVENTS),
    true,
  )
  assert.equal(
    GATEWAY_CLIENT_IMPLEMENTED_CAPABILITIES.includes(
      GatewayClientCapability.CLIENT_ACTION_ENTER_SLEEP,
    ),
    true,
  )
  assert.equal(
    GATEWAY_CLIENT_IMPLEMENTED_CAPABILITIES.includes(
      GatewayClientCapability.SESSION_REPLAY,
    ),
    true,
  )
  assert.equal(
    GATEWAY_CLIENT_IMPLEMENTED_CAPABILITIES.includes(
      GatewayClientCapability.SESSION_OUTPUT_VOICE,
    ),
    true,
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
  ]), [
    GatewayClientCapability.CLIENT_EVENTS,
    GatewayClientCapability.INPUT_TEXT,
  ])
})

test('validates runtime commands, Client Actions and correlated results', () => {
  const create = parseGatewayClientProtocolMessage({
    type: GatewayClientProtocolEvent.TASK_CREATE,
    event_id: 'evt_create_1',
    message: { parts: [{ type: 'text', text: '查询本机内存' }] },
  })
  assert.equal(create.message.parts[0].text, '查询本机内存')
  assert.equal(
    gatewayClientProtocolCapabilityFor(create.type),
    GatewayClientCapability.TASK_COMMANDS,
  )

  const permission = parseGatewayClientProtocolMessage({
    type: GatewayClientProtocolEvent.PERMISSION_RESPOND,
    event_id: 'evt_permission_once',
    permission_id: 'permission_1',
    decision: 'once',
  })
  assert.equal(permission.decision, 'once')
  assert.throws(() => parseGatewayClientProtocolMessage({
    ...permission,
    decision: 'reject_always',
  }))

  const published = parseGatewayClientProtocolMessage({
    type: GatewayClientProtocolEvent.CLIENT_EVENT_PUBLISH,
    event_id: 'evt_presence_1',
    name: 'desktop.presence.sleep_requested',
    data: { reason: 'idle' },
    delivery_hint: 'context',
  })
  assert.equal(published.name, 'desktop.presence.sleep_requested')

  const result = parseGatewayServerProtocolMessage({
    type: GatewayClientProtocolEvent.CLIENT_EVENT_PUBLISH_RESULT,
    event_id: 'evt_gateway_1',
    request_event_id: 'evt_presence_1',
    accepted: true,
    name: 'desktop.presence.sleep_requested',
  })
  assert.equal(result.request_event_id, 'evt_presence_1')

  const action = parseGatewayServerProtocolMessage({
    type: GatewayClientProtocolEvent.CLIENT_ACTION_REQUEST,
    event_id: 'evt_gateway_action_1',
    name: 'desktop.presence.enter_sleep',
    arguments: {},
  })
  assert.equal(action.name, 'desktop.presence.enter_sleep')
  const actionResult = parseGatewayClientProtocolMessage({
    type: GatewayClientProtocolEvent.CLIENT_ACTION_RESULT,
    event_id: 'evt_client_action_1',
    request_event_id: action.event_id,
    status: 'completed',
    output: { state: 'hidden' },
  })
  assert.equal(actionResult.request_event_id, action.event_id)
  assert.equal(
    gatewayClientProtocolCapabilityFor(actionResult.type),
    GatewayClientCapability.CLIENT_ACTION_ENTER_SLEEP,
  )
  assert.throws(() => parseGatewayClientProtocolMessage({
    type: GatewayClientProtocolEvent.CLIENT_ACTION_RESULT,
    event_id: 'evt_client_action_failed',
    request_event_id: action.event_id,
    status: 'failed',
  }))

  const replay = parseGatewayClientProtocolMessage({
    type: GatewayClientProtocolEvent.SESSION_REPLAY,
    event_id: 'evt_client_replay',
    after_sequence: 12,
    limit: 200,
  })
  assert.equal(replay.after_sequence, 12)
  assert.equal(
    gatewayClientProtocolCapabilityFor(replay.type),
    GatewayClientCapability.SESSION_REPLAY,
  )
  assert.throws(() => parseGatewayClientProtocolMessage({
    type: GatewayClientProtocolEvent.SESSION_REPLAY,
    event_id: 'evt_client_replay_unbounded',
    after_sequence: 0,
    limit: 201,
  }))

  const voiceUpdate = parseGatewayClientProtocolMessage({
    type: GatewayClientProtocolEvent.SESSION_OUTPUT_VOICE_UPDATE,
    event_id: 'evt_client_output_voice',
    voice: 'longanlufeng',
  })
  assert.equal(voiceUpdate.voice, 'longanlufeng')
  assert.equal(
    gatewayClientProtocolCapabilityFor(voiceUpdate.type),
    GatewayClientCapability.SESSION_OUTPUT_VOICE,
  )
  const voiceUpdated = parseGatewayServerProtocolMessage({
    type: GatewayClientProtocolEvent.SESSION_OUTPUT_VOICE_UPDATED,
    event_id: 'evt_gateway_output_voice',
    request_event_id: voiceUpdate.event_id,
    voice: 'longanlufeng',
    changed: true,
    reconnecting: true,
  })
  assert.equal(voiceUpdated.request_event_id, voiceUpdate.event_id)
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
    connection: {
      voice_enabled: true,
      input_enabled: false,
      output_enabled: true,
      text_only: false,
      provider: 'dashscope',
      output_voice: 'longanlufeng',
      working_directory: '/tmp/client-project',
      client_states: ['active'],
    },
  })
  const accepted = modern.receive(hello)
  assert.equal(accepted.event.type, 'connect')
  assert.equal(accepted.event.clientType, 'desktop')
  assert.equal(accepted.event.inputEnabled, false)
  assert.equal(accepted.event.outputEnabled, true)
  assert.equal(accepted.event.textOnly, false)
  assert.equal(accepted.event.provider, 'dashscope')
  assert.equal(accepted.event.outputVoice, 'longanlufeng')
  assert.equal(accepted.event.workingDirectory, '/tmp/client-project')
  assert.deepEqual(accepted.event.clientStates, ['active'])
  assert.deepEqual(accepted.reply.capabilities, [
    GatewayClientCapability.INPUT_AUDIO,
    GatewayClientCapability.INPUT_TEXT,
    GatewayClientCapability.CLIENT_EVENTS,
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
  const legacyActionResult = legacy.receive({
    type: GatewayClientProtocolEvent.CLIENT_ACTION_RESULT,
    event_id: 'evt_client_legacy_action',
    request_event_id: 'evt_gateway_legacy_action',
    status: 'completed',
  })
  assert.equal(
    legacyActionResult.runtimeMessage.type,
    GatewayClientProtocolEvent.CLIENT_ACTION_RESULT,
  )
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

test('requires runtime capabilities to be negotiated before accepting commands', () => {
  const session = new GatewayClientProtocolSession({
    sessionId: 'runtime-capabilities',
    createEventId: ids(),
  })
  session.receive(createGatewaySessionHello({
    eventId: 'evt-client-hello',
    clientInstanceId: 'client-1',
    capabilities: [GatewayClientCapability.INPUT_TEXT],
  }))
  const rejected = session.receive({
    type: GatewayClientProtocolEvent.TASK_LIST,
    event_id: 'evt-client-list',
  })
  assert.equal(rejected.runtimeMessage, undefined)
  assert.equal(rejected.reply.request_event_id, 'evt-client-list')
  assert.equal(rejected.reply.error.code, 'capability_not_negotiated')
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
