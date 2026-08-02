import assert from 'node:assert/strict'
import test from 'node:test'

import { resamplePcm16 } from '../src/pcm-audio.mjs'

function pcm16(samples) {
  const buffer = Buffer.alloc(samples.length * 2)
  samples.forEach((sample, index) => buffer.writeInt16LE(sample, index * 2))
  return buffer
}

function samples(buffer) {
  return Array.from(
    { length: buffer.length / 2 },
    (_, index) => buffer.readInt16LE(index * 2),
  )
}

test('keeps PCM16 unchanged when the device rate already matches', () => {
  const input = pcm16([-1000, 0, 1000])

  assert.deepEqual(resamplePcm16(input, 24000, 24000), input)
})

test('resamples provider PCM16 to the common TUI playback rate', () => {
  assert.deepEqual(
    samples(resamplePcm16(pcm16([0, 1000]), 16000, 24000)),
    [0, 667, 1000],
  )
})

test('rejects invalid rates and malformed PCM16', () => {
  assert.throws(() => resamplePcm16(Buffer.alloc(2), 0, 24000), /采样率/)
  assert.throws(() => resamplePcm16(Buffer.alloc(1), 16000, 24000), /偶数/)
})
