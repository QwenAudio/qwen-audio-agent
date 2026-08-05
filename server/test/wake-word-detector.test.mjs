import assert from 'node:assert/strict'
import test from 'node:test'
import { pcm16Base64ToFloat32 } from '../src/voice/wake-word/sherpa-detector.mjs'

test('converts little-endian PCM16 audio into normalized float samples', () => {
  const pcm = Buffer.alloc(8)
  pcm.writeInt16LE(-32768, 0)
  pcm.writeInt16LE(-16384, 2)
  pcm.writeInt16LE(0, 4)
  pcm.writeInt16LE(32767, 6)
  const samples = pcm16Base64ToFloat32(pcm.toString('base64'))
  assert.deepEqual([...samples], [-1, -0.5, 0, 32767 / 32768])
})

test('ignores an incomplete trailing PCM byte', () => {
  const samples = pcm16Base64ToFloat32(Buffer.from([1, 0, 2]).toString('base64'))
  assert.deepEqual([...samples], [1 / 32768])
})
