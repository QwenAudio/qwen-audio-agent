// Transport-only framing for large client commands (for example a screenshot
// action result). Reassembly happens before the unchanged GCP command parser.
export const WEBRTC_FRAME_BYTES = 64 * 1024
export const WEBRTC_MESSAGE_BYTES = 512 * 1024
const CHUNK_SIZE = 8 * 1024
const CHUNK_TYPE = 'qwaudio.transport.chunk'
const bytes = text => new TextEncoder().encode(text).length

export function encodeWebRtcMessage(event) {
  const text = JSON.stringify(event)
  if (bytes(text) > WEBRTC_MESSAGE_BYTES) throw new Error('WebRTC command exceeds 512 KiB')
  if (bytes(text) <= 16 * 1024) return [text]
  const id = crypto.randomUUID()
  const total = Math.ceil(text.length / CHUNK_SIZE)
  return Array.from({ length: total }, (_, index) => JSON.stringify({
    type: CHUNK_TYPE, id, index, total, data: text.slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE),
  }))
}

export class WebRtcMessageReader {
  constructor({ now = Date.now, timeoutMs = 5000 } = {}) {
    Object.assign(this, { now, timeoutMs, pending: null })
  }
  clear() { clearTimeout(this.timer); this.pending = null }
  read(raw) {
    try {
      if (typeof raw !== 'string' || bytes(raw) > WEBRTC_FRAME_BYTES) throw new Error('WebRTC frame must be JSON text, max 64 KiB')
      const event = JSON.parse(raw)
      if (event?.type !== CHUNK_TYPE) return raw
      const { id, index, total, data } = event
      if (typeof id !== 'string' || !id || id.length > 80 || !Number.isInteger(index)
        || !Number.isInteger(total) || total < 2 || total > WEBRTC_MESSAGE_BYTES / CHUNK_SIZE
        || index < 0 || index >= total || typeof data !== 'string' || !data || data.length > CHUNK_SIZE) {
        throw new Error('Invalid WebRTC chunk')
      }
      if (this.pending && this.now() - this.pending.started > this.timeoutMs) this.clear()
      if (!this.pending && index === 0) {
        this.pending = { id, total, parts: [], size: 0, started: this.now() }
        this.timer = setTimeout(() => this.clear(), this.timeoutMs)
        this.timer.unref?.()
      }
      const pending = this.pending
      if (!pending || pending.id !== id || pending.total !== total || pending.parts.length !== index) {
        throw new Error('Out-of-order or expired WebRTC chunk')
      }
      pending.size += bytes(data)
      if (pending.size > WEBRTC_MESSAGE_BYTES) throw new Error('WebRTC command exceeds 512 KiB')
      pending.parts.push(data)
      if (pending.parts.length !== total) return null
      const text = pending.parts.join('')
      this.clear()
      // No nested framing or alternative authority: the normal event parser
      // still checks every reconstructed request, including text and controls.
      if (JSON.parse(text)?.type === CHUNK_TYPE) throw new Error('Nested WebRTC chunks are unsupported')
      return text
    } catch (error) { this.clear(); throw error }
  }
}
