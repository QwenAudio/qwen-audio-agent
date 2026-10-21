// Browser-only DHAV decoder: one bounded record per WebSocket message. No Buffer.
export const RecordKind = Object.freeze({ INPUT_PCM: 1, PAIRED_AV: 2, MEDIA_END: 3 })
const integer = (value, minimum = 0) => Number.isSafeInteger(value) && value >= minimum
const reject = message => { throw new Error(`Invalid DHAV: ${message}`) }

export function decodeDhavRecord(message) {
  const bytes = message instanceof ArrayBuffer ? new Uint8Array(message)
    : ArrayBuffer.isView(message) ? new Uint8Array(message.buffer, message.byteOffset, message.byteLength) : null
  if (!bytes || bytes.length < 16 || bytes.length > 1024 * 1024) reject('record size')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint32(0) !== 0x44484156 || bytes[4] !== 1 || view.getUint16(6) !== 0) reject('prefix')
  const kind = bytes[5]
  if (![1, 2, 3].includes(kind)) reject('kind')
  const headerLength = view.getUint32(8)
  const payloadLength = view.getUint32(12)
  if (headerLength > 4096 || 16 + headerLength + payloadLength !== bytes.length) reject('length')
  let header
  try { header = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(16, 16 + headerLength))) }
  catch { reject('JSON header') }
  if (!header || typeof header !== 'object' || Array.isArray(header)) reject('header')
  const turn = header.turn
  if (!turn || !integer(turn.generation)
    || !['avatarSessionId', 'responseId'].every(key => typeof turn[key] === 'string' && turn[key].length > 0 && turn[key].length <= 256)) reject('turn')
  const payload = bytes.subarray(16 + headerLength)
  if (kind === RecordKind.MEDIA_END) {
    if (payload.length || !integer(header.lastSequence, -1) || typeof header.reason !== 'string' || !header.reason || header.reason.length > 100) reject('media end')
    return { kind, header, payload }
  }
  if (!['sequence', 'sampleOffset', 'samples'].every(key => integer(header[key]))) reject('audio counters')
  if (header.format?.encoding !== 'pcm_s16le' || header.format.channels !== 1
    || !integer(header.format.sampleRate, 1) || header.format.sampleRate > 192000) reject('audio format')
  if (kind === RecordKind.INPUT_PCM) {
    if (payload.length !== header.samples * 2) reject('PCM length')
    return { kind, header, payload }
  }
  if (!integer(header.ptsUs) || !integer(header.durationUs, 1)
    || !integer(header.paddingSamples) || header.paddingSamples > header.samples) reject('media timing')
  const video = header.video
  if (video?.format !== 'i420' || !integer(video.width, 2) || !integer(video.height, 2)
    || video.width > 512 || video.height > 512 || video.width % 2 || video.height % 2) reject('video size')
  if (header.audioLength !== header.samples * 2 || header.videoLength !== video.width * video.height * 3 / 2
    || payload.length !== header.audioLength + header.videoLength) reject('segment lengths')
  if (typeof header.silence !== 'boolean' || typeof header.idle !== 'boolean') reject('media flags')
  return { kind, header, payload, audio: payload.subarray(0, header.audioLength), video: payload.subarray(header.audioLength) }
}
