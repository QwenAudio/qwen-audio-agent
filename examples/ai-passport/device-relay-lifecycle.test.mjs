import assert from 'node:assert/strict'
import { once } from 'node:events'
import http from 'node:http'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { WebSocket, WebSocketServer } from 'ws'
import { GatewayClient } from '../../shared/gateway/client-sdk.mjs'
import {
  createGatewayClientProtocolMessage,
  parseGatewayClientProtocolMessage,
  parseGatewayServerProtocolMessage,
} from '../../shared/protocol/gateway-client-protocol.mjs'
import { createDeviceRelay } from './device-relay.mjs'

const token = 'test-device-access-token-0123456789'

async function fixture(t, { congested = false } = {}) {
  let relaySocket
  class RelaySocket extends WebSocket {
    constructor(...args) {
      super(...args)
      relaySocket = this
    }
  }
  class DeviceServer extends WebSocketServer {
    handleUpgrade(request, socket, head, callback) {
      super.handleUpgrade(request, socket, head, peer => {
        // Simulate a persistently slow device deterministically; relying on OS
        // socket buffer sizes does not reproduce backpressure on every CI host.
        const descriptor = Object.getOwnPropertyDescriptor(WebSocket.prototype, 'bufferedAmount')
        Object.defineProperty(peer, 'bufferedAmount', {
          get: () => congested ? 65536 : descriptor.get.call(peer),
        })
        callback(peer)
      })
    }
  }
  const upstream = http.createServer()
  const backend = new WebSocketServer({ server: upstream })
  upstream.listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  const server = createDeviceRelay({
    WebSocket: RelaySocket,
    WebSocketServer: DeviceServer,
    upstream: `http://127.0.0.1:${upstream.address().port}`,
    accessToken: token,
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    for (const socket of backend.clients) socket.terminate()
    await new Promise(resolve => server.close(resolve))
    await new Promise(resolve => backend.close(resolve))
    await new Promise(resolve => upstream.close(resolve))
  })
  const url = `ws://127.0.0.1:${server.address().port}/api/realtime`
  return {
    backend,
    url,
    release: () => { congested = false },
    async connect() {
      const connected = once(backend, 'connection')
      const device = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } })
      device.on('error', () => {})
      t.after(() => device.terminate())
      await once(device, 'open')
      const [provider] = await connected
      return { device, provider, relaySocket }
    },
  }
}

for (const code of [1000, 1001, 1008, 1013, 4001, 4002, 4003]) {
  test(`preserves upstream close code ${code} and reason`, { timeout: 5000 }, async t => {
    const { device, provider } = await (await fixture(t)).connect()
    const closed = once(device, 'close')
    provider.close(code, '上游关闭 / upstream closed')
    const [actualCode, reason] = await closed
    assert.equal(actualCode, code)
    assert.equal(reason.toString(), '上游关闭 / upstream closed')
  })
}

for (const abrupt of [false, true]) {
  test(`handles ${abrupt ? 'abrupt loss' : 'close without a status'} without sending reserved codes`, { timeout: 5000 }, async t => {
    const { device, provider } = await (await fixture(t)).connect()
    const closed = once(device, 'close')
    if (abrupt) provider.terminate()
    else provider.close()
    const [code] = await closed
    assert.equal(code, abrupt ? 1011 : 1005)
  })
}

for (const [code, state] of [[4001, 'replaced'], [4002, 'occupied'], [4003, 'revoked']]) {
  test(`public GatewayClient stops reconnecting after ${state}`, { timeout: 5000 }, async t => {
    const { backend, url } = await fixture(t)
    let connections = 0
    backend.on('connection', socket => {
      connections++
      socket.once('message', () => socket.close(code, state))
    })
    let terminal
    const stopped = new Promise(resolve => { terminal = resolve })
    const client = new GatewayClient({
      url,
      clientInstanceId: 'test-embedded-device',
      clientType: 'native',
      createSocket: endpoint => new WebSocket(endpoint, { headers: { Authorization: `Bearer ${token}` } }),
      reconnectMinMs: 20,
      reconnectMaxMs: 20,
      onStatus: status => { if (status.state === state) terminal() },
    })
    t.after(() => client.close())
    client.start()
    await stopped
    assert.equal(client.stopped, true)
    await delay(80)
    assert.equal(connections, 1)
  })
}

test('keeps transport and GCP heartbeats alive during congestion, then drains audio in order', { timeout: 5000 }, async t => {
  const harness = await fixture(t, { congested: true })
  const { device, provider, relaySocket } = await harness.connect()
  const events = []
  const upstreamEvents = []
  device.on('message', data => events.push(JSON.parse(data)))
  provider.on('message', data => upstreamEvents.push(JSON.parse(data)))
  const pcm = Buffer.alloc(19200, 37)
  const read = once(relaySocket, 'message')
  provider.send(JSON.stringify({
    type: 'audio.delta', responseId: 'slow-reply', event_id: 'slow-audio',
    sampleRate: 24000, audio: pcm.toString('base64'),
  }))
  await read
  assert.equal(relaySocket.isPaused, false)
  assert.equal(events.length, 0)

  for (let cycle = 0; cycle < 3; cycle++) {
    const pong = once(provider, 'pong')
    provider.ping(`heartbeat-${cycle}`)
    assert.equal((await pong)[0].toString(), `heartbeat-${cycle}`)
  }
  const ping = createGatewayClientProtocolMessage('session.ping', {}, { eventId: 'ping-1' })
  parseGatewayServerProtocolMessage(ping)
  const received = once(device, 'message')
  provider.send(JSON.stringify(ping))
  assert.deepEqual(JSON.parse((await received)[0]), ping)
  // The relay must forward, not impersonate the client's application pong.
  assert.deepEqual(upstreamEvents, [])
  const pong = createGatewayClientProtocolMessage('session.pong', { request_event_id: 'ping-1' })
  parseGatewayClientProtocolMessage(pong)
  const upstreamReply = once(provider, 'message')
  device.send(JSON.stringify(pong))
  assert.deepEqual(JSON.parse((await upstreamReply)[0]), pong)
  assert.deepEqual(upstreamEvents, [pong])

  const done = { type: 'audio.done', responseId: 'slow-reply' }
  const drained = new Promise(resolve => device.on('message', data => {
    if (JSON.parse(data).type === 'audio.done') resolve()
  }))
  provider.send(JSON.stringify(done))
  harness.release()
  await drained
  assert.deepEqual(events[0], ping)
  assert.deepEqual(events.at(-1), done)
  const audio = events.filter(event => event.type === 'audio.delta')
  assert.deepEqual(Buffer.concat(audio.map(event => Buffer.from(event.audio, 'base64'))), pcm)
  assert.ok(audio.every(event => event.audio.length <= 4096 && event.responseId === 'slow-reply'))
  assert.equal(device.readyState, WebSocket.OPEN)
})

test('closes a congested device when the bounded queue overflows', { timeout: 5000 }, async t => {
  const { device, provider } = await (await fixture(t, { congested: true })).connect()
  const closed = once(device, 'close')
  const audio = JSON.stringify({ type: 'audio.delta', audio: Buffer.alloc(600000).toString('base64') })
  // Each message is under the 1 MiB frame limit; together they exceed 2 MiB.
  for (let i = 0; i < 3; i++) provider.send(audio)
  const [code, reason] = await closed
  assert.equal(code, 1013)
  assert.equal(reason.toString(), 'Queue limit exceeded')
})
