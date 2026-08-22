import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MAX_FRAME_PAYLOAD_BYTES,
  NativeInputFrameDecoder,
  decodeNativeInputFrame,
  encodeNativeInputFrame,
} from '../src/native-input-protocol.mjs'

const partial = { type: 'session.partial', text: '你好' }

test('uses one 4-byte big-endian JSON frame across chunk boundaries', () => {
  const first = encodeNativeInputFrame(partial)
  const second = encodeNativeInputFrame({ type: 'session.final', text: 'done' })
  assert.equal(first.readUInt32BE(0), first.length - 4)
  assert.deepEqual(decodeNativeInputFrame(first), partial)

  const decoder = new NativeInputFrameDecoder()
  assert.deepEqual(decoder.push(first.subarray(0, 3)), [])
  assert.deepEqual(decoder.push(Buffer.concat([first.subarray(3), second])), [
    partial,
    { type: 'session.final', text: 'done' },
  ])
  decoder.finish()
})

test('rejects zero, oversized, truncated, trailing, and malformed frames', () => {
  assert.throws(
    () => decodeNativeInputFrame(Buffer.from([0, 0, 0, 0])),
    { code: 'zero_length' },
  )
  const oversized = Buffer.alloc(4)
  oversized.writeUInt32BE(MAX_FRAME_PAYLOAD_BYTES + 1)
  assert.throws(() => decodeNativeInputFrame(oversized), { code: 'oversized' })

  const valid = encodeNativeInputFrame(partial)
  assert.throws(() => decodeNativeInputFrame(valid.subarray(0, -1)), {
    code: 'truncated',
  })
  assert.throws(
    () => decodeNativeInputFrame(Buffer.concat([valid, Buffer.from([0])])),
    { code: 'trailing_bytes' },
  )
  assert.throws(
    () => decodeNativeInputFrame(frame(Buffer.from([0xff]))),
    { code: 'invalid_utf8' },
  )
  assert.throws(
    () => decodeNativeInputFrame(frame(Buffer.from('{'))),
    { code: 'invalid_json' },
  )
  assert.throws(
    () => decodeNativeInputFrame(frame(Buffer.from('{"type":"session.unknown"}'))),
    { code: 'unknown_type' },
  )
})

test('incremental finish rejects a partial frame', () => {
  const decoder = new NativeInputFrameDecoder()
  const valid = encodeNativeInputFrame(partial)
  decoder.push(valid.subarray(0, -1))
  assert.throws(() => decoder.finish(), { code: 'truncated' })
})

function frame(payload) {
  const header = Buffer.alloc(4)
  header.writeUInt32BE(payload.length)
  return Buffer.concat([header, payload])
}
