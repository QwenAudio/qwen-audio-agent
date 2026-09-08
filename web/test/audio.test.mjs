import assert from 'node:assert/strict'
import test from 'node:test'
import {
  audioSchedulingLeadSeconds,
  createPcmPlaybackQueue,
  createStreamingResampler,
  mergePcmPlaybackItems,
  resample,
} from '../src/realtime/audio.js'

test('resamples audio to the requested approximate length', () => {
  const input = new Float32Array(480)
  const output = resample(input, 48000, 16000)
  assert.equal(output.length, 160)
})

test('returns an empty result for empty input instead of NaN', () => {
  const output = resample(new Float32Array(), 48000, 16000)
  assert.equal(output.length, 0)
  assert.equal(output.some(Number.isNaN), false)
})

test('streaming resampling matches one-shot resampling across chunk boundaries', () => {
  const input = Float32Array.from(
    { length: 12_345 },
    (_, index) => Math.sin(index * 0.017) * 0.8,
  )
  const expected = resample(input, 44_100, 16_000)
  const stream = createStreamingResampler()
  const chunks = []
  let offset = 0
  for (const size of [17, 2048, 3, 701, 4096, 89, 5_391]) {
    const end = Math.min(input.length, offset + size)
    if (end === offset) break
    chunks.push(stream.process(input.slice(offset, end), 44_100, 16_000))
    offset = end
  }
  chunks.push(stream.flush())
  const actual = new Float32Array(chunks.reduce((length, chunk) => length + chunk.length, 0))
  let cursor = 0
  for (const chunk of chunks) {
    actual.set(chunk, cursor)
    cursor += chunk.length
  }

  assert.equal(actual.length, expected.length)
  assert.ok(actual.every((value, index) => Math.abs(value - expected[index]) < 1e-5))
})

test('streaming resampling resets its phase when the target rate changes', () => {
  const stream = createStreamingResampler()
  stream.process(new Float32Array([1, 2, 3]), 44_100, 16_000)
  const output = stream.process(new Float32Array([4, 5, 6]), 44_100, 24_000)
  const tail = stream.flush()
  const expected = resample(new Float32Array([4, 5, 6]), 44_100, 24_000)
  assert.deepEqual([...output, ...tail], [...expected])
})

test('keeps a small Web Audio scheduling lead outside transport buffering', () => {
  assert.equal(audioSchedulingLeadSeconds(), 0.02)
})

test('merges adjacent PCM chunks from the same response', () => {
  const merged = mergePcmPlaybackItems([
    { samples: new Float32Array([1, 2]), sampleRate: 4, responseId: 'a', duration: 0.5 },
    { samples: new Float32Array([3]), sampleRate: 4, responseId: 'a', duration: 0.25 },
    { samples: new Float32Array([4]), sampleRate: 8, responseId: 'a', duration: 0.125 },
  ])
  assert.equal(merged.length, 2)
  assert.deepEqual([...merged[0].samples], [1, 2, 3])
  assert.equal(merged[0].duration, 0.75)
})

test('remote PCM playback prebuffers, batches, and rebuilds after underrun', () => {
  const flushed = []
  const timers = []
  const queue = createPcmPlaybackQueue({
    remote: true,
    onFlush: items => flushed.push(items),
    initialBufferSeconds: 0.3,
    resumeBufferSeconds: 0.2,
    lowWaterSeconds: 0.1,
    batchSeconds: 0.1,
    schedule: callback => {
      timers.push(callback)
      return callback
    },
    cancel: timer => {
      const index = timers.indexOf(timer)
      if (index >= 0) timers.splice(index, 1)
    },
  })
  const chunk = value => ({
    samples: new Float32Array([value]),
    sampleRate: 10,
    responseId: 'response',
    duration: 0.1,
  })

  queue.push(chunk(1))
  queue.push(chunk(2))
  assert.equal(flushed.length, 0)
  queue.push(chunk(3))
  assert.deepEqual([...flushed[0][0].samples], [1, 2, 3])

  queue.push(chunk(4), { timelineAheadSeconds: 0.3 })
  assert.equal(flushed.length, 2)

  queue.push(chunk(5), { timelineAheadSeconds: 0.05 })
  assert.equal(flushed.length, 2)
  queue.push(chunk(6), { timelineAheadSeconds: 0.05 })
  assert.equal(flushed.length, 3)
  assert.deepEqual([...flushed[2][0].samples], [5, 6])
})

test('remote PCM playback flushes a short response when it finishes', () => {
  const flushed = []
  const queue = createPcmPlaybackQueue({
    remote: true,
    onFlush: items => flushed.push(items),
  })
  queue.push({
    samples: new Float32Array([1, 2]),
    sampleRate: 10,
    responseId: 'short',
    duration: 0.2,
  })
  assert.equal(flushed.length, 0)
  queue.finish()
  assert.equal(flushed.length, 1)
})
