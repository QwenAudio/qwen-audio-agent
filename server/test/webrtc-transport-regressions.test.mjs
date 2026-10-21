import test from 'node:test'
import assert from 'node:assert/strict'
import { isReliableOrderedChannel, NativeWebRtcMedia } from '../src/transport/webrtc/media.mjs'
import { WebRtcConnection } from '../src/transport/webrtc/protocol.mjs'
import { FakeMedia, testProvider } from './fixtures/webrtc-gateway.mjs'
import { BrowserWebRtcConnection } from '../../shared/gateway/webrtc-browser.mjs'

test('targeted media clear keeps other queued responses and blocks late chunks', () => {
  const media = Object.assign(Object.create(NativeWebRtcMedia.prototype), {
    known: new Set(['a', 'b']), blocked: new Set(), responses: new Map([['a', {}], ['b', {}]]),
    queue: [
      { responseId: 'a', samples: new Int16Array(10), offset: 3 },
      { responseId: 'a', end: true },
      { responseId: 'b', samples: new Int16Array(5), offset: 0 },
    ],
    queuedSamples: 12,
  })
  media.clear('a')
  assert.equal(media.blocked.has('a'), true)
  assert.equal(media.responses.has('b'), true)
  assert.equal(media.queuedSamples, 5)
  assert.deepEqual(media.queue.map(entry => entry.responseId), ['b'])
  media.append({ responseId: 'a', sampleRate: 24000, audio: 'AAA=' })
  assert.equal(media.queuedSamples, 5)
  media.clear()
  assert.equal(media.queue.length, 0)
  assert.equal(media.queuedSamples, 0)
})

test('RTC targeted clears preserve another response and cancellation reason end to end', () => {
  const media = new FakeMedia()
  const cleared = []
  media.clear = id => cleared.push(id)
  const connection = new WebRtcConnection({ media, provider: testProvider(), sessionId: 'targeted-clear' })
  const inputs = []
  connection.on('message', raw => inputs.push(JSON.parse(raw)))
  connection.send(JSON.stringify({ type: 'playback.clear', responseId: 'a', reason: 'provider_failure' }))
  assert.deepEqual(cleared, ['a'])
  const browser = Object.assign(Object.create(BrowserWebRtcConnection.prototype), {
    outputs: new Map([['a', {}], ['b', {}]]),
    audio: { muted: false }, onPlayback() {}, onEvent() {},
    send: event => { connection.receive(JSON.stringify(event)); return true },
  })
  browser.received(media.events.at(-1))
  assert.deepEqual([...browser.outputs.keys()], ['b'])
  assert.equal(browser.audio.muted, false)
  assert.equal(inputs.length, 1)
  assert.equal(inputs[0].responseId, 'a')
  assert.equal(inputs[0].reason, 'provider_failure')
  connection.close()
})

test('RTC targeted clear never mutes the shared track while the next response is not announced yet', () => {
  const receipts = []
  const browser = Object.assign(Object.create(BrowserWebRtcConnection.prototype), {
    outputs: new Map([['a', {}]]), audio: { muted: false }, onPlayback() {}, onEvent() {},
    send: event => { receipts.push(event); return true },
  })
  browser.clearPlayback('a', 'permission_resolved')
  browser.received({ type: 'qwaudio.output.started', response_id: 'b' })
  assert.equal(browser.audio.muted, false)
  assert.deepEqual([...browser.outputs.keys()], ['b'])
  assert.deepEqual(receipts, [{ type: 'qwaudio.playback.cancelled', response_id: 'a', reason: 'permission_resolved' }])
})

test('reliable channels accept browser null and native uint16 sentinels', () => {
  for (const unlimited of [null, undefined, 65535]) {
    assert.equal(isReliableOrderedChannel({ ordered: true, maxRetransmits: unlimited, maxPacketLifeTime: unlimited }), true)
  }
  assert.equal(isReliableOrderedChannel({ ordered: false, maxRetransmits: null, maxPacketLifeTime: null }), false)
  for (const limited of [0, 1, 100, 65534]) {
    assert.equal(isReliableOrderedChannel({ ordered: true, maxRetransmits: limited, maxPacketLifeTime: 65535 }), false)
    assert.equal(isReliableOrderedChannel({ ordered: true, maxRetransmits: 65535, maxPacketLifeTime: limited }), false)
  }
})

test('native reliable DataChannel opens the session exactly once', () => {
  let opened = 0
  let rejected = 0
  const media = Object.assign(Object.create(NativeWebRtcMedia.prototype), {
    channels: new Set(), opened: false, closed: false,
    onOpen: () => { opened++ },
  })
  const channel = {
    ordered: true, maxRetransmits: 65535, maxPacketLifeTime: 65535,
    close() { rejected++ },
  }
  media.bindChannel(channel, true)
  assert.equal(rejected, 0)
  channel.onopen()
  channel.onopen()
  assert.equal(opened, 1)
  media.bindChannel({ ...channel, maxRetransmits: 0 }, false)
  assert.equal(rejected, 1)
})

test('close fences synchronous send and media cleanup re-entry', () => {
  const media = new FakeMedia()
  const connection = new WebRtcConnection({ media, provider: testProvider(), sessionId: 'close-test' })
  const closes = []
  let notifications = 0
  let cleanups = 0
  media.send = () => { notifications++; connection.close(1011, 'send failed') }
  media.close = () => { cleanups++; connection.close(1006, 'media closed') }
  connection.on('close', (code, reason) => closes.push({ code, reason }))
  connection.close(1000, 'requested close')
  connection.close()
  assert.equal(notifications, 1)
  assert.equal(cleanups, 1)
  assert.equal(connection.readyState, 3)
  assert.deepEqual(closes, [{ code: 1000, reason: 'requested close' }])
})

test('a failed closing notification does not prevent cleanup or emit twice', () => {
  const media = new FakeMedia()
  const connection = new WebRtcConnection({ media, provider: testProvider(), sessionId: 'close-failure' })
  let closes = 0
  media.send = () => { throw new Error('closed data channel') }
  connection.on('close', () => { closes++; connection.close() })
  assert.doesNotThrow(() => connection.close())
  assert.equal(media.closed, true)
  assert.equal(connection.readyState, 3)
  assert.equal(closes, 1)
})
