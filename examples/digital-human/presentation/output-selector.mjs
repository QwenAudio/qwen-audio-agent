// Per-response output selector: the single serialization point deciding
// whether reply audio flows to the avatar provider (divert) or straight to
// the normal audio egress (pass). Commit is exclusive and irreversible — a
// late provider first frame can never race a fallback that already flushed.
//
// BUFFERING -> COMMITTED_AVATAR | COMMITTED_AUDIO -> DRAINING -> TERMINAL
// any non-terminal state may transition to CANCELLED.

import { AudioRoute, SelectorState } from './contracts.mjs'

const DEFAULT_FIRST_MEDIA_TIMEOUT_MS = 3000
// 10 s of pending reply audio @ 24 kHz s16 mono — same bound as the renderer
// input admission queue, so the gateway falls back before the provider wedges.
const DEFAULT_MAX_BUFFERED_AUDIO_BYTES = 24000 * 2 * 10

export function createOutputSelector({
  responseId,
  firstMediaTimeoutMs = DEFAULT_FIRST_MEDIA_TIMEOUT_MS,
  maxBufferedAudioBytes = DEFAULT_MAX_BUFFERED_AUDIO_BYTES,
  onFallback = null,
} = {}) {
  if (!responseId) throw new Error('output selector requires a responseId')
  let state = SelectorState.BUFFERING
  let buffer = []
  let bufferedBytes = 0
  let timer = null

  function clearTimer() {
    if (timer) { clearTimeout(timer); timer = null }
  }

  function armFirstMediaTimer() {
    clearTimer()
    if (!Number.isFinite(firstMediaTimeoutMs) || firstMediaTimeoutMs <= 0) return
    timer = setTimeout(() => {
      timer = null
      if (state !== SelectorState.BUFFERING) return
      state = SelectorState.COMMITTED_AUDIO
      const flush = takeBuffer()
      onFallback?.({ responseId, reason: 'first_media_timeout', code: 'first_media_timeout', flush })
    }, firstMediaTimeoutMs)
    timer.unref?.()
  }

  function takeBuffer() {
    const flushed = buffer
    buffer = []
    bufferedBytes = 0
    return flushed
  }

  armFirstMediaTimer()

  return {
    get responseId() { return responseId },
    get state() { return state },
    get bufferedBytes() { return bufferedBytes },

    // Synchronous routing decision for one audio delta. `bytes` is the PCM
    // payload length used for the bounded-buffer check.
    routeAudio(delta, bytes = 0) {
      if (state === SelectorState.BUFFERING) {
        if (bufferedBytes + bytes > maxBufferedAudioBytes) {
          state = SelectorState.COMMITTED_AUDIO
          clearTimer()
          const flush = takeBuffer()
          onFallback?.({ responseId, reason: 'buffer_overflow', code: null, flush })
          return { route: AudioRoute.PASS, flush }
        }
        buffer.push(delta)
        bufferedBytes += bytes
        return { route: AudioRoute.DIVERT, flush: null }
      }
      if (
        state === SelectorState.COMMITTED_AVATAR
        || state === SelectorState.DRAINING
      ) return { route: AudioRoute.DIVERT, flush: null }
      return { route: AudioRoute.PASS, flush: null }
    },

    // Worker published the first media unit of this response to the track.
    // Returns false if the selector already committed elsewhere; the caller
    // must then quarantine this generation's media.
    commitAvatar() {
      if (state !== SelectorState.BUFFERING) return false
      state = SelectorState.COMMITTED_AVATAR
      clearTimer()
      buffer = []
      bufferedBytes = 0
      return true
    },

    // Orchestrator-elected fallback (provider error before anything was
    // published). Returns the buffered deltas to replay in order.
    commitAudio(reason = 'provider_failure') {
      if (state !== SelectorState.BUFFERING) return { committed: false, flush: [] }
      state = SelectorState.COMMITTED_AUDIO
      clearTimer()
      return { committed: true, flush: takeBuffer(), reason }
    },

    // Provider turn.completed plus worker drain, or plain audio egress done.
    markDraining() {
      if (
        state !== SelectorState.COMMITTED_AVATAR
        && state !== SelectorState.COMMITTED_AUDIO
      ) return false
      state = SelectorState.DRAINING
      return true
    },

    // Client playback receipt — the only signal that may reach TERMINAL.
    // Provider completion never impersonates it. BUFFERING may terminate
    // directly for responses that never produced audible output.
    markTerminal() {
      if (
        state === SelectorState.BUFFERING
        || state === SelectorState.COMMITTED_AVATAR
        || state === SelectorState.COMMITTED_AUDIO
        || state === SelectorState.DRAINING
      ) {
        state = SelectorState.TERMINAL
        clearTimer()
        return true
      }
      return false
    },

    cancel() {
      if (
        state === SelectorState.TERMINAL
        || state === SelectorState.CANCELLED
      ) return false
      state = SelectorState.CANCELLED
      clearTimer()
      buffer = []
      bufferedBytes = 0
      return true
    },

    close() {
      clearTimer()
      buffer = []
      bufferedBytes = 0
    },
  }
}
