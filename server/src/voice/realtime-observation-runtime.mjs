import { GatewayServerEvent } from '../../../shared/realtime-events.mjs'

export const OBSERVATION_INTERVAL_MS = 1000
export const OBSERVATION_MAX_FRAMES = 8
export const OBSERVATION_MAX_BASE64_BYTES = 256 * 1024

const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/

function isBase64(value) {
  if (!BASE64_PATTERN.test(value)) return false
  const padding = value.match(/=+$/)?.[0].length || 0
  const bodyLength = value.length - padding
  if (bodyLength % 4 === 1) return false
  if (!padding) return true
  if (value.length % 4 !== 0) return false
  return padding === 1
    ? bodyLength % 4 === 3
    : bodyLength % 4 === 2
}

function normalizeImage(value, maxBytes) {
  const image = String(value || '').trim()
  if (!image) throw new Error('画面观察缺少图片数据')
  if (image.length > maxBytes) {
    throw new Error('画面观察图片超过 256 KiB 限制')
  }
  if (!isBase64(image)) {
    throw new Error('画面观察图片不是有效的 Base64 数据')
  }
  return image
}

function statePayload(state, frames) {
  return {
    type: GatewayServerEvent.OBSERVATION_STATE,
    state,
    frames,
  }
}

/**
 * Relays explicitly-enabled browser camera frames to a Realtime provider.
 *
 * This runtime deliberately never calls response.create. The image buffer is
 * part of the provider's current audio timeline and is consumed by the next
 * user turn. Raw Base64 is kept only in a bounded in-memory ring while this
 * connection is observing; stop(), provider disconnects, and socket teardown
 * clear it.
 */
export class RealtimeObservationRuntime {
  constructor({
    ensureFrontend,
    getFrontend,
    send,
    onError,
    now = () => Date.now(),
    intervalMs = OBSERVATION_INTERVAL_MS,
    maxFrames = OBSERVATION_MAX_FRAMES,
    maxBase64Bytes = OBSERVATION_MAX_BASE64_BYTES,
  } = {}) {
    this.ensureFrontend = ensureFrontend
    this.getFrontend = getFrontend
    this.send = send
    this.onError = onError
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

  start() {
    if (this.state === 'active') return Promise.resolve(true)
    if (this.startPromise) return this.startPromise

    const generation = ++this.generation
    this.frames = []
    this.lastFrameAt = 0
    this.state = 'starting'
    this.#publish()

    const start = Promise.resolve()
      .then(() => this.ensureFrontend?.())
      .then(() => {
        if (generation !== this.generation) return false
        const frontend = this.getFrontend?.()
        if (!frontend || frontend.transportCapabilities?.observationInput !== true) {
          throw new Error('当前 Realtime 模型不支持画面观察')
        }
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
      normalized = normalizeImage(image, this.maxBase64Bytes)
    } catch (error) {
      this.onError?.(error)
      return false
    }

    const now = this.now()
    if (this.frames.length && now - this.lastFrameAt < this.intervalMs) return false

    const frontend = this.getFrontend?.()
    if (!frontend || frontend.transportCapabilities?.observationInput !== true) {
      this.stop('provider_unavailable')
      this.onError?.(new Error('画面观察的 Realtime 连接不可用'))
      return false
    }
    if (typeof frontend.send !== 'function') {
      this.stop('provider_unavailable')
      this.onError?.(new Error('Realtime 前台不支持画面观察传输'))
      return false
    }

    try {
      // DashScope Qwen-Omni WebSocket input contract. No response.create is
      // sent here, so observation alone never makes the assistant speak.
      const payload = typeof frontend.protocol?.imageAppend === 'function'
        ? frontend.protocol.imageAppend(normalized)
        : {
            type: 'input_image_buffer.append',
            image: normalized,
          }
      frontend.send(payload)
    } catch (error) {
      this.onError?.(error)
      return false
    }

    this.lastFrameAt = now
    this.frames.push({
      image: normalized,
      sequence: Number.isInteger(sequence) ? sequence : null,
      capturedAt: now,
    })
    if (this.frames.length > this.maxFrames) {
      this.frames.splice(0, this.frames.length - this.maxFrames)
    }
    this.#publish()
    return true
  }

  #publish(reason = '') {
    this.send?.({
      ...statePayload(this.state, this.frames.length),
      ...(reason ? { reason } : {}),
    })
  }
}

export { normalizeImage as normalizeObservationImage }
