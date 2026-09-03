import {
  OBSERVATION_INTERVAL_MS,
  OBSERVATION_MAX_FRAMES,
  OBSERVATION_MAX_BASE64_BYTES,
  ObservationSessionRuntime,
  normalizeObservationImage,
} from './observation-session-runtime.mjs'
import { ForegroundObservationSink } from './foreground-observation-sink.mjs'
import { randomUUID } from 'node:crypto'

export {
  OBSERVATION_INTERVAL_MS,
  OBSERVATION_MAX_FRAMES,
  OBSERVATION_MAX_BASE64_BYTES,
  normalizeObservationImage,
}

/**
 * Compatibility composition for the current Realtime camera-observation API.
 *
 * The provider-neutral ObservationSessionRuntime owns lifecycle and frame
 * memory. The ForegroundObservationSink owns only the current Realtime wire
 * protocol, so a future background vision sink can subscribe without making
 * camera capture depend on the foreground model.
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
    this.foregroundSink = new ForegroundObservationSink({
      ensureFrontend,
      getFrontend,
      onError,
    })
    this.foregroundEnabled = true
    this.observationId = ''
    this.observationGeneration = 0
    this.session = new ObservationSessionRuntime({
      send,
      onError,
      now,
      intervalMs,
      maxFrames,
      maxBase64Bytes,
      onFrame: frame => {
        if (!this.foregroundEnabled) return true
        const forwarded = this.foregroundSink.forward(frame)
        if (!forwarded && this.foregroundSink.unavailable) {
          this.session.stop('provider_unavailable')
        }
        return forwarded
      },
    })
  }

  snapshot() {
    return this.session.snapshot()
  }

  get state() {
    return this.session.state
  }

  snapshotFrames(options) {
    return this.session.snapshotFrames(options)
  }

  observationMetadata() {
    return {
      observationId: this.observationId,
      generation: this.observationGeneration,
      state: this.state,
    }
  }

  start({ foreground = true } = {}) {
    if (this.session.state === 'active' || this.session.startPromise) {
      return this.session.start()
    }
    this.foregroundEnabled = foreground !== false
    this.observationId = `observation_${randomUUID().replaceAll('-', '')}`
    this.observationGeneration += 1
    return this.session.start({
      prepare: this.foregroundEnabled
        ? () => this.foregroundSink.prepare()
        : undefined,
    })
  }

  stop(reason = 'user') {
    this.foregroundSink.stop()
    this.foregroundEnabled = true
    this.session.stop(reason)
  }

  frame(event) {
    return this.session.frame(event)
  }
}
