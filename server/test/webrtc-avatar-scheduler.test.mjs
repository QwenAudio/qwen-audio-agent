import test from 'node:test'
import assert from 'node:assert/strict'
import { AvatarAvScheduler } from '../src/transport/webrtc/avatar-av-scheduler.mjs'

function pcm16(values) {
  const buffer = Buffer.allocUnsafe(values.length * 2)
  values.forEach((value, index) => buffer.writeInt16LE(value, index * 2))
  return buffer
}

function i420(width, height) {
  return Buffer.alloc((width * height * 3) / 2, 0x40)
}

function harness() {
  const calls = { begin: [], audio: [], finish: [], block: [], frames: [], events: [] }
  const scheduler = new AvatarAvScheduler({
    beginResponse: responseId => calls.begin.push(responseId),
    enqueueAudio: (responseId, samples) => calls.audio.push({ responseId, length: samples.length }),
    finishResponse: responseId => calls.finish.push(responseId),
    blockResponse: (responseId, block) => calls.block.push({ responseId, block }),
    publishFrame: frame => calls.frames.push(frame),
    emit: (op, payload) => calls.events.push({ op, ...payload }),
  })
  return { scheduler, calls }
}

const turn = (responseId, generation = 0) => ({ avatarSessionId: 'av1', responseId, generation })

test('begin registers the response in the audio queue once', () => {
  const { scheduler, calls } = harness()
  scheduler.begin(turn('r1'), { sampleRate: 48000 })
  scheduler.begin(turn('r1'), { sampleRate: 48000 })
  assert.deepEqual(calls.begin, ['r1'])
})

test('audio passes through at 48kHz and video frames wait for the audio clock', () => {
  const { scheduler, calls } = harness()
  scheduler.begin(turn('r1'), { sampleRate: 48000 })
  scheduler.appendUnit({
    turn: turn('r1'), ptsUs: 10000, audioFormat: { sampleRate: 48000, channels: 1 },
    video: { format: 'i420', width: 2, height: 2, data: i420(2, 2) }, audio: pcm16([1, 2, 3, 4]),
  })
  assert.deepEqual(calls.audio, [{ responseId: 'r1', length: 4 }])
  // No clock advance yet: the frame is queued but not published.
  scheduler.onAudioPumped(0)
  assert.equal(calls.frames.length, 0)
  // Advance to 10000us: 480 samples @48kHz = 10ms.
  scheduler.onAudioPumped(480)
  assert.equal(calls.frames.length, 1)
  assert.deepEqual(calls.events, [{ op: 'first_media', responseId: 'r1', generation: 0 }])
})

test('frames publish in pts order as the clock advances', () => {
  const { scheduler, calls } = harness()
  scheduler.begin(turn('r1'), { sampleRate: 48000 })
  for (const ptsUs of [20000, 0, 10000]) {
    scheduler.appendUnit({
      turn: turn('r1'), ptsUs, audioFormat: { sampleRate: 48000, channels: 1 },
      video: { format: 'i420', width: 2, height: 2, data: i420(2, 2) }, audio: pcm16([0]),
    })
  }
  // 480 samples = 10000us: the pts=0 and pts=10000 frames are due.
  scheduler.onAudioPumped(480)
  assert.deepEqual(calls.frames.map(frame => frame.ptsUs), [0, 10000])
  // Another 10ms reaches 20000us: the last frame is due.
  scheduler.onAudioPumped(480)
  assert.deepEqual(calls.frames.map(frame => frame.ptsUs), [0, 10000, 20000])
  assert.equal(calls.events.filter(event => event.op === 'first_media').length, 1)
})

test('finish seals input without ending; media_end ends playback and drained flushes trailing frames', () => {
  const { scheduler, calls } = harness()
  scheduler.begin(turn('r1'), { sampleRate: 48000 })
  scheduler.appendUnit({
    turn: turn('r1'), ptsUs: 500000, audioFormat: { sampleRate: 48000, channels: 1 },
    video: { format: 'i420', width: 2, height: 2, data: i420(2, 2) }, audio: pcm16([0]),
  })
  // Model-done (dh.finish) only seals the renderer input: the renderer is still
  // echoing at realtime, so the end marker must NOT be enqueued yet.
  scheduler.finish(turn('r1'))
  assert.deepEqual(calls.finish, [])
  // Renderer media_end is the authoritative completion: now finishResponse fires.
  scheduler.mediaEnd(turn('r1'))
  assert.deepEqual(calls.finish, ['r1'])
  // media_end is idempotent.
  scheduler.mediaEnd(turn('r1'))
  assert.deepEqual(calls.finish, ['r1'])
  // The far-future frame has not been published by the clock yet.
  scheduler.onAudioPumped(480)
  assert.equal(calls.frames.length, 0)
  // Draining the response flushes the trailing frame and reports drained.
  scheduler.onAudioPumped(0, 'r1')
  assert.equal(calls.frames.length, 1)
  assert.deepEqual(calls.events.at(-1), { op: 'drained', responseId: 'r1', generation: 0 })
})

test('clear quarantines frames and blocks responses at or below the generation', () => {
  const { scheduler, calls } = harness()
  scheduler.begin(turn('r1', 0), { sampleRate: 48000 })
  scheduler.appendUnit({
    turn: turn('r1', 0), ptsUs: 100000, audioFormat: { sampleRate: 48000, channels: 1 },
    video: { format: 'i420', width: 2, height: 2, data: i420(2, 2) }, audio: pcm16([0]),
  })
  scheduler.clear(0)
  assert.deepEqual(calls.block, [{ responseId: 'r1', block: true }])
  // Clock advance publishes nothing: the frame was dropped.
  scheduler.onAudioPumped(48000)
  assert.equal(calls.frames.length, 0)
})

test('clear with block:false quarantines avatar media but leaves the plain egress open', () => {
  const { scheduler, calls } = harness()
  scheduler.begin(turn('r1', 0), { sampleRate: 48000 })
  scheduler.appendUnit({
    turn: turn('r1', 0), ptsUs: 100000, audioFormat: { sampleRate: 48000, channels: 1 },
    video: { format: 'i420', width: 2, height: 2, data: i420(2, 2) }, audio: pcm16([0]),
  })
  // A pre-commit renderer fallback replays the buffered model audio under this
  // same responseId, so the quarantine must not close the response's egress.
  scheduler.clear(0, false)
  assert.deepEqual(calls.block, [{ responseId: 'r1', block: false }])
  assert.equal(calls.frames.length, 0)
  scheduler.onAudioPumped(48000)
  assert.equal(calls.frames.length, 0)
})

test('stale-generation units are dropped, never republished', () => {
  const { scheduler, calls } = harness()
  scheduler.begin(turn('r1', 1), { sampleRate: 48000 })
  scheduler.appendUnit({
    turn: turn('r1', 0), ptsUs: 0, audioFormat: { sampleRate: 48000, channels: 1 },
    video: { format: 'i420', width: 2, height: 2, data: i420(2, 2) }, audio: pcm16([1, 2]),
  })
  assert.deepEqual(calls.audio, [])
  scheduler.onAudioPumped(480)
  assert.equal(calls.frames.length, 0)
})

test('audio is resampled from the renderer rate to the 48kHz output clock', () => {
  const { scheduler, calls } = harness()
  scheduler.begin(turn('r1'), { sampleRate: 24000 })
  scheduler.appendUnit({
    turn: turn('r1'), ptsUs: 0, audioFormat: { sampleRate: 24000, channels: 1 },
    video: null, audio: pcm16(new Array(480).fill(100)),
  })
  // 480 samples @24kHz upsample to ~960 @48kHz (allowing for filter edges).
  const enqueued = calls.audio.reduce((sum, entry) => sum + entry.length, 0)
  assert.ok(enqueued > 800 && enqueued <= 960, `expected ~960 resampled samples, got ${enqueued}`)
})

test('invalid audio reports an error and does not publish frames', () => {
  const { scheduler, calls } = harness()
  scheduler.begin(turn('r1'), { sampleRate: 48000 })
  scheduler.appendUnit({
    turn: turn('r1'), ptsUs: 0, audioFormat: { sampleRate: 48000, channels: 1 },
    video: { format: 'i420', width: 2, height: 2, data: i420(2, 2) }, audio: Buffer.from([0x01]),
  })
  assert.deepEqual(calls.events, [{ op: 'error', responseId: 'r1', generation: 0, code: 'invalid_media' }])
  scheduler.onAudioPumped(480)
  assert.equal(calls.frames.length, 0)
})

test('idle turn publishes video on arrival, never touching the audio queue or clock', () => {
  const { scheduler, calls } = harness()
  scheduler.begin(turn('dh-idle'), { sampleRate: 24000 }, true)
  // An idle turn is not registered in the audio queue, so it cannot drive the
  // browser's energy-gated playback receipts.
  assert.deepEqual(calls.begin, [])
  scheduler.appendUnit({
    turn: turn('dh-idle'), ptsUs: 0, audioFormat: { sampleRate: 24000, channels: 1 },
    video: { format: 'i420', width: 2, height: 2, data: i420(2, 2) }, audio: pcm16([0, 0, 0, 0]),
  })
  // Published immediately: no audio enqueued, no clock advance, no first_media.
  assert.equal(calls.frames.length, 1)
  assert.deepEqual(calls.audio, [])
  assert.deepEqual(calls.events, [])
  scheduler.appendUnit({
    turn: turn('dh-idle'), ptsUs: 40000, audioFormat: { sampleRate: 24000, channels: 1 },
    video: { format: 'i420', width: 2, height: 2, data: i420(2, 2) }, audio: pcm16([0]),
  })
  assert.deepEqual(calls.frames.map(frame => frame.ptsUs), [0, 40000])
  // The audio clock is intentionally not advanced by idle frames.
  scheduler.onAudioPumped(0)
  assert.equal(calls.frames.length, 2)
  // A stray media_end on an idle turn must not flush audio or end a response.
  scheduler.mediaEnd(turn('dh-idle'))
  assert.deepEqual(calls.finish, [])
  assert.deepEqual(calls.audio, [])
  // clear() isolates the idle generation; a late idle frame is then dropped.
  scheduler.clear(0)
  assert.deepEqual(calls.block, [{ responseId: 'dh-idle', block: true }])
  scheduler.appendUnit({
    turn: turn('dh-idle'), ptsUs: 80000, audioFormat: { sampleRate: 24000, channels: 1 },
    video: { format: 'i420', width: 2, height: 2, data: i420(2, 2) }, audio: pcm16([0]),
  })
  assert.equal(calls.frames.length, 2)
})
