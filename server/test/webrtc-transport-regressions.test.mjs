import test from 'node:test'
import assert from 'node:assert/strict'
import { isReliableOrderedChannel, NativeWebRtcMedia } from '../src/transport/webrtc/media.mjs'
import { WebRtcConnection } from '../src/transport/webrtc/protocol.mjs'
import { FakeMedia, testProvider } from './fixtures/webrtc-gateway.mjs'

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
