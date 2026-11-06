import assert from 'node:assert/strict'
import test from 'node:test'
import { once } from 'node:events'
import { WebSocketServer } from 'ws'
import { RealtimeFrontend, REALTIME_PROVIDERS } from '../src/voice/realtime-provider.mjs'

test('late callbacks on the actual old socket cannot mutate a newer connection', async t => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await once(server, 'listening')
  const peers = [], events = [], errors = [], closes = []
  server.on('connection', socket => {
    peers.push(socket)
    socket.on('message', raw => {
      if (JSON.parse(raw).type === 'session.update') socket.send(JSON.stringify({ type: 'session.updated' }))
    })
    socket.send(JSON.stringify({ type: 'session.created' }))
  })
  const frontend = new RealtimeFrontend({ provider: {
    ...REALTIME_PROVIDERS.dashscope, isConfigured: () => true,
    url: () => `ws://127.0.0.1:${server.address().port}`, headers: () => ({}),
  }, onEvent: event => events.push(event), onError: error => errors.push(error), onClose: () => closes.push(true) })
  const sockets = []
  t.after(async () => {
    frontend.close()
    for (const socket of sockets) socket.terminate()
    for (const socket of peers) socket.terminate()
    await new Promise(resolve => server.close(resolve))
  })
  await frontend.connect()
  const oldSocket = frontend.ws
  sockets.push(oldSocket)
  const oldGeneration = frontend.transportGeneration
  frontend.resetResponses()
  // The replacement transport starts a new handshake; old callbacks may still
  // be queued even though the previous transport has been detached logically.
  frontend.ready = false
  frontend.sessionConfigured = false
  await frontend.connect()
  sockets.push(frontend.ws)
  assert.notEqual(frontend.ws, oldSocket)
  assert.equal(frontend.transportGeneration, oldGeneration + 1)
  frontend.handleLifecycle({ type: 'response.created', response: { id: 'current' } })
  const seen = events.length
  oldSocket.emit('message', Buffer.from(JSON.stringify({ type: 'response.audio_transcript.delta', response_id: 'old', delta: 'late' })))
  oldSocket.emit('error', new Error('stale socket error'))
  oldSocket.emit('close', 1000, Buffer.alloc(0))
  assert.equal(frontend.ready, true)
  assert.equal(events.length, seen)
  assert.deepEqual(errors, [])
  assert.deepEqual(closes, [])
  assert.deepEqual([...frontend.activeResponses], ['current'])
})
