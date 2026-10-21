// Synthetic media fixtures. Automated tests must only use generated media —
// never real user audio or likenesses. Test vectors are dumped as JSON (hex
// payloads) so the Python renderer codec can be verified against the exact
// same bytes (see renderer/tests/test_dhav.py).

import {
  DHAV_VERSION, RecordKind, ControlOp, INPUT_AUDIO_FORMAT,
  encodeInputPcm, encodePairedAv, encodeMediaEnd, encodeControl,
} from '../protocol/dhav.mjs'

export function tonePcm({ frequency = 440, sampleRate = INPUT_AUDIO_FORMAT.sampleRate, durationMs = 100, amplitude = 0.5, phase = 0 } = {}) {
  const samples = Math.floor(sampleRate * durationMs / 1000)
  const buffer = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i++) {
    const value = Math.round(Math.sin(2 * Math.PI * frequency * (phase + i) / sampleRate) * amplitude * 32767)
    buffer.writeInt16LE(value, i * 2)
  }
  return { buffer, samples, endPhase: phase + samples }
}

export function silencePcm({ sampleRate = INPUT_AUDIO_FORMAT.sampleRate, durationMs = 100 } = {}) {
  const samples = Math.floor(sampleRate * durationMs / 1000)
  return { buffer: Buffer.alloc(samples * 2), samples }
}

// Split PCM into uneven chunks to exercise stateful consumers.
export function chunkPcm(buffer, sizes) {
  const chunks = []
  let offset = 0
  for (const size of sizes) {
    const bytes = Math.min(size * 2, buffer.length - offset)
    if (bytes <= 0) break
    chunks.push(buffer.subarray(offset, offset + bytes))
    offset += bytes
  }
  if (offset < buffer.length) chunks.push(buffer.subarray(offset))
  return chunks
}

// Deterministic I420 test pattern: base luma from generation hash, moving
// block from frameSequence, top row encodes frameSequence low bits so tests
// can assert frames advance without repetition.
export function syntheticI420({ width = 256, height = 256, frameSequence = 0, generation = 0 } = {}) {
  const data = Buffer.alloc(width * height * 3 / 2)
  const base = (generation * 37 + 16) % 200
  data.fill(base, 0, width * height)
  for (let x = 0; x < width; x++) data[x] = (x + frameSequence * 7) % 256
  const blockSize = 32
  const blockX = (frameSequence * 11) % (width - blockSize)
  const blockY = (frameSequence * 5) % (height - blockSize)
  const lumaOffset = blockY * width + blockX
  for (let y = 0; y < blockSize; y++) data.fill(235, lumaOffset + y * width, lumaOffset + y * width + blockSize)
  const chromaOffset = width * height
  const cb = 16 + ((frameSequence * 29) % 200)
  const cr = 200 - ((frameSequence * 13) % 150)
  data.fill(cb, chromaOffset, chromaOffset + width * height / 4)
  data.fill(cr, chromaOffset + width * height / 4)
  return data
}

export const TEST_TURN = Object.freeze({ avatarSessionId: 'avs-fixture-1', responseId: 'resp_fixture_1', generation: 0 })

// Canonical vectors covering every record kind and control op. Regenerate the
// JSON dump with: node fixtures/generate.mjs --dump
export function testVectors() {
  const audio = tonePcm({ frequency: 440, durationMs: 40 })
  const video = { format: 'i420', width: 64, height: 64, data: syntheticI420({ width: 64, height: 64, frameSequence: 3, generation: 1 }) }
  const vectors = [
    { name: 'input_pcm_first_chunk', message: encodeInputPcm({ turn: TEST_TURN, sequence: 0, sampleOffset: 0, samples: audio.samples, payload: audio.buffer }) },
    { name: 'input_pcm_second_chunk', message: encodeInputPcm({ turn: TEST_TURN, sequence: 1, sampleOffset: audio.samples, samples: audio.samples, payload: audio.buffer }) },
    { name: 'paired_av', message: encodePairedAv({ turn: { ...TEST_TURN, generation: 1 }, sequence: 0, ptsUs: 0, durationUs: 40000, sampleOffset: 0, samples: audio.samples, video, audio: audio.buffer }) },
    { name: 'paired_av_silence_padding', message: encodePairedAv({ turn: TEST_TURN, sequence: 5, ptsUs: 200000, durationUs: 40000, sampleOffset: 960, samples: 960, paddingSamples: 480, silence: true, video, audio: Buffer.alloc(960 * 2) }) },
    { name: 'media_end', message: encodeMediaEnd({ turn: TEST_TURN, lastSequence: 11, reason: 'finished' }) },
    { name: 'media_end_cancelled', message: encodeMediaEnd({ turn: TEST_TURN, lastSequence: 4, reason: 'cancelled' }) },
    { name: 'control_start', message: encodeControl({ op: ControlOp.START, requestId: 'req-1', turn: TEST_TURN, inputFormat: INPUT_AUDIO_FORMAT }) },
    { name: 'control_finish', message: encodeControl({ op: ControlOp.FINISH, requestId: 'req-2', turn: TEST_TURN, lastAudioSequence: 11, totalSamples: 11520 }) },
    { name: 'control_cancel', message: encodeControl({ op: ControlOp.CANCEL, requestId: 'req-3', turn: TEST_TURN, reason: 'user_interruption' }) },
    { name: 'control_close', message: encodeControl({ op: ControlOp.CLOSE, requestId: 'req-4' }) },
  ]
  return vectors.map(({ name, message }) => ({
    name,
    kind: typeof message === 'string' ? 'text' : message.readUInt8(5),
    hex: typeof message === 'string' ? Buffer.from(message, 'utf8').toString('hex') : message.toString('hex'),
  }))
}

if (process.argv.includes('--dump')) {
  const dump = { magic: 'DHAV', version: DHAV_VERSION, kinds: RecordKind, vectors: testVectors() }
  const out = new URL('./generated/dhav-vectors.json', import.meta.url)
  const { mkdirSync, writeFileSync } = await import('node:fs')
  mkdirSync(new URL('./generated/', import.meta.url), { recursive: true })
  writeFileSync(out, JSON.stringify(dump, null, 2))
  console.log(`wrote ${out.pathname}`)
}
