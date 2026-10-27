import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DHAV_MAGIC, DhavLimit, RecordKind, ControlOp, INPUT_AUDIO_FORMAT, DhavError,
  encodeInputPcm, encodePairedAv, encodeMediaEnd, encodeRecord, encodeControl,
  decodeRecord, decodeControl, i420ByteLength,
} from '../protocol/dhav.mjs'
import { TEST_TURN, tonePcm, silencePcm, chunkPcm, syntheticI420, testVectors } from '../fixtures/generate.mjs'

const audio = tonePcm({ frequency: 440, durationMs: 40 })
const videoData = syntheticI420({ width: 64, height: 64, frameSequence: 1 })
const video = { format: 'i420', width: 64, height: 64, data: videoData }

test('DHAV prefix layout is network order and 16 bytes', () => {
  const record = encodeInputPcm({ turn: TEST_TURN, sequence: 0, sampleOffset: 0, samples: audio.samples, payload: audio.buffer })
  assert.equal(record.subarray(0, 4).toString(), 'DHAV')
  assert.equal(record.readUInt8(4), 1)
  assert.equal(record.readUInt8(5), RecordKind.INPUT_PCM)
  assert.equal(record.readUInt16BE(6), 0)
  const headerLength = record.readUInt32BE(8)
  const payloadLength = record.readUInt32BE(12)
  assert.equal(record.length, 16 + headerLength + payloadLength)
  assert.equal(payloadLength, audio.buffer.length)
})

test('input PCM round-trips', () => {
  const record = encodeInputPcm({ turn: TEST_TURN, sequence: 7, sampleOffset: 2400, samples: audio.samples, payload: audio.buffer })
  const decoded = decodeRecord(record)
  assert.equal(decoded.kind, RecordKind.INPUT_PCM)
  assert.deepEqual(decoded.header.turn, TEST_TURN)
  assert.equal(decoded.header.sequence, 7)
  assert.equal(decoded.header.sampleOffset, 2400)
  assert.equal(decoded.header.samples, audio.samples)
  assert.deepEqual(decoded.header.format, INPUT_AUDIO_FORMAT)
  assert.ok(decoded.payload.equals(audio.buffer))
})

test('paired AV round-trips with audio before video in payload', () => {
  const record = encodePairedAv({ turn: TEST_TURN, sequence: 2, ptsUs: 80000, durationUs: 40000, sampleOffset: 960, samples: audio.samples, video, audio: audio.buffer })
  const decoded = decodeRecord(record)
  assert.equal(decoded.kind, RecordKind.PAIRED_AV)
  assert.equal(decoded.header.ptsUs, 80000)
  assert.equal(decoded.header.durationUs, 40000)
  assert.equal(decoded.header.audioLength, audio.buffer.length)
  assert.equal(decoded.header.videoLength, i420ByteLength(64, 64))
  assert.ok(decoded.audio.equals(audio.buffer))
  assert.ok(decoded.video.equals(videoData))
})

test('paired AV preserves silence/idle/padding markers', () => {
  const silent = silencePcm({ durationMs: 40 })
  const record = encodePairedAv({ turn: TEST_TURN, sequence: 3, ptsUs: 0, durationUs: 40000, sampleOffset: 0, samples: silent.samples, paddingSamples: 480, silence: true, video, audio: silent.buffer })
  const decoded = decodeRecord(record)
  assert.equal(decoded.header.silence, true)
  assert.equal(decoded.header.idle, false)
  assert.equal(decoded.header.paddingSamples, 480)
})

test('media end is metadata only', () => {
  const decoded = decodeRecord(encodeMediaEnd({ turn: TEST_TURN, lastSequence: 9, reason: 'finished' }))
  assert.equal(decoded.kind, RecordKind.MEDIA_END)
  assert.equal(decoded.header.lastSequence, 9)
  assert.equal(decoded.payload.length, 0)
})

test('control frames round-trip and enforce ops', () => {
  const start = decodeControl(encodeControl({ op: ControlOp.START, requestId: 'r1', turn: TEST_TURN, inputFormat: INPUT_AUDIO_FORMAT }))
  assert.equal(start.op, 'start')
  assert.equal(start.protocol, 'dhav')
  assert.deepEqual(start.turn, TEST_TURN)
  const finish = decodeControl(encodeControl({ op: ControlOp.FINISH, requestId: 'r2', turn: TEST_TURN, lastAudioSequence: 3, totalSamples: 3840 }))
  assert.equal(finish.totalSamples, 3840)
  assert.throws(() => encodeControl({ op: ControlOp.FINISH, requestId: 'r3', turn: TEST_TURN }), DhavError)
  assert.throws(() => encodeControl({ op: ControlOp.CANCEL, requestId: 'r4', turn: TEST_TURN }), DhavError)
  assert.throws(() => encodeControl({ op: 'explode', requestId: 'r5' }), DhavError)
  assert.throws(() => encodeControl({ op: ControlOp.CLOSE }), DhavError)
  assert.throws(() => decodeControl(JSON.stringify({ protocol: 'dhav', version: 2, op: 'close', requestId: 'r6' })), DhavError)
  assert.throws(() => decodeControl('not json'), DhavError)
})

test('decoder rejects malformed records', () => {
  const good = encodeInputPcm({ turn: TEST_TURN, sequence: 0, sampleOffset: 0, samples: audio.samples, payload: audio.buffer })
  assert.throws(() => decodeRecord(good.subarray(0, 10)), DhavError)
  const badMagic = Buffer.from(good); badMagic.write('XHAV', 0)
  assert.throws(() => decodeRecord(badMagic), DhavError)
  const badVersion = Buffer.from(good); badVersion.writeUInt8(9, 4)
  assert.throws(() => decodeRecord(badVersion), DhavError)
  const badKind = Buffer.from(good); badKind.writeUInt8(42, 5)
  assert.throws(() => decodeRecord(badKind), DhavError)
  const badFlags = Buffer.from(good); badFlags.writeUInt16BE(1, 6)
  assert.throws(() => decodeRecord(badFlags), DhavError)
  const truncated = good.subarray(0, good.length - 1)
  assert.throws(() => decodeRecord(truncated), DhavError)
  const extended = Buffer.concat([good, Buffer.alloc(1)])
  assert.throws(() => decodeRecord(extended), DhavError)
})

test('decoder rejects inconsistent headers and payloads', () => {
  const record = encodePairedAv({ turn: TEST_TURN, sequence: 0, ptsUs: 0, durationUs: 40000, sampleOffset: 0, samples: audio.samples, video, audio: audio.buffer })
  const headerLength = record.readUInt32BE(8)
  const patch = (mutate) => {
    const header = JSON.parse(record.subarray(16, 16 + headerLength).toString())
    mutate(header)
    const headerBytes = Buffer.from(JSON.stringify(header))
    const copy = Buffer.alloc(16 + headerBytes.length + record.readUInt32BE(12))
    record.subarray(0, 16).copy(copy)
    copy.writeUInt32BE(headerBytes.length, 8)
    headerBytes.copy(copy, 16)
    record.subarray(16 + headerLength).copy(copy, 16 + headerBytes.length)
    return copy
  }
  assert.throws(() => decodeRecord(patch(h => { h.samples += 1 })), DhavError)
  assert.throws(() => decodeRecord(patch(h => { h.video.width = 63 })), DhavError)
  assert.throws(() => decodeRecord(patch(h => { h.video.width = 1024; h.video.height = 1024 })), DhavError)
  assert.throws(() => decodeRecord(patch(h => { h.turn.generation = -1 })), DhavError)
  assert.throws(() => decodeRecord(patch(h => { delete h.sequence })), DhavError)
  assert.throws(() => decodeRecord(patch(h => { h.format.sampleRate = 'fast' })), DhavError)
})

test('encoder enforces limits', () => {
  const big = Buffer.alloc(DhavLimit.recordBytes)
  assert.throws(() => encodeRecord(RecordKind.INPUT_PCM, { turn: TEST_TURN, sequence: 0, sampleOffset: 0, samples: big.length / 2, format: INPUT_AUDIO_FORMAT }, big), DhavError)
  const hugeHeader = { turn: TEST_TURN, blob: 'x'.repeat(DhavLimit.headerBytes) }
  assert.throws(() => encodeRecord(RecordKind.MEDIA_END, hugeHeader, Buffer.alloc(0)), DhavError)
  assert.throws(() => encodePairedAv({ turn: TEST_TURN, sequence: 0, ptsUs: 0, durationUs: 1, sampleOffset: 0, samples: 1, video: { format: 'i420', width: 63, height: 64, data: Buffer.alloc(0) }, audio: Buffer.alloc(2) }), DhavError)
  assert.throws(() => encodeControl({ op: ControlOp.START, requestId: 'r', blob: 'x'.repeat(DhavLimit.controlBytes) }), DhavError)
})

test('uneven chunk splitting preserves byte coverage', () => {
  const chunks = chunkPcm(audio.buffer, [7, 100, 33])
  assert.ok(Buffer.concat(chunks).equals(audio.buffer))
})

test('fixture vectors are stable and self-describing', () => {
  const vectors = testVectors()
  assert.equal(vectors.length, 10)
  const names = new Set(vectors.map(v => v.name))
  assert.equal(names.size, vectors.length)
  for (const vector of vectors) {
    if (vector.kind === 'text') { decodeControl(Buffer.from(vector.hex, 'hex').toString('utf8')); continue }
    const decoded = decodeRecord(Buffer.from(vector.hex, 'hex'))
    assert.equal(decoded.kind, vector.kind)
  }
})
