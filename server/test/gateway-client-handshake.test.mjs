import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import WebSocket from 'ws'
import {
  GatewayClientCapability,
  GatewayClientProtocolEvent,
  createGatewaySessionHello,
} from '../../shared/gateway-client-protocol.mjs'
import {
  ClientEventDefinitionRegistry,
  GatewayEventRouter,
} from '../src/client/client-event-router.mjs'
import { attachRealtimeGateway } from '../src/voice/realtime-gateway.mjs'

function gatewayHarness(overrides = {}) {
  const server = createServer()
  const gateway = attachRealtimeGateway(server, {
    identityManager: {
      resolveUpgrade: () => ({ ownerId: 'owner-protocol-test' }),
    },
    memoryService: { list: () => [] },
    notesStore: null,
    backendRuntime: null,
    backendAvailability: {
      snapshot: () => ({ configured: false, ok: false, known: true }),
    },
    respondAuthorization: async () => ({}),
    permissionPolicy: {
      resolveDecision: () => null,
      rememberDecision: () => {},
    },
    ...overrides,
  })
  return { server, gateway }
}

async function connect(server, firstMessage) {
  const { port } = server.address()
  const socket = new WebSocket(
    `ws://127.0.0.1:${port}/api/realtime?sessionId=protocol-test`,
  )
  const received = []
  socket.on('message', raw => received.push(JSON.parse(raw.toString())))
  await new Promise((resolve, reject) => {
    socket.once('error', reject)
    socket.once('open', () => {
      socket.send(JSON.stringify(firstMessage))
      resolve()
    })
  })
  return { socket, received }
}

async function waitFor(received, predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    const event = received.find(predicate)
    if (event) return event
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`Gateway event was not received: ${JSON.stringify(received)}`)
}

async function waitUntil(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('Gateway condition was not met')
}

test('a muted voice-capable client can claim voice after unmute', async t => {
  const { server, gateway } = gatewayHarness()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    await gateway.close()
    await new Promise(resolve => server.close(resolve))
  })

  const client = await connect(server, {
    type: 'connect',
    clientType: 'web',
    voiceEnabled: false,
    inputEnabled: false,
    outputEnabled: false,
    textOnly: false,
  })
  await waitFor(client.received, event => event.type === 'voice.state')
  assert.equal(gateway.status().activeOwners, 0)

  client.socket.send(JSON.stringify({ type: 'unmute' }))
  await waitUntil(() => gateway.status().activeOwners === 1)
  client.socket.close()
})

test('recovers the client and excludes only the content-safety rejected turn', async t => {
  const frontends = []
  const realtimeFrontendFactory = options => {
    const provider = options.providerRegistry.resolve(options.providerName)
    const frontend = {
      provider,
      capabilities: provider.capabilities,
      ready: false,
      inputs: [],
      connect: async () => {
        frontend.ready = true
      },
      close: () => {
        frontend.ready = false
      },
      appendAudio: () => {},
      cancel: () => {},
      updateAgentContext: () => {},
      ensureResponse: async () => {},
      injectContext: async () => {},
      whenIdle: async () => {},
      sendUserInput: async (parts, context) => {
        frontend.inputs.push({ parts, context })
        return {}
      },
      emit: event => options.onEvent(event),
    }
    frontends.push({ frontend, agentContext: options.agentContext })
    return frontend
  }
  const { server, gateway } = gatewayHarness({ realtimeFrontendFactory })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    await gateway.close()
    await new Promise(resolve => server.close(resolve))
  })

  const client = await connect(server, {
    type: 'connect',
    clientType: 'web',
    voiceEnabled: true,
    inputEnabled: true,
    outputEnabled: true,
    textOnly: false,
  })
  await waitFor(client.received, event => event.type === 'voice.ready')

  client.socket.send(JSON.stringify({ type: 'text.message', text: '正常问题' }))
  await waitUntil(() => frontends[0].frontend.inputs.length === 1)
  client.socket.send(JSON.stringify({ type: 'text.message', text: '违规问题' }))
  await waitUntil(() => frontends[0].frontend.inputs.length === 2)
  const rejectedContext = frontends[0].frontend.inputs[1].context

  frontends[0].frontend.emit({
    type: 'response.created',
    response: { id: 'response-rejected' },
    __voiceContext: rejectedContext,
  })
  frontends[0].frontend.emit({
    type: 'error',
    response_id: 'response-rejected',
    error: {
      code: 'DataInspectionFailed',
      message: 'Input data may contain inappropriate content.',
    },
  })

  const clear = await waitFor(
    client.received,
    event => event.type === 'playback.clear'
      && event.reason === 'provider_content_safety',
  )
  assert.equal(clear.reason, 'provider_content_safety')
  await waitFor(
    client.received,
    event => event.type === 'voice.state' && event.state === 'idle',
  )
  await waitUntil(() => frontends.length === 2)
  assert.deepEqual(
    frontends[1].agentContext.recentMessages.map(message => message.content),
    ['正常问题'],
  )
  client.socket.close()
})

test('5.x connect and 6.0 session.hello share one Gateway business path', async t => {
  const { server, gateway } = gatewayHarness()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    await gateway.close()
    await new Promise(resolve => server.close(resolve))
  })

  const legacy = await connect(server, {
    type: 'connect',
    clientType: 'web',
    textOnly: true,
    inputEnabled: false,
    outputEnabled: false,
  })
  await waitFor(legacy.received, event => event.type === 'voice.state')
  assert.equal(legacy.received.some(event => event.type === 'session.ready'), false)
  assert.equal(legacy.received.some(event => 'event_id' in event), false)
  legacy.socket.close()
  await new Promise(resolve => legacy.socket.once('close', resolve))

  const modern = await connect(server, createGatewaySessionHello({
    eventId: 'evt_client_hello',
    clientType: 'web',
    clientInstanceId: 'web_protocol_test',
    capabilities: [
      GatewayClientCapability.INPUT_TEXT,
      GatewayClientCapability.CLIENT_EVENTS,
      GatewayClientCapability.TASK_COMMANDS,
    ],
  }))
  const ready = await waitFor(modern.received, event => event.type === 'session.ready')
  assert.equal(ready.request_event_id, 'evt_client_hello')
  assert.equal(ready.protocol_version, '6.0.0')
  assert.deepEqual(ready.capabilities, [GatewayClientCapability.INPUT_TEXT])

  const state = await waitFor(modern.received, event => event.type === 'voice.state')
  assert.match(state.event_id, /^evt_gateway_/)
  assert.equal(modern.received[0].type, 'session.ready')
  modern.socket.close()
})

test('routes negotiated GCP2 commands and Client Events with correlated results', async t => {
  const commands = []
  const routed = []
  const registry = new ClientEventDefinitionRegistry()
  const definition = registry.get('desktop.presence.sleep_requested')
  registry.definitions.set(definition.name, Object.freeze({
    ...definition,
    handle: event => routed.push(event),
  }))
  const { server, gateway } = gatewayHarness({
    clientEventRouter: new GatewayEventRouter({ registry }),
    clientCommandRuntime: {
      async execute(message, context) {
        commands.push({ message, context })
        return {
          type: GatewayClientProtocolEvent.CONVERSATION_HISTORY_RESULT,
          request_event_id: message.event_id,
          messages: [],
        }
      },
    },
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    await gateway.close()
    await new Promise(resolve => server.close(resolve))
  })

  const modern = await connect(server, createGatewaySessionHello({
    eventId: 'evt-client-hello',
    clientType: 'desktop',
    clientInstanceId: 'desktop-runtime-test',
    capabilities: [
      GatewayClientCapability.CLIENT_EVENTS,
      GatewayClientCapability.CONVERSATION_HISTORY,
    ],
  }))
  await waitFor(modern.received, event => event.type === 'session.ready')

  modern.socket.send(JSON.stringify({
    type: GatewayClientProtocolEvent.CLIENT_EVENT_PUBLISH,
    event_id: 'evt-client-sleep',
    name: 'desktop.presence.sleep_requested',
    data: { reason: 'idle' },
  }))
  const eventResult = await waitFor(
    modern.received,
    event => event.request_event_id === 'evt-client-sleep',
  )
  assert.equal(eventResult.type, GatewayClientProtocolEvent.CLIENT_EVENT_PUBLISH_RESULT)
  assert.equal(eventResult.accepted, true)
  assert.equal(routed[0].source.ownerId, 'owner-protocol-test')
  assert.equal(routed[0].source.clientInstanceId, 'desktop-runtime-test')

  modern.socket.send(JSON.stringify({
    type: GatewayClientProtocolEvent.CONVERSATION_HISTORY,
    event_id: 'evt-client-history',
  }))
  const history = await waitFor(
    modern.received,
    event => event.request_event_id === 'evt-client-history',
  )
  assert.equal(history.type, GatewayClientProtocolEvent.CONVERSATION_HISTORY_RESULT)
  assert.equal(commands[0].context.sessionId, 'protocol-test')
  modern.socket.close()
})

test('updates the session output voice through the negotiated GCP command', async t => {
  const { server, gateway } = gatewayHarness()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    await gateway.close()
    await new Promise(resolve => server.close(resolve))
  })

  const modern = await connect(server, createGatewaySessionHello({
    eventId: 'evt-client-output-voice-hello',
    clientType: 'web',
    clientInstanceId: 'web-output-voice-test',
    capabilities: [GatewayClientCapability.SESSION_OUTPUT_VOICE],
    connection: {
      input_enabled: false,
      output_enabled: false,
      text_only: true,
      output_voice: 'longanqian',
    },
  }))
  const ready = await waitFor(modern.received, event => event.type === 'session.ready')
  assert.deepEqual(ready.capabilities, [GatewayClientCapability.SESSION_OUTPUT_VOICE])

  modern.socket.send(JSON.stringify({
    type: GatewayClientProtocolEvent.SESSION_OUTPUT_VOICE_UPDATE,
    event_id: 'evt-client-output-voice-update',
    voice: 'longanlufeng',
  }))
  const updated = await waitFor(
    modern.received,
    event => event.request_event_id === 'evt-client-output-voice-update',
  )
  assert.equal(updated.type, GatewayClientProtocolEvent.SESSION_OUTPUT_VOICE_UPDATED)
  assert.equal(updated.voice, 'longanlufeng')
  assert.equal(updated.changed, true)
  assert.equal(updated.reconnecting, false)

  modern.socket.send(JSON.stringify({
    type: GatewayClientProtocolEvent.SESSION_OUTPUT_VOICE_UPDATE,
    event_id: 'evt-client-output-voice-same',
    voice: 'longanlufeng',
  }))
  const unchanged = await waitFor(
    modern.received,
    event => event.request_event_id === 'evt-client-output-voice-same',
  )
  assert.equal(unchanged.changed, false)
  assert.equal(unchanged.reconnecting, false)
  modern.socket.close()
})

test('returns a correlated error when the active Provider cannot select a voice', async t => {
  const { server, gateway } = gatewayHarness({
    defaultRealtimeProvider: 'speech-to-speech',
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    await gateway.close()
    await new Promise(resolve => server.close(resolve))
  })

  const modern = await connect(server, createGatewaySessionHello({
    eventId: 'evt-client-unsupported-voice-hello',
    clientType: 'web',
    clientInstanceId: 'web-unsupported-voice-test',
    capabilities: [GatewayClientCapability.SESSION_OUTPUT_VOICE],
    connection: {
      input_enabled: false,
      output_enabled: false,
      text_only: true,
    },
  }))
  await waitFor(modern.received, event => event.type === 'session.ready')

  modern.socket.send(JSON.stringify({
    type: GatewayClientProtocolEvent.SESSION_OUTPUT_VOICE_UPDATE,
    event_id: 'evt-client-unsupported-voice-update',
    voice: 'longanqian',
  }))
  const error = await waitFor(
    modern.received,
    event => event.request_event_id === 'evt-client-unsupported-voice-update',
  )
  assert.equal(error.type, 'error')
  assert.equal(error.error.code, 'output_voice_unsupported')
  modern.socket.close()
})

test('commits sleep only after the negotiated Client Action completes', async t => {
  const { server, gateway } = gatewayHarness()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    await gateway.close()
    await new Promise(resolve => server.close(resolve))
  })

  const modern = await connect(server, createGatewaySessionHello({
    eventId: 'evt-client-action-hello',
    clientType: 'desktop',
    clientInstanceId: 'desktop-action-test',
    capabilities: [GatewayClientCapability.CLIENT_ACTION_ENTER_SLEEP],
  }))
  const ready = await waitFor(modern.received, event => event.type === 'session.ready')
  assert.deepEqual(ready.capabilities, [
    GatewayClientCapability.CLIENT_ACTION_ENTER_SLEEP,
  ])

  modern.socket.send(JSON.stringify({
    type: 'sleep',
    event_id: 'evt-client-sleep-command',
  }))
  const action = await waitFor(
    modern.received,
    event => event.type === GatewayClientProtocolEvent.CLIENT_ACTION_REQUEST,
  )
  assert.equal(action.name, 'desktop.presence.enter_sleep')
  assert.equal(modern.received.some(event => (
    event.type === 'voice.sleep' && event.state === 'sleeping'
  )), false)

  modern.socket.send(JSON.stringify({
    type: GatewayClientProtocolEvent.CLIENT_ACTION_RESULT,
    event_id: 'evt-client-action-result',
    request_event_id: action.event_id,
    status: 'completed',
    output: { state: 'hidden' },
  }))
  await waitFor(modern.received, event => (
    event.type === 'voice.sleep' && event.state === 'sleeping'
  ))
  assert.equal(modern.received.some(event => (
    event.type === 'voice.connection' && event.state === 'sleeping'
  )), false)
  modern.socket.close()
})

test('client inactivity enters sleep without asking the model to call a tool', async t => {
  const { server, gateway } = gatewayHarness({
    clientEventRouter: new GatewayEventRouter(),
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    await gateway.close()
    await new Promise(resolve => server.close(resolve))
  })

  const modern = await connect(server, createGatewaySessionHello({
    eventId: 'evt-auto-sleep-hello',
    clientType: 'desktop',
    clientInstanceId: 'desktop-auto-sleep-test',
    capabilities: [
      GatewayClientCapability.CLIENT_EVENTS,
      GatewayClientCapability.CLIENT_ACTION_ENTER_SLEEP,
    ],
  }))
  await waitFor(modern.received, event => event.type === 'session.ready')

  modern.socket.send(JSON.stringify({
    type: GatewayClientProtocolEvent.CLIENT_EVENT_PUBLISH,
    event_id: 'evt-client-inactivity',
    name: 'desktop.presence.sleep_requested',
    data: { idle_ms: 60_000 },
  }))
  const published = await waitFor(
    modern.received,
    event => event.request_event_id === 'evt-client-inactivity',
  )
  assert.equal(published.accepted, true)

  const action = await waitFor(
    modern.received,
    event => event.type === GatewayClientProtocolEvent.CLIENT_ACTION_REQUEST,
  )
  assert.equal(action.name, 'desktop.presence.enter_sleep')
  modern.socket.send(JSON.stringify({
    type: GatewayClientProtocolEvent.CLIENT_ACTION_RESULT,
    event_id: 'evt-auto-sleep-result',
    request_event_id: action.event_id,
    status: 'completed',
    output: { state: 'hidden' },
  }))
  await waitFor(modern.received, event => (
    event.type === 'voice.sleep' && event.state === 'sleeping'
  ))
  assert.equal(modern.received.some(event => (
    event.type === 'voice.connection' && event.state === 'sleeping'
  )), false)
  modern.socket.close()
})

test('rejects unnegotiated GCP2 commands before dispatch', async t => {
  const { server, gateway } = gatewayHarness({
    clientCommandRuntime: {
      execute() {
        throw new Error('must not dispatch')
      },
    },
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    await gateway.close()
    await new Promise(resolve => server.close(resolve))
  })
  const modern = await connect(server, createGatewaySessionHello({
    eventId: 'evt-client-hello',
    clientInstanceId: 'web-runtime-test',
    capabilities: [GatewayClientCapability.INPUT_TEXT],
  }))
  await waitFor(modern.received, event => event.type === 'session.ready')
  modern.socket.send(JSON.stringify({
    type: GatewayClientProtocolEvent.PERMISSION_RESPOND,
    event_id: 'evt-client-permission',
    permission_id: 'permission-1',
    decision: 'always',
  }))
  const error = await waitFor(
    modern.received,
    event => event.request_event_id === 'evt-client-permission',
  )
  assert.equal(error.type, 'error')
  assert.equal(error.error.code, 'capability_not_negotiated')
  modern.socket.close()
})

test('allows only one active Gateway Client connection', async t => {
  const { server, gateway } = gatewayHarness()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    await gateway.close()
    await new Promise(resolve => server.close(resolve))
  })
  const first = await connect(server, createGatewaySessionHello({
    eventId: 'evt-first-hello',
    clientInstanceId: 'first-client',
    capabilities: [GatewayClientCapability.INPUT_TEXT],
  }))
  await waitFor(first.received, event => event.type === 'session.ready')

  const second = await connect(server, createGatewaySessionHello({
    eventId: 'evt-second-hello',
    clientInstanceId: 'second-client',
    capabilities: [GatewayClientCapability.INPUT_TEXT],
  }))
  const occupied = await waitFor(
    second.received,
    event => event.error?.code === 'client_occupied',
  )
  assert.equal(occupied.type, 'error')
  await new Promise(resolve => second.socket.once('close', resolve))
  assert.equal(first.socket.readyState, WebSocket.OPEN)
  first.socket.close()
})
