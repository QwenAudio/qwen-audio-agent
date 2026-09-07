import assert from 'node:assert/strict'
import test from 'node:test'
import { VisualInputBuffer } from '../src/voice/visual-input-buffer.mjs'

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64')

test('validates JPEG frames and forwards at most one frame per interval', () => {
  let now = 1000
  const frames = []
  const buffer = new VisualInputBuffer({
    now: () => now,
    onFrame: image => frames.push(image),
  })

  assert.deepEqual(buffer.append({ image: JPEG, occurredAt: 900 }), {
    accepted: true,
  })
  now = 1500
  assert.deepEqual(buffer.append({ image: JPEG, occurredAt: 1400 }), {
    accepted: false,
    reason: 'rate_limited',
  })
  now = 2000
  assert.deepEqual(buffer.append({ image: JPEG, occurredAt: 1900 }), {
    accepted: true,
  })
  assert.deepEqual(frames, [JPEG, JPEG])
  assert.equal(buffer.snapshot().droppedFrames, 1)
})

test('drops stale capture timestamps and clears ordering state on reset', () => {
  let now = 1000
  const frames = []
  const buffer = new VisualInputBuffer({
    now: () => now,
    onFrame: image => frames.push(image),
  })

  buffer.append({ image: JPEG, occurredAt: 1000 })
  now = 2500
  assert.equal(buffer.append({ image: JPEG, occurredAt: 999 }).reason, 'out_of_order')
  buffer.reset()
  assert.equal(buffer.append({ image: JPEG, occurredAt: 999 }).accepted, true)
  assert.equal(frames.length, 2)
})

test('rejects non-JPEG, malformed Base64 and oversized frames', () => {
  const buffer = new VisualInputBuffer({ onFrame: () => true })
  assert.throws(() => buffer.append({
    image: Buffer.from('not-jpeg').toString('base64'),
  }), /JPEG/)
  assert.throws(() => buffer.append({ image: 'not base64' }), /Base64/)
  assert.throws(() => new VisualInputBuffer({
    onFrame: () => true,
    maxBase64Bytes: 4,
  }).append({ image: JPEG }), /256 KiB/)
  assert.throws(() => buffer.append({
    image: JPEG,
    mediaType: 'image/png',
  }), /不支持的视觉帧格式/)
})
