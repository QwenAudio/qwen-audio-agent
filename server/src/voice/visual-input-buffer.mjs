export const VISUAL_INPUT_INTERVAL_MS = 1000
export const VISUAL_INPUT_MAX_BASE64_BYTES = 256 * 1024

const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/

function decodeJpeg(image, maxBase64Bytes) {
  const value = String(image || '').trim()
  if (!value) throw new Error('视觉帧缺少图片数据')
  if (Buffer.byteLength(value, 'utf8') > maxBase64Bytes) {
    throw new Error('视觉帧超过 256 KiB 限制')
  }
  if (
    !BASE64_PATTERN.test(value)
    || value.length % 4 !== 0
  ) {
    throw new Error('视觉帧不是有效的 Base64 数据')
  }
  const bytes = Buffer.from(value, 'base64')
  if (
    bytes.length < 4
    || bytes[0] !== 0xff
    || bytes[1] !== 0xd8
    || bytes.at(-2) !== 0xff
    || bytes.at(-1) !== 0xd9
  ) {
    throw new Error('视觉帧必须是完整的 JPEG 图片')
  }
  return value
}

/**
 * Validates and rate-limits the provider-neutral GCP image buffer.
 *
 * Raw frames are never retained after delivery. WebSocket ordering provides
 * transport order; occurredAt only detects a client replaying an older frame.
 */
export class VisualInputBuffer {
  constructor({
    onFrame,
    now = () => Date.now(),
    intervalMs = VISUAL_INPUT_INTERVAL_MS,
    maxBase64Bytes = VISUAL_INPUT_MAX_BASE64_BYTES,
  } = {}) {
    if (typeof onFrame !== 'function') throw new TypeError('onFrame is required')
    this.onFrame = onFrame
    this.now = now
    this.intervalMs = Math.max(1, Number(intervalMs) || VISUAL_INPUT_INTERVAL_MS)
    this.maxBase64Bytes = Math.max(
      4,
      Number(maxBase64Bytes) || VISUAL_INPUT_MAX_BASE64_BYTES,
    )
    this.lastAcceptedAt = null
    this.lastOccurredAt = null
    this.acceptedFrames = 0
    this.droppedFrames = 0
  }

  append({ image, mediaType = 'image/jpeg', occurredAt } = {}) {
    if (mediaType !== 'image/jpeg') {
      throw new Error(`不支持的视觉帧格式：${mediaType}`)
    }
    const capturedAt = Number(occurredAt)
    if (
      Number.isFinite(capturedAt)
      && capturedAt >= 0
      && this.lastOccurredAt !== null
      && capturedAt < this.lastOccurredAt
    ) {
      this.droppedFrames += 1
      return { accepted: false, reason: 'out_of_order' }
    }
    const acceptedAt = this.now()
    if (
      this.lastAcceptedAt !== null
      && acceptedAt - this.lastAcceptedAt < this.intervalMs
    ) {
      this.droppedFrames += 1
      return { accepted: false, reason: 'rate_limited' }
    }
    const normalized = decodeJpeg(image, this.maxBase64Bytes)
    const forwarded = this.onFrame(normalized)
    if (forwarded === false) {
      this.droppedFrames += 1
      return { accepted: false, reason: 'provider_unsupported' }
    }
    this.lastAcceptedAt = acceptedAt
    if (Number.isFinite(capturedAt) && capturedAt >= 0) {
      this.lastOccurredAt = capturedAt
    }
    this.acceptedFrames += 1
    return { accepted: true }
  }

  reset() {
    this.lastAcceptedAt = null
    this.lastOccurredAt = null
  }

  snapshot() {
    return {
      acceptedFrames: this.acceptedFrames,
      droppedFrames: this.droppedFrames,
      lastAcceptedAt: this.lastAcceptedAt,
      lastOccurredAt: this.lastOccurredAt,
    }
  }
}
