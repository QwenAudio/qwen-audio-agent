import test from 'node:test'
import assert from 'node:assert/strict'
import { decodeDhavRecord } from '../client/dhav-decoder.mjs'
import { encodePairedAv, encodeMediaEnd, encodeRecord } from '../protocol/dhav.mjs'

const turn = { avatarSessionId: 'test', responseId: 'response', generation: 3 }
const make = () => encodePairedAv({ turn, sequence: 0, ptsUs: 0, durationUs: 1000, sampleOffset: 0,
  samples: 2, audio: Buffer.from([1, 0, 2, 0]), video: { format: 'i420', width: 2, height: 2, data: Buffer.alloc(6, 128) } })

test('portable decoder agrees with Node encoder and respects typed-array offsets', () => {
  const wire = make()
  const padded = new Uint8Array(wire.length + 8)
  padded.set(wire, 4)
  const decoded = decodeDhavRecord(padded.subarray(4, 4 + wire.length))
  assert.equal(decoded.kind, 2)
  assert.deepEqual(decoded.header.turn, turn)
  assert.deepEqual([...decoded.audio], [1, 0, 2, 0])
  assert.equal(decoded.video.length, 6)
  assert.equal(decodeDhavRecord(wire.buffer.slice(wire.byteOffset, wire.byteOffset + wire.byteLength)).kind, 2)
  assert.equal(decodeDhavRecord(encodeMediaEnd({ turn, lastSequence: 0 })).kind, 3)
})

test('rejects truncation, trailing bytes, unknown versions, invalid flags and oversized records', () => {
  const wire = make()
  assert.throws(() => decodeDhavRecord(wire.subarray(0, -1)), /length/)
  assert.throws(() => decodeDhavRecord(Buffer.concat([wire, Buffer.of(0)])), /length/)
  for (const index of [0, 4, 6]) {
    const corrupt = Buffer.from(wire)
    corrupt[index] = 99
    assert.throws(() => decodeDhavRecord(corrupt), /prefix/)
  }
  assert.throws(() => decodeDhavRecord(new Uint8Array(1024 * 1024 + 1)), /size/)
})

test('validates semantic lengths, safe counters, UTF8, and empty end payload', () => {
  const { header, payload } = decodeDhavRecord(make())
  for (const patch of [{ samples: 3 }, { sampleOffset: 1.5 }, { sequence: Number.MAX_SAFE_INTEGER + 1 },
    { video: { format: 'i420', width: 3, height: 2 } }, { paddingSamples: 3 }, { silence: 'true' }]) {
    assert.throws(() => decodeDhavRecord(encodeRecord(2, { ...header, ...patch }, payload)), /Invalid DHAV/)
  }
  assert.throws(() => decodeDhavRecord(encodeRecord(3, { turn, lastSequence: 0, reason: 'finished' }, Buffer.of(0))), /media end/)
  const corrupt = Buffer.from(make())
  corrupt[17] = 255
  assert.throws(() => decodeDhavRecord(corrupt), /JSON header/)
})
