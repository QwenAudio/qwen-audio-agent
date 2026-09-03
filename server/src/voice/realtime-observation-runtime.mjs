import {
  OBSERVATION_INTERVAL_MS,
  OBSERVATION_MAX_FRAMES,
  OBSERVATION_MAX_BASE64_BYTES,
  ObservationSessionRuntime,
  normalizeObservationImage,
} from './observation-session-runtime.mjs'
import { ForegroundObservationSink } from './foreground-observation-sink.mjs'

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
    this.session = new ObservationSessionRuntime({
      send,
      onError,
      now,
      intervalMs,
      maxFrames,
      maxBase64Bytes,
      onFrame: frame => {
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

  start() {
    return this.session.start({
      prepare: () => this.foregroundSink.prepare(),
    })
  }

  stop(reason = 'user') {
    this.foregroundSink.stop()
    this.session.stop(reason)
  }

  frame(event) {
    return this.session.frame(event)
  }
}
