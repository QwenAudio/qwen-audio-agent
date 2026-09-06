import assert from 'node:assert/strict'
import test from 'node:test'
import { audioPlaybackLeadSeconds, resample } from '../src/audio.js'

test('resamples audio to the requested approximate length', () => {
  const input = new Float32Array(480)
  const output = resample(input, 48000, 16000)
  assert.equal(output.length, 160)
})

test('reserves extra playback lead time only for remote transports', () => {
  assert.equal(audioPlaybackLeadSeconds(), 0.02)
  assert.equal(audioPlaybackLeadSeconds({ remote: true }), 0.16)
})
