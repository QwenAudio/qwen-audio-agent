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
