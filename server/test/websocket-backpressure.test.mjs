import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import {
  sendBoundedWebSocket,
  WEBSOCKET_AUDIO_BUFFER_LIMIT,
  WEBSOCKET_CONTROL_BUFFER_LIMIT,
  WEBSOCKET_MESSAGE_LIMIT,
} from '../src/core/websocket-send.mjs'
import { RealtimeFrontend, REALTIME_PROVIDERS } from '../src/voice/realtime-provider.mjs'
import { attachGatewayClientTransport } from '../src/transport/gateway-client-transport.mjs'
import { createGatewaySessionHello } from '../../shared/protocol/gateway-client-protocol.mjs'

function socket() {
  return {
    readyState: 1, bufferedAmount: 0, sent: [], terminated: 0,
    send(data, callback) { this.sent.push(data); this.callback = callback },
    terminate() { this.terminated += 1; this.readyState = 3 },
  }
}

test('audio traffic remains ordered below the limit', () => {
  const ws = socket()
  assert.equal(sendBoundedWebSocket(ws, 'first', { audio: true }), true)
  assert.equal(sendBoundedWebSocket(ws, 'second', { audio: true }), true)
  assert.deepEqual(ws.sent, ['first', 'second'])
  assert.equal(ws.terminated, 0)
})

test('audio congestion terminates once rather than silently dropping chunks or adding a queue', () => {
  const ws = socket()
  const failures = []
  ws.bufferedAmount = WEBSOCKET_AUDIO_BUFFER_LIMIT
  for (let i = 0; i < 100; i += 1) {
    assert.equal(sendBoundedWebSocket(ws, 'audio', {
      audio: true, onFailure: event => failures.push(event),
    }), false)
  }
  assert.equal(ws.sent.length, 0)
  assert.equal(ws.terminated, 1)
  assert.equal(failures.length, 1)
  assert.equal(failures[0].code, 'websocket_backpressure')
  assert.equal(failures[0].bufferedBytes, WEBSOCKET_AUDIO_BUFFER_LIMIT)
})

test('control traffic has a separate budget but cannot accumulate indefinitely', () => {
  const ws = socket()
  ws.bufferedAmount = WEBSOCKET_AUDIO_BUFFER_LIMIT
  assert.equal(sendBoundedWebSocket(ws, 'permission'), true)
  ws.bufferedAmount = WEBSOCKET_CONTROL_BUFFER_LIMIT
  assert.equal(sendBoundedWebSocket(ws, 'permission'), false)
  assert.equal(ws.terminated, 1)
})

test('a valid large attachment can enter an empty queue, but cannot be followed by more data while congested', () => {
  const ws = socket()
  const attachment = 'x'.repeat(2 * WEBSOCKET_CONTROL_BUFFER_LIMIT)
  assert.equal(sendBoundedWebSocket(ws, attachment), true)
  ws.bufferedAmount = attachment.length
  assert.equal(sendBoundedWebSocket(ws, 'next'), false)
  assert.equal(ws.sent.length, 1)
  const oversized = socket()
  assert.equal(sendBoundedWebSocket(oversized, 'x'.repeat(WEBSOCKET_MESSAGE_LIMIT + 1)), false)
  assert.equal(oversized.terminated, 1)
})

test('send errors clean up the stream, including callback errors and throwing diagnostics', () => {
  for (const asynchronous of [false, true]) {
    const ws = socket()
    if (!asynchronous) ws.send = () => { throw new Error('socket failure') }
    sendBoundedWebSocket(ws, 'audio', { onFailure: () => { throw new Error('diagnostic failure') } })
    if (asynchronous) ws.callback(new Error('socket failure'))
    assert.equal(ws.terminated, 1)
    assert.equal(sendBoundedWebSocket(ws, 'next'), false)
  }
})

test('Realtime audio overflow resets pending work and a new connection can send normally', async () => {
  const diagnostics = []
  const frontend = new RealtimeFrontend({
    provider: REALTIME_PROVIDERS.qwen,
    onDiagnostic: event => diagnostics.push(event),
  })
  const ws = socket()
  frontend.ws = ws
  frontend.ready = true
  const pending = Promise.withResolvers()
  frontend.pendingResponses.push({ resolve: pending.resolve, settled: false })
  ws.bufferedAmount = WEBSOCKET_AUDIO_BUFFER_LIMIT
  frontend.appendAudio('AAAA')
  assert.equal(ws.terminated, 1)
  assert.equal(frontend.ready, false)
  assert.equal((await pending.promise).cancelled, true)
  assert.equal(frontend.pendingResponses.length, 0)
  assert.ok(diagnostics.some(event => event.event === 'realtime.send_failed'))

  const recovered = socket()
  frontend.ws = recovered
  frontend.ready = true
  frontend.appendAudio('BBBB')
  assert.equal(recovered.sent.length, 1)
  assert.equal(JSON.parse(recovered.sent[0]).audio, 'BBBB')
})

test('Gateway downstream overflow releases the client runtime and permits a fresh handshake', async t => {
  const logger = { info() {}, warn() {}, debug() {}, child() { return this } }
  let emit
  let closed = 0
  const transport = attachGatewayClientTransport(createServer(), {
    identityManager: {}, logger,
    frontendRuntime: {
      supportsImageInput: () => false,
      createSession: ({ send }) => {
        emit = send
        return {
          start() {}, handleClientEvent() {}, status: () => ({}),
          close() { closed += 1 },
        }
      },
    },
  })
  t.after(() => transport.close())
  function connect() {
    const ws = Object.assign(new EventEmitter(), socket())
    ws.close = () => { ws.readyState = 3; ws.emit('close', 1006, '') }
    ws.terminate = () => { ws.terminated += 1; ws.close() }
    transport.attachClient(ws, { identity: { ownerId: 'backpressure-test' } })
    ws.emit('message', Buffer.from(JSON.stringify(createGatewaySessionHello({ capabilities: [] }))))
    return ws
  }
  const slow = connect()
  slow.bufferedAmount = WEBSOCKET_AUDIO_BUFFER_LIMIT
  emit({ type: 'audio.delta', delta: 'AAAA' })
  assert.equal(slow.terminated, 1)
  assert.equal(closed, 1)
  const healthy = connect()
  assert.ok(healthy.sent.some(raw => JSON.parse(raw).type === 'session.ready'))
  emit({ type: 'audio.delta', delta: 'BBBB' })
  assert.equal(JSON.parse(healthy.sent.at(-1)).delta, 'BBBB')
})
