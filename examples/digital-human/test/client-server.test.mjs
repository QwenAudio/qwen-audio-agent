import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, get } from 'node:http'
import { WebSocket, WebSocketServer } from 'ws'
import { startExampleServer } from '../server/server.mjs'
import { startMockRendererServer } from '../providers/mock/mock-renderer-server.mjs'
import { decodeRecord, RecordKind } from '../protocol/dhav.mjs'
import { tonePcm } from '../fixtures/generate.mjs'

async function until(predicate, label = 'condition') {
  const deadline = Date.now() + 5000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
async function connect(server, path, origin = server.origin) {
  const socket = new WebSocket(server.origin.replace('http', 'ws') + path, { origin })
  const messages = []
  socket.on('message', (data, binary) => messages.push(binary ? decodeRecord(data) : JSON.parse(data.toString())))
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
  return { socket, messages, send: message => socket.send(JSON.stringify(message)) }
}

test('client host proxies ordinary GCP unchanged and keeps credentials server-side', async t => {
  const http = createServer()
  const ws = new WebSocketServer({ server: http })
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve))
  const seen = []
  ws.on('connection', (client, request) => {
    seen.push({ authorization: request.headers.authorization, url: request.url })
    client.on('message', data => client.send(data.toString()))
  })
  const server = await startExampleServer({ port: 0, gatewayUrl: `ws://127.0.0.1:${http.address().port}/api/realtime`, gatewayToken: 'private-token' })
  t.after(async () => { await server.close(); await new Promise(resolve => ws.close(resolve)); await new Promise(resolve => http.close(resolve)) })
  const config = await (await fetch(server.origin + '/api/config')).json()
  assert.equal(config.renderer.id, 'dhav')
  assert.ok(!JSON.stringify(config).includes('private-token'))
  const { socket, messages, send } = await connect(server, '/gateway?sessionId=example-1')
  const event = { type: 'session.start', event_id: 'preserved', clientType: 'digital-human-example' }
  send(event)
  await until(() => messages.length === 1)
  assert.deepEqual(messages[0], event)
  assert.deepEqual(seen, [{ authorization: 'Bearer private-token', url: '/api/realtime?sessionId=example-1' }])
  socket.close()
})

test('loopback host rejects foreign origins, DNS rebinding Host and unsafe configuration', async t => {
  const server = await startExampleServer({ port: 0 })
  t.after(() => server.close())
  await assert.rejects(connect(server, '/avatar', 'https://attacker.invalid'), /403/)
  const status = await new Promise((resolve, reject) => {
    get(server.origin + '/api/config', { headers: { host: 'attacker.invalid' } }, response => {
      response.resume(); resolve(response.statusCode)
    }).on('error', reject)
  })
  assert.equal(status, 403)
  await assert.rejects(startExampleServer({ host: '0.0.0.0' }), /loopback/)
  await assert.rejects(startExampleServer({ gatewayUrl: 'ws://secret:token@localhost/api/realtime' }), /credentials/)
})

test('DHAV bridge produces two response-local media timelines and isolates cancellation', async t => {
  const mock = await startMockRendererServer({ heartbeatIntervalMs: 100 })
  const server = await startExampleServer({ port: 0, rendererUrl: mock.url })
  t.after(async () => { await server.close(); await mock.close() })
  const { socket, messages, send } = await connect(server, '/avatar')
  await until(() => messages.some(m => m.type === 'session.ready'), 'ready')
  assert.deepEqual(Object.keys(messages[0]).sort(), ['avatarSessionId', 'type'])
  for (let generation = 0; generation < 2; generation++) {
    const turn = { responseId: `response-${generation}`, generation }
    send({ type: 'turn.start', ...turn })
    send({ type: 'audio.append', ...turn, sampleRate: 24000, audio: tonePcm({ durationMs: 120 }).buffer.toString('base64') })
    send({ type: 'audio.end', ...turn })
    await until(() => messages.some(m => m.kind === RecordKind.MEDIA_END && m.header.turn.responseId === turn.responseId), 'media end')
    const units = messages.filter(m => m.kind === RecordKind.PAIRED_AV && m.header.turn.responseId === turn.responseId)
    assert.ok(units.length >= 3)
    assert.equal(units[0].header.ptsUs, 0)
    assert.equal(units[0].header.sequence, 0)
  }
  const cancelled = { responseId: 'cancelled', generation: 2 }
  send({ type: 'turn.start', ...cancelled })
  send({ type: 'turn.cancel', ...cancelled, reason: 'user_interruption' })
  send({ type: 'audio.append', ...cancelled, sampleRate: 24000, audio: tonePcm({ durationMs: 40 }).buffer.toString('base64') })
  const next = { responseId: 'after-cancel', generation: 3 }
  send({ type: 'turn.start', ...next })
  send({ type: 'audio.append', ...next, sampleRate: 24000, audio: tonePcm({ durationMs: 80 }).buffer.toString('base64') })
  send({ type: 'audio.end', ...next })
  await until(() => messages.some(m => m.kind === RecordKind.MEDIA_END && m.header.turn.responseId === next.responseId))
  assert.ok(!messages.some(m => m.header?.turn.responseId === cancelled.responseId))
  socket.close()
})

test('DHAV bridge rejects invalid sample rates without leaking renderer details', async t => {
  const mock = await startMockRendererServer({ heartbeatIntervalMs: 100 })
  const server = await startExampleServer({ port: 0, rendererUrl: mock.url, rendererToken: 'hidden-token' })
  t.after(async () => { await server.close(); await mock.close() })
  const { messages, send } = await connect(server, '/avatar')
  await until(() => messages.some(m => m.type === 'session.ready'))
  send({ type: 'turn.start', responseId: 'r', generation: 0 })
  send({ type: 'audio.append', responseId: 'r', generation: 0, sampleRate: 16000, audio: 'AAAA' })
  await until(() => messages.some(m => m.type === 'renderer.error'))
  const error = messages.find(m => m.type === 'renderer.error')
  assert.equal(error.code, 'protocol_error')
  assert.ok(!JSON.stringify(messages).includes('hidden-token'))
})

test('mock retains sub-frame PCM until more streaming input arrives', async t => {
  const mock = await startMockRendererServer({ heartbeatIntervalMs: 100 })
  const server = await startExampleServer({ port: 0, rendererUrl: mock.url })
  t.after(async () => { await server.close(); await mock.close() })
  const { messages, send } = await connect(server, '/avatar')
  await until(() => messages.some(m => m.type === 'session.ready'))
  const turn = { responseId: 'short-chunks', generation: 0 }
  const audio = tonePcm({ durationMs: 80 }).buffer
  send({ type: 'turn.start', ...turn })
  send({ type: 'audio.append', ...turn, sampleRate: 24000, audio: audio.subarray(0, 960).toString('base64') })
  await new Promise(resolve => setTimeout(resolve, 100))
  send({ type: 'audio.append', ...turn, sampleRate: 24000, audio: audio.subarray(960).toString('base64') })
  send({ type: 'audio.end', ...turn })
  await until(() => messages.some(m => m.kind === RecordKind.MEDIA_END && m.header.turn.responseId === turn.responseId))
  // Scoped to the reply: the idle turn keeps painting silent frames on the same
  // socket, and they must never be counted as played audio.
  const played = Buffer.concat(messages.filter(m => m.kind === RecordKind.PAIRED_AV && m.header.turn.responseId === turn.responseId)
    .map(m => m.audio.subarray(0, (m.header.samples - m.header.paddingSamples) * 2)))
  assert.deepEqual(played, audio)
})

test('client host can select a non-DHAV adapter with native RTC session messages', async t => {
  let closed = false
  const server = await startExampleServer({ port: 0, rendererId: 'rtc-test', adapters: {
    'rtc-test': { attach(client) {
      client.send(JSON.stringify({ type: 'rtc.session', roomId: 'room', scopedToken: 'ephemeral' }))
      return () => { closed = true }
    } },
  } })
  t.after(() => server.close())
  const config = await (await fetch(server.origin + '/api/config')).json()
  assert.equal(config.renderer.id, 'rtc-test')
  const { socket, messages } = await connect(server, '/avatar')
  await until(() => messages.length === 1)
  assert.equal(messages[0].type, 'rtc.session')
  assert.equal(messages[0].avatarSessionId, undefined)
  socket.close()
  await until(() => closed)
})

test('synchronous vendor adapter failure closes the socket without crashing the host', async t => {
  const server = await startExampleServer({ port: 0, rendererId: 'throws', adapters: {
    throws: { attach() { throw new Error('private vendor failure') } },
  } })
  t.after(() => server.close())
  const { socket } = await connect(server, '/avatar')
  const [code, reason] = await new Promise(resolve => socket.once('close', (...args) => resolve(args)))
  assert.equal(code, 1011)
  assert.equal(reason.toString(), 'renderer unavailable')
  assert.equal((await fetch(server.origin + '/api/config')).status, 200)
})
