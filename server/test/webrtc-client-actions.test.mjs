import test from 'node:test'
import assert from 'node:assert/strict'
import { parseClientActions } from '../src/transport/webrtc/routes.mjs'
import { WebRtcConnection } from '../src/transport/webrtc/protocol.mjs'
import { encodeWebRtcMessage, WebRtcMessageReader } from '../../shared/gateway/webrtc-message.mjs'
import { FakeMedia, testProvider, rtcHarness } from './fixtures/webrtc-gateway.mjs'

test('WebRTC action declarations are bounded names, not client-supplied tool definitions', async t => {
  assert.deepEqual(parseClientActions(undefined), [])
  assert.deepEqual(parseClientActions('["visual.capture"]'), ['visual.capture'])
  for (const value of ['{}', '["arbitrary"]', '["visual.capture","visual.capture"]', '["../path"]', ['visual.capture'], JSON.stringify(Array(17).fill('visual.capture'))]) {
    assert.throws(() => parseClientActions(value), /client_actions/)
  }
  const h = await rtcHarness(t)
  const response = await h.offer(undefined, '?client_actions=not-json')
  assert.equal(response.status, 400)
  assert.equal(h.media.length, 0, 'invalid declarations must not allocate media')
})

test('WebRTC handshake advertises only explicitly declared client actions', () => {
  for (const clientActions of [[], ['visual.capture']]) {
    const connection = new WebRtcConnection({ media: new FakeMedia(), provider: testProvider(true), sessionId: 'test', clientActions })
    let hello
    connection.on('message', raw => { hello = JSON.parse(raw) })
    connection.start()
    assert.equal(hello.capabilities.includes('client.actions.visual.capture'), clientActions.length > 0)
    assert.equal(hello.capabilities.includes('client.actions.desktop.presence.enter_sleep'), false)
    connection.close()
  }
})

test('large action results round-trip over bounded chunks without bypassing GCP', () => {
  const media = new FakeMedia()
  const connection = new WebRtcConnection({ media, provider: testProvider(true), sessionId: 'test' })
  const inputs = []
  connection.on('message', raw => inputs.push(JSON.parse(raw)))
  const event = { type: 'qwaudio.command', event: { type: 'client.action.result', event_id: 'result-1',
    request_event_id: 'request-1', status: 'completed', output: { image: 'a'.repeat(260000) } } }
  const frames = encodeWebRtcMessage(event)
  assert.ok(frames.length > 1)
  frames.forEach((raw, i) => {
    assert.ok(Buffer.byteLength(raw) < 65536)
    connection.receive(raw)
    assert.equal(inputs.length, i === frames.length - 1 ? 1 : 0)
  })
  assert.deepEqual(inputs[0], event.event)
  // Fragmentation cannot inject session tools or instructions.
  for (const frame of encodeWebRtcMessage({ type: 'session.update', session: { instructions: 'x'.repeat(40000) } })) connection.receive(frame)
  assert.equal(media.events.at(-1).error.code, 'invalid_event')
  connection.close()
})

test('chunk parser rejects malformed, oversized, out-of-order, expired and nested messages', () => {
  let now = 0
  const reader = new WebRtcMessageReader({ now: () => now })
  const event = { type: 'qwaudio.command', event: { type: 'client.action.result', output: '中😀'.repeat(12000) } }
  const frames = encodeWebRtcMessage(event)
  let result
  for (const frame of frames) result = reader.read(frame)
  assert.deepEqual(JSON.parse(result), event, 'Unicode survives chunk boundaries')
  assert.throws(() => reader.read(frames[1]), /Out-of-order/)
  reader.read(frames[0]); now = 5001
  assert.throws(() => reader.read(frames[1]), /expired/)
  assert.equal(reader.pending, null)
  assert.throws(() => reader.read('x'.repeat(65537)), /64 KiB/)
  assert.throws(() => encodeWebRtcMessage({ x: 'x'.repeat(512 * 1024) }), /512 KiB/)
  assert.throws(() => reader.read(JSON.stringify({ type: 'qwaudio.transport.chunk', id: 'x', index: 0, total: 9999, data: 'x' })), /Invalid/)
  const nested = encodeWebRtcMessage({ type: 'qwaudio.transport.chunk', data: 'x'.repeat(40000) })
  assert.throws(() => nested.forEach(frame => reader.read(frame)), /Nested/)
  reader.clear()
})

test('closing a connection discards partial messages', () => {
  const connection = new WebRtcConnection({ media: new FakeMedia(), provider: testProvider(), sessionId: 'test' })
  connection.receive(encodeWebRtcMessage({ type: 'qwaudio.command', event: { type: 'client.action.result', output: 'x'.repeat(40000) } })[0])
  assert.ok(connection.messages.pending)
  connection.close()
  assert.equal(connection.messages.pending, null)
})
