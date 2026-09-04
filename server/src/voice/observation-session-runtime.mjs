import { GatewayServerEvent } from '../../../shared/realtime-events.mjs'

export const OBSERVATION_INTERVAL_MS = 1000
export const OBSERVATION_MAX_FRAMES = 8
export const OBSERVATION_MAX_BASE64_BYTES = 256 * 1024

const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/

function statePayload(state, frames) {
  return {
    type: GatewayServerEvent.OBSERVATION_STATE,
    state,
    frames,
  }
}

export function normalizeObservationImage(value, maxBytes = OBSERVATION_MAX_BASE64_BYTES) {
  const image = String(value || '').trim()
  if (!image) throw new Error('画面观察缺少图片数据')
  if (image.length > maxBytes) {
    throw new Error('画面观察图片超过 256 KiB 限制')
  }
  if (image.length % 4 === 1 || !BASE64_PATTERN.test(image)) {
    throw new Error('画面观察图片不是有效的 Base64 数据')
  }
  return image
}

/**
 * Owns the provider-neutral lifecycle and bounded frame buffer for an
 * explicitly-enabled camera observation session.
 *
 * The session has no knowledge of Realtime providers. Consumers may attach a
 * foreground sink, a background vision scheduler, or both through onFrame.
 */
export class ObservationSessionRuntime {
  constructor({
    send,
    onError,
    onFrame,
    now = () => Date.now(),
    intervalMs = OBSERVATION_INTERVAL_MS,
    maxFrames = OBSERVATION_MAX_FRAMES,
    maxBase64Bytes = OBSERVATION_MAX_BASE64_BYTES,
  } = {}) {
    this.send = send
    this.onError = onError
    this.onFrame = onFrame
    this.now = now
    this.intervalMs = Math.max(1, Number(intervalMs) || OBSERVATION_INTERVAL_MS)
    this.maxFrames = Math.max(1, Math.floor(Number(maxFrames) || OBSERVATION_MAX_FRAMES))
    this.maxBase64Bytes = Math.max(
      4,
      Math.floor(Number(maxBase64Bytes) || OBSERVATION_MAX_BASE64_BYTES),
    )
    this.state = 'idle'
    this.frames = []
    this.lastFrameAt = 0
    this.generation = 0
    this.startPromise = null
  }

  snapshot() {
    return {
      state: this.state,
      frames: this.frames.length,
      lastFrameAt: this.lastFrameAt,
    }
  }

  snapshotFrames({ limit = this.maxFrames } = {}) {
    const safeLimit = Math.max(1, Math.floor(Number(limit) || this.maxFrames))
    return this.frames.slice(-safeLimit).map(frame => ({ ...frame }))
  }

  start({ prepare } = {}) {
    if (this.state === 'active') return Promise.resolve(true)
    if (this.startPromise) return this.startPromise

    const generation = ++this.generation
    this.frames = []
    this.lastFrameAt = 0
    this.state = 'starting'
    this.#publish()

    const start = Promise.resolve()
      .then(() => prepare?.())
      .then(() => {
        if (generation !== this.generation) return false
        this.state = 'active'
        this.#publish()
        return true
      })
      .catch(error => {
        if (generation !== this.generation) return false
        this.state = 'unavailable'
        this.frames = []
        this.lastFrameAt = 0
        this.#publish()
        this.onError?.(error)
        return false
      })
      .finally(() => {
        if (this.startPromise === start) this.startPromise = null
      })
    this.startPromise = start
    return start
  }

  stop(reason = 'user') {
    const safeReason = String(reason || 'user').slice(0, 80)
    const hadObservation = (
      this.state !== 'idle'
      || Boolean(this.startPromise)
      || this.frames.length > 0
    )
    this.generation += 1
    this.startPromise = null
    this.state = 'idle'
    this.frames = []
    this.lastFrameAt = 0
    if (hadObservation) this.#publish(safeReason)
  }

  frame({ image, sequence } = {}) {
    if (this.state !== 'active') return false

    let normalized
    try {
      normalized = normalizeObservationImage(image, this.maxBase64Bytes)
    } catch (error) {
      this.onError?.(error)
      return false
    }

    const now = this.now()
    if (this.frames.length && now - this.lastFrameAt < this.intervalMs) return false

    this.lastFrameAt = now
    const frame = {
      image: normalized,
      sequence: Number.isInteger(sequence) ? sequence : null,
      capturedAt: now,
    }
    this.frames.push(frame)
    if (this.frames.length > this.maxFrames) {
      this.frames.splice(0, this.frames.length - this.maxFrames)
    }

    try {
      const delivered = this.onFrame?.({ ...frame })
      if (delivered && typeof delivered.then === 'function') {
        void delivered.catch(error => this.onError?.(error))
      }
      this.#publish()
      return delivered !== false
    } catch (error) {
      this.onError?.(error)
      this.#publish()
      return false
    }
  }

  #publish(reason = '') {
    this.send?.({
      ...statePayload(this.state, this.frames.length),
      ...(reason ? { reason } : {}),
    })
  }
}
