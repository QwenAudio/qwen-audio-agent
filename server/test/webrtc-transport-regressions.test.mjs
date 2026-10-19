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

// Avatar audio bypasses append()/its converter and reaches the queue through the
// A/V scheduler. It must still drive the same output.started/drained markers as
// model audio: the browser keys its AnalyserNode playback receipts off them, and
// those receipts gate the assistant transcript flush and avatar terminal state.
test('avatar audio drives output.started and output.drained through the pump', () => {
  const sent = []
  const pumped = []
  const media = Object.assign(Object.create(NativeWebRtcMedia.prototype), {
    closed: false,
    known: new Set(),
    responses: new Map(),
    queue: [],
    queuedSamples: 0,
    blocked: new Set(),
    source: { onData: () => {} },
    avatar: { onAudioPumped: (filled, drained) => pumped.push({ filled, drained }) },
    connected: () => true,
    send: event => sent.push(event),
    fail: message => { throw new Error(`unexpected fail: ${message}`) },
  })

  media.beginAvatarResponse('resp_avatar')
  assert.equal(media.responses.get('resp_avatar').converter, null)
  assert.equal(media.responses.get('resp_avatar').avatar, true)
  media.enqueue('resp_avatar', new Int16Array(480).fill(1234))
  media.pump()
  assert.deepEqual(sent.shift(), { type: 'qwaudio.output.started', response_id: 'resp_avatar' })

  // The model's audio.done (media.finish) must NOT end an avatar turn: the renderer
  // is still echoing the diverted audio back at realtime. Only the renderer's
  // media_end (finishAvatar) enqueues the playback end marker.
  media.finish('resp_avatar')
  media.pump()
  assert.equal(sent.length, 0)
  assert.equal(media.responses.has('resp_avatar'), true)

  media.finishAvatar('resp_avatar')
  media.pump()
  assert.deepEqual(sent.shift(), { type: 'qwaudio.output.drained', response_id: 'resp_avatar' })
  assert.equal(media.responses.has('resp_avatar'), false)
  assert.deepEqual(pumped.at(-1), { filled: 0, drained: 'resp_avatar' })
})

test('blockResponse drops queued audio so a barge-in stops immediately', () => {
  const sent = []
  const pumped = []
  const media = Object.assign(Object.create(NativeWebRtcMedia.prototype), {
    closed: false,
    known: new Set(),
    responses: new Map(),
    queue: [],
    queuedSamples: 0,
    blocked: new Set(),
    source: { onData: () => {} },
    avatar: { onAudioPumped: (filled, drained) => pumped.push({ filled, drained }) },
    connected: () => true,
    send: event => sent.push(event),
    fail: message => { throw new Error(`unexpected fail: ${message}`) },
  })

  // The renderer echoes at realtime while the model produces audio far faster, so
  // an interrupt lands with seconds of the cancelled turn already queued.
  media.beginAvatarResponse('resp_a')
  media.enqueue('resp_a', new Int16Array(4800).fill(1234))
  media.beginAvatarResponse('resp_b')
  media.enqueue('resp_b', new Int16Array(960).fill(4321))
  media.pump()
  assert.deepEqual(sent.shift(), { type: 'qwaudio.output.started', response_id: 'resp_a' })
  assert.equal(media.queuedSamples, 4800 + 960 - 480)

  media.blockResponse('resp_a')
  // The cancelled turn's remaining audio is gone; the next turn's is untouched.
  assert.equal(media.queue.some(entry => entry.responseId === 'resp_a'), false)
  assert.equal(media.queuedSamples, 960)
  assert.equal(media.responses.has('resp_a'), false)
  assert.equal(media.blocked.has('resp_a'), true)

  // Late audio for the blocked response is refused rather than re-queued.
  media.append({ audio: Buffer.alloc(960).toString('base64'), sampleRate: 24000, responseId: 'resp_a' })
  assert.equal(media.queue.some(entry => entry.responseId === 'resp_a'), false)

  // The pump now plays only the surviving response, so the avatar stops at the
  // interrupt instead of talking over the next turn.
  media.pump()
  assert.equal(pumped.at(-1).filled, 480)
  assert.equal(media.queue.some(entry => entry.responseId === 'resp_a'), false)
  assert.equal(media.queuedSamples, 960 - 480)
})

test('blockResponse with block:false purges the echo but keeps the plain-audio egress open', () => {
  const sent = []
  const media = Object.assign(Object.create(NativeWebRtcMedia.prototype), {
    closed: false,
    known: new Set(),
    responses: new Map(),
    queue: [],
    queuedSamples: 0,
    blocked: new Set(),
    source: { onData: () => {} },
    avatar: { onAudioPumped: () => {} },
    connected: () => true,
    send: event => sent.push(event),
    fail: message => { throw new Error(`unexpected fail: ${message}`) },
  })

  media.beginAvatarResponse('resp_a')
  media.enqueue('resp_a', new Int16Array(4800).fill(1234))
  media.blockResponse('resp_a', false)
  assert.equal(media.queue.length, 0)
  assert.equal(media.queuedSamples, 0)
  assert.equal(media.blocked.has('resp_a'), false)

  // A pre-commit renderer fallback replays the buffered model audio under this
  // same responseId. If the purge had also blocked it, the whole fallback reply
  // would be silent — and the playback receipt that gates the assistant
  // transcript would never arrive.
  media.append({ audio: Buffer.alloc(960).toString('base64'), sampleRate: 24000, responseId: 'resp_a' })
  assert.equal(media.queue.some(entry => entry.responseId === 'resp_a'), true)
  media.pump()
  assert.deepEqual(sent[0], { type: 'qwaudio.output.started', response_id: 'resp_a' })
})
