/**
 * Confirm that a tracked Web Audio response has reached playback.
 *
 * The ordinary path calls this when AudioContext.currentTime reaches the
 * scheduled start. The source-ended path calls it as a fallback because an
 * Electron background renderer may throttle timers while the audio thread
 * continues rendering. A stopped/cleared source is no longer tracked and
 * therefore cannot be acknowledged by a late onended callback.
 */
export function confirmTrackedPlaybackStart(
  playback,
  responseId,
  onStarted,
  clearTimer = clearTimeout,
) {
  if (
    !responseId
    || !playback?.sourceCounts?.has(responseId)
    || playback.startedResponses.has(responseId)
  ) return false

  const timer = playback.startTimers.get(responseId)
  if (timer !== undefined) clearTimer(timer)
  playback.startTimers.delete(responseId)
  playback.startedResponses.add(responseId)
  onStarted?.(responseId)
  return true
}

function contextSinkId(context) {
  return context?.sinkId ?? ''
}

async function applySinkId(context, sinkId) {
  await context.setSinkId(sinkId)
}

/**
 * Keep a live AudioContext on the current default output device.
 *
 * Chromium and Electron bind the context to the output that was default at
 * construction. Plugging in headphones or changing the system default therefore
 * leaves playback on the old device even though microphone capture already
 * follows input changes. Re-applying the default sink does not replace the
 * context or reconnect Gateway.
 */
export async function followDefaultAudioOutput(context) {
  if (!context || context.state === 'closed') return false
  if (typeof context.setSinkId !== 'function') return false

  const previous = contextSinkId(context)
  try {
    try {
      await applySinkId(context, { type: 'none' })
    } catch {
      // Implementations without AudioSinkOptions still accept a device id.
    }
    await applySinkId(context, '')
    return true
  } catch {
    try {
      await applySinkId(context, previous)
    } catch {
      // Best-effort restore; the caller keeps the existing context.
    }
    return false
  }
}

/**
 * Owns only output-device follow. Microphone capture, Gateway, and the
 * playback queue stay outside this lifecycle so a speaker change cannot
 * reconnect the session.
 */
export function createPlaybackOutputFollow({
  mediaDevices,
  getContext,
  follow = followDefaultAudioOutput,
  debounceMs = 300,
  schedule = (callback, delay) => setTimeout(callback, delay),
  cancel = timer => clearTimeout(timer),
} = {}) {
  if (!mediaDevices?.addEventListener || typeof getContext !== 'function') {
    return {
      start() {},
      stop() {},
    }
  }

  let running = false
  let timer = null

  const clearTimer = () => {
    if (timer !== null) cancel(timer)
    timer = null
  }

  const handleDeviceChange = () => {
    if (!running) return
    clearTimer()
    timer = schedule(() => {
      timer = null
      void Promise.resolve(follow(getContext())).catch(() => {})
    }, debounceMs)
  }

  return {
    start() {
      if (running) return
      running = true
      mediaDevices.addEventListener('devicechange', handleDeviceChange)
    },
    stop() {
      if (!running) return
      running = false
      clearTimer()
      mediaDevices.removeEventListener('devicechange', handleDeviceChange)
    },
  }
}
