import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import WebSocket from 'ws'
import {
  GatewayClientCapability,
  createGatewaySessionHello,
} from '../../shared/gateway-client-protocol.mjs'
import { attachRealtimeGateway } from '../src/voice/realtime-gateway.mjs'

function gatewayHarness() {
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
    capabilities: [GatewayClientCapability.INPUT_TEXT],
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
