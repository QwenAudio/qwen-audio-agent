const DEFAULT_RETRY_DELAYS = Object.freeze([500, 1_000, 2_000, 4_000])

export function recoverableMicrophoneError(error) {
  return ![
    'NotAllowedError',
    'NotSupportedError',
    'SecurityError',
    'TypeError',
  ].includes(String(error?.name || ''))
}

function audioTrack(capture) {
  return capture?.track || capture?.media?.getAudioTracks?.()[0] || null
}

/**
 * Owns only microphone capture. Gateway, Realtime, and output playback remain
 * outside this lifecycle so changing an input device cannot reconnect or
 * interrupt them.
 */
export function createMicrophoneCaptureLifecycle({
  mediaDevices,
  acquire,
  release = capture => capture?.close?.(),
  onState = () => {},
  onFatalError = () => {},
  debounceMs = 300,
  muteGraceMs = 1_500,
  retryDelays = DEFAULT_RETRY_DELAYS,
  schedule = (callback, delay) => setTimeout(callback, delay),
  cancel = timer => clearTimeout(timer),
} = {}) {
  if (!mediaDevices?.getUserMedia || typeof acquire !== 'function') {
    throw new Error('microphone capture requires mediaDevices and acquire')
  }

  let running = false
  let generation = 0
  let currentCapture = null
  let restartTimer = null
  let retryTimer = null
  let muteTimer = null
  let retryAttempt = 0

  const clearTimer = name => {
    const timer = name === 'restart'
      ? restartTimer
      : name === 'retry'
        ? retryTimer
        : muteTimer
    if (timer !== null) cancel(timer)
    if (name === 'restart') restartTimer = null
    else if (name === 'retry') retryTimer = null
    else muteTimer = null
  }

  const detachCapture = () => {
    const capture = currentCapture
    if (!capture) return
    currentCapture = null
    clearTimer('mute')
    const track = audioTrack(capture)
    track?.removeEventListener?.('ended', capture.handleEnded)
    track?.removeEventListener?.('mute', capture.handleMute)
    track?.removeEventListener?.('unmute', capture.handleUnmute)
    release(capture)
  }

  const installTrackListeners = capture => {
    const track = audioTrack(capture)
    if (!track?.addEventListener) return
    capture.handleEnded = () => requestRestart('track-ended', 0)
    capture.handleMute = () => {
      clearTimer('mute')
      muteTimer = schedule(() => {
        muteTimer = null
        if (track.muted !== false) requestRestart('track-muted', 0)
      }, muteGraceMs)
    }
    capture.handleUnmute = () => clearTimer('mute')
    track.addEventListener('ended', capture.handleEnded)
    track.addEventListener('mute', capture.handleMute)
    track.addEventListener('unmute', capture.handleUnmute)
  }

  const replaceCapture = async reason => {
    if (!running) return
    clearTimer('restart')
    clearTimer('retry')
    const attemptGeneration = ++generation
    detachCapture()
    onState({
      state: reason === 'initial' ? 'starting' : 'recovering',
      reason,
    })
    try {
      const capture = await acquire({ reason, generation: attemptGeneration })
      if (!running || attemptGeneration !== generation) {
        release(capture)
        return
      }
      currentCapture = capture
      retryAttempt = 0
      installTrackListeners(capture)
      onState({ state: 'ready', reason })
    } catch (error) {
      if (!running || attemptGeneration !== generation) return
      if (!recoverableMicrophoneError(error)) {
        onState({ state: 'unavailable', reason, error, recoverable: false })
        onFatalError(error)
        return
      }
      const delay = retryDelays[retryAttempt]
      retryAttempt += 1
      const retrying = Number.isFinite(delay)
      onState({
        state: retrying ? 'recovering' : 'unavailable',
        reason,
        error,
        recoverable: true,
      })
      if (retrying) {
        retryTimer = schedule(() => {
          retryTimer = null
          void replaceCapture('retry')
        }, delay)
      }
    }
  }

  function requestRestart(reason = 'devicechange', delay = debounceMs) {
    if (!running) return
    if (reason === 'devicechange') retryAttempt = 0
    clearTimer('restart')
    clearTimer('retry')
    restartTimer = schedule(() => {
      restartTimer = null
      void replaceCapture(reason)
    }, delay)
  }

  const handleDeviceChange = () => requestRestart('devicechange')

  return {
    start() {
      if (running) return
      running = true
      mediaDevices.addEventListener?.('devicechange', handleDeviceChange)
      void replaceCapture('initial')
    },
    stop() {
      if (!running) return
      running = false
      generation += 1
      mediaDevices.removeEventListener?.('devicechange', handleDeviceChange)
      clearTimer('restart')
      clearTimer('retry')
      clearTimer('mute')
      detachCapture()
    },
    restart(reason = 'manual') {
      retryAttempt = 0
      requestRestart(reason, 0)
    },
  }
}
