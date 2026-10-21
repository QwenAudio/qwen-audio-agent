// DHAV: digital-human avatar/vision private renderer protocol.
// Authoritative Node codec — the Python renderer mirrors it and both are
// verified against the shared fixtures in fixtures/generate.mjs.
//
// Wire layout (one record per WebSocket binary message):
//   16-byte prefix: magic[4]='DHAV' | version u8 | kind u8 | flags u16
//                   | headerLength u32 | payloadLength u32   (network order)
//   UTF-8 JSON header
//   binary payload
// Control frames are WebSocket text messages: JSON, max 16 KiB.

export const DHAV_MAGIC = Buffer.from('DHAV')
export const DHAV_VERSION = 1
export const PREFIX_LENGTH = 16

export const RecordKind = Object.freeze({
  INPUT_PCM: 1,   // gateway adapter -> renderer: assistant reply audio
  PAIRED_AV: 2,   // renderer -> media worker: PCM audio + I420 video
  MEDIA_END: 3,   // renderer -> media worker: metadata-only turn end
})

export const ControlOp = Object.freeze({
  START: 'start',
  FINISH: 'finish',
  CANCEL: 'cancel',
  CLOSE: 'close',
})

export const DhavLimit = Object.freeze({
  headerBytes: 4096,
  recordBytes: 1024 * 1024,
  controlBytes: 16 * 1024,
  videoWidth: 512,
  videoHeight: 512,
})

export const INPUT_AUDIO_FORMAT = Object.freeze({ encoding: 'pcm_s16le', sampleRate: 24000, channels: 1 })

export class DhavError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'DhavError'
    this.code = code
  }
}

const reject = (code, message) => { throw new DhavError(code, message) }

export function assertTurnRef(turn) {
  if (!turn || typeof turn !== 'object') reject('protocol_error', 'TurnRef required')
  if (typeof turn.avatarSessionId !== 'string' || !turn.avatarSessionId || turn.avatarSessionId.length > 256) reject('protocol_error', 'TurnRef.avatarSessionId required')
  if (typeof turn.responseId !== 'string' || !turn.responseId || turn.responseId.length > 256) reject('protocol_error', 'TurnRef.responseId required')
  if (!Number.isInteger(turn.generation) || turn.generation < 0) reject('protocol_error', 'TurnRef.generation must be a non-negative integer')
  return { avatarSessionId: turn.avatarSessionId, responseId: turn.responseId, generation: turn.generation }
}

export function assertAudioFormat(format) {
  if (!format || format.encoding !== 'pcm_s16le' || !Number.isInteger(format.sampleRate)
    || format.sampleRate <= 0 || format.channels !== 1) reject('protocol_error', 'audio format must be pcm_s16le mono')
  return { encoding: 'pcm_s16le', sampleRate: format.sampleRate, channels: 1 }
}

export function i420ByteLength(width, height) {
  return width * height * 3 / 2
}

// kind=1 input PCM. Header: turn, sequence, sampleOffset, samples, format.
// Payload: raw PCM16LE bytes; length must equal samples * 2 * channels.
export function encodeInputPcm({ turn, sequence, sampleOffset, samples, format = INPUT_AUDIO_FORMAT, payload }) {
  assertTurnRef(turn)
  if (!Number.isInteger(sequence) || sequence < 0) reject('protocol_error', 'sequence must be a non-negative integer')
  if (!Number.isInteger(sampleOffset) || sampleOffset < 0) reject('protocol_error', 'sampleOffset must be a non-negative integer')
  if (!Number.isInteger(samples) || samples < 0) reject('protocol_error', 'samples must be a non-negative integer')
  const audio = assertAudioFormat(format)
  const bytes = asBuffer(payload)
  if (bytes.length !== samples * 2 * audio.channels) reject('protocol_error', `input PCM payload ${bytes.length} does not match ${samples} samples`)
  return encodeRecord(RecordKind.INPUT_PCM, { turn: assertTurnRef(turn), sequence, sampleOffset, samples, format: audio }, bytes)
}

// kind=2 paired AV. Payload order: PCM audio, then I420 video.
// Header carries both segment lengths so the decoder never guesses.
export function encodePairedAv({ turn, sequence, ptsUs, durationUs, sampleOffset, samples, audioFormat = INPUT_AUDIO_FORMAT,
  video, audio, paddingSamples = 0, silence = false, idle = false }) {
  assertTurnRef(turn)
  if (!Number.isInteger(sequence) || sequence < 0) reject('protocol_error', 'sequence must be a non-negative integer')
  if (!Number.isInteger(ptsUs) || ptsUs < 0) reject('protocol_error', 'ptsUs must be a non-negative integer')
  if (!Number.isInteger(durationUs) || durationUs <= 0) reject('protocol_error', 'durationUs must be a positive integer')
  if (!Number.isInteger(sampleOffset) || sampleOffset < 0) reject('protocol_error', 'sampleOffset must be a non-negative integer')
  if (!Number.isInteger(samples) || samples < 0) reject('protocol_error', 'samples must be a non-negative integer')
  if (!Number.isInteger(paddingSamples) || paddingSamples < 0 || paddingSamples > samples) reject('protocol_error', 'paddingSamples must be within [0, samples]')
  const format = assertAudioFormat(audioFormat)
  if (!video || !Number.isInteger(video.width) || !Number.isInteger(video.height)
    || video.width <= 0 || video.height <= 0 || video.width % 2 || video.height % 2
    || video.width > DhavLimit.videoWidth || video.height > DhavLimit.videoHeight) {
    reject('protocol_error', `video must be even-sized within ${DhavLimit.videoWidth}x${DhavLimit.videoHeight}`)
  }
  if (video.format !== 'i420') reject('protocol_error', 'video.format must be i420')
  const audioBytes = asBuffer(audio)
  if (audioBytes.length !== samples * 2 * format.channels) reject('protocol_error', `paired audio ${audioBytes.length} does not match ${samples} samples`)
  const videoBytes = asBuffer(video.data)
  const expected = i420ByteLength(video.width, video.height)
  if (videoBytes.length !== expected) reject('protocol_error', `I420 payload ${videoBytes.length} does not match ${video.width}x${video.height} (${expected})`)
  const header = {
    turn: assertTurnRef(turn), sequence, ptsUs, durationUs, sampleOffset, samples, paddingSamples,
    silence, idle, format, video: { format: 'i420', width: video.width, height: video.height },
    audioLength: audioBytes.length, videoLength: videoBytes.length,
  }
  return encodeRecord(RecordKind.PAIRED_AV, header, Buffer.concat([audioBytes, videoBytes]))
}

// kind=3 media end: metadata only, no media body.
export function encodeMediaEnd({ turn, lastSequence, reason = 'finished' }) {
  assertTurnRef(turn)
  if (!Number.isInteger(lastSequence) || lastSequence < -1) reject('protocol_error', 'lastSequence must be an integer >= -1')
  if (typeof reason !== 'string' || !reason || reason.length > 100) reject('protocol_error', 'reason required')
  return encodeRecord(RecordKind.MEDIA_END, { turn: assertTurnRef(turn), lastSequence, reason }, Buffer.alloc(0))
}

export function encodeRecord(kind, header, payload) {
  const headerBytes = Buffer.from(JSON.stringify(header), 'utf8')
  if (headerBytes.length > DhavLimit.headerBytes) reject('protocol_error', `header exceeds ${DhavLimit.headerBytes} bytes`)
  const payloadBytes = asBuffer(payload)
  const total = PREFIX_LENGTH + headerBytes.length + payloadBytes.length
  if (total > DhavLimit.recordBytes) reject('protocol_error', `record exceeds ${DhavLimit.recordBytes} bytes`)
  const prefix = Buffer.alloc(PREFIX_LENGTH)
  DHAV_MAGIC.copy(prefix, 0)
  prefix.writeUInt8(DHAV_VERSION, 4)
  prefix.writeUInt8(kind, 5)
  prefix.writeUInt16BE(0, 6)
  prefix.writeUInt32BE(headerBytes.length, 8)
  prefix.writeUInt32BE(payloadBytes.length, 12)
  return Buffer.concat([prefix, headerBytes, payloadBytes])
}

// Decode exactly one record from one WebSocket binary message.
export function decodeRecord(message) {
  const bytes = asBuffer(message)
  if (bytes.length < PREFIX_LENGTH) reject('protocol_error', 'record shorter than DHAV prefix')
  if (!bytes.subarray(0, 4).equals(DHAV_MAGIC)) reject('protocol_error', 'bad DHAV magic')
  const version = bytes.readUInt8(4)
  if (version !== DHAV_VERSION) reject('protocol_error', `unsupported DHAV version ${version}`)
  const kind = bytes.readUInt8(5)
  if (![RecordKind.INPUT_PCM, RecordKind.PAIRED_AV, RecordKind.MEDIA_END].includes(kind)) reject('protocol_error', `unknown record kind ${kind}`)
  const flags = bytes.readUInt16BE(6)
  if (flags !== 0) reject('protocol_error', `unsupported flags ${flags}`)
  const headerLength = bytes.readUInt32BE(8)
  const payloadLength = bytes.readUInt32BE(12)
  if (headerLength > DhavLimit.headerBytes) reject('protocol_error', 'headerLength over limit')
  if (PREFIX_LENGTH + headerLength + payloadLength > DhavLimit.recordBytes) reject('protocol_error', 'record over limit')
  if (bytes.length !== PREFIX_LENGTH + headerLength + payloadLength) reject('protocol_error', 'record length mismatch')
  let header
  try { header = JSON.parse(bytes.subarray(PREFIX_LENGTH, PREFIX_LENGTH + headerLength).toString('utf8')) } catch { reject('protocol_error', 'malformed JSON header') }
  if (!header || typeof header !== 'object' || Array.isArray(header)) reject('protocol_error', 'header must be a JSON object')
  const payload = bytes.subarray(PREFIX_LENGTH + headerLength)
  if (kind === RecordKind.INPUT_PCM) return validateInputPcm(header, payload)
  if (kind === RecordKind.PAIRED_AV) return validatePairedAv(header, payload)
  return validateMediaEnd(header)
}

function validateInputPcm(header, payload) {
  const turn = assertTurnRef(header.turn)
  if (!Number.isInteger(header.sequence) || header.sequence < 0) reject('protocol_error', 'missing sequence')
  if (!Number.isInteger(header.sampleOffset) || header.sampleOffset < 0) reject('protocol_error', 'missing sampleOffset')
  if (!Number.isInteger(header.samples) || header.samples < 0) reject('protocol_error', 'missing samples')
  const format = assertAudioFormat(header.format)
  if (payload.length !== header.samples * 2 * format.channels) reject('protocol_error', 'input PCM payload length mismatch')
  return { kind: RecordKind.INPUT_PCM, header: { turn, sequence: header.sequence, sampleOffset: header.sampleOffset, samples: header.samples, format }, payload }
}

function validatePairedAv(header, payload) {
  const turn = assertTurnRef(header.turn)
  for (const field of ['sequence', 'ptsUs', 'sampleOffset', 'samples', 'paddingSamples']) {
    if (!Number.isInteger(header[field]) || header[field] < 0) reject('protocol_error', `missing ${field}`)
  }
  if (!Number.isInteger(header.durationUs) || header.durationUs <= 0) reject('protocol_error', 'missing durationUs')
  if (header.paddingSamples > header.samples) reject('protocol_error', 'paddingSamples over samples')
  const format = assertAudioFormat(header.format)
  const video = header.video
  if (!video || video.format !== 'i420' || !Number.isInteger(video.width) || !Number.isInteger(video.height)
    || video.width <= 0 || video.height <= 0 || video.width % 2 || video.height % 2
    || video.width > DhavLimit.videoWidth || video.height > DhavLimit.videoHeight) reject('invalid_media', 'bad video descriptor')
  if (!Number.isInteger(header.audioLength) || !Number.isInteger(header.videoLength)
    || header.audioLength < 0 || header.videoLength < 0) reject('protocol_error', 'missing segment lengths')
  if (header.audioLength !== header.samples * 2 * format.channels) reject('protocol_error', 'audioLength/samples mismatch')
  if (header.videoLength !== i420ByteLength(video.width, video.height)) reject('invalid_media', 'videoLength/size mismatch')
  if (payload.length !== header.audioLength + header.videoLength) reject('protocol_error', 'paired payload length mismatch')
  return {
    kind: RecordKind.PAIRED_AV,
    header: {
      turn, sequence: header.sequence, ptsUs: header.ptsUs, durationUs: header.durationUs,
      sampleOffset: header.sampleOffset, samples: header.samples, paddingSamples: header.paddingSamples,
      silence: header.silence === true, idle: header.idle === true, format,
      video: { format: 'i420', width: video.width, height: video.height },
      audioLength: header.audioLength, videoLength: header.videoLength,
    },
    audio: payload.subarray(0, header.audioLength),
    video: payload.subarray(header.audioLength),
    payload,
  }
}

function validateMediaEnd(header) {
  const turn = assertTurnRef(header.turn)
  if (!Number.isInteger(header.lastSequence) || header.lastSequence < -1) reject('protocol_error', 'missing lastSequence')
  if (typeof header.reason !== 'string' || !header.reason) reject('protocol_error', 'missing reason')
  return { kind: RecordKind.MEDIA_END, header: { turn, lastSequence: header.lastSequence, reason: header.reason }, payload: Buffer.alloc(0) }
}

// Control frames (WebSocket text): { protocol, version, op, requestId, turn?, ... }
export function encodeControl(control) {
  if (!control || typeof control !== 'object') reject('protocol_error', 'control frame required')
  if (!Object.values(ControlOp).includes(control.op)) reject('protocol_error', `unknown control op ${control.op}`)
  if (typeof control.requestId !== 'string' || !control.requestId) reject('protocol_error', 'control.requestId required')
  const frame = { protocol: 'dhav', version: DHAV_VERSION, ...control }
  if (frame.turn) assertTurnRef(frame.turn)
  if (frame.op === ControlOp.FINISH) {
    if (!Number.isInteger(frame.lastAudioSequence) || frame.lastAudioSequence < -1) reject('protocol_error', 'finish requires lastAudioSequence >= -1')
    if (!Number.isInteger(frame.totalSamples) || frame.totalSamples < 0) reject('protocol_error', 'finish requires totalSamples')
  }
  if (frame.op === ControlOp.CANCEL && typeof frame.reason !== 'string') reject('protocol_error', 'cancel requires reason')
  const text = JSON.stringify(frame)
  if (Buffer.byteLength(text) > DhavLimit.controlBytes) reject('protocol_error', 'control frame over limit')
  return text
}

export function decodeControl(text) {
  if (typeof text !== 'string') reject('protocol_error', 'control frame must be text')
  if (Buffer.byteLength(text) > DhavLimit.controlBytes) reject('protocol_error', 'control frame over limit')
  let frame
  try { frame = JSON.parse(text) } catch { reject('protocol_error', 'malformed control frame') }
  if (!frame || typeof frame !== 'object' || frame.protocol !== 'dhav') reject('protocol_error', 'control.protocol must be dhav')
  if (frame.version !== DHAV_VERSION) reject('protocol_error', `unsupported control version ${frame.version}`)
  if (!Object.values(ControlOp).includes(frame.op)) reject('protocol_error', `unknown control op ${frame.op}`)
  if (typeof frame.requestId !== 'string' || !frame.requestId) reject('protocol_error', 'control.requestId required')
  if (frame.turn) assertTurnRef(frame.turn)
  return frame
}

// Renderer -> adapter event/control messages on the media channel are JSON
// text frames: { protocol, version, event, ... }. Keep them small; media
// bodies always travel as binary records.
export function encodeMediaEvent(event) {
  const frame = { protocol: 'dhav', version: DHAV_VERSION, ...event }
  const text = JSON.stringify(frame)
  if (Buffer.byteLength(text) > DhavLimit.controlBytes) reject('protocol_error', 'media event over limit')
  return text
}

export function decodeMediaEvent(text) {
  if (typeof text !== 'string') reject('protocol_error', 'media event must be text')
  if (Buffer.byteLength(text) > DhavLimit.controlBytes) reject('protocol_error', 'media event over limit')
  let frame
  try { frame = JSON.parse(text) } catch { reject('protocol_error', 'malformed media event') }
  if (!frame || typeof frame !== 'object' || frame.protocol !== 'dhav' || frame.version !== DHAV_VERSION) reject('protocol_error', 'bad media event envelope')
  if (typeof frame.event !== 'string' || !frame.event) reject('protocol_error', 'media event name required')
  return frame
}

function asBuffer(value) {
  if (Buffer.isBuffer(value)) return value
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  reject('protocol_error', 'binary payload required')
}
