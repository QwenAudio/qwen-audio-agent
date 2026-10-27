// Native RTC audio/video; no source-audio clock or inferred playback receipts.
export const ARTC_SDK_URL = 'https://g.alicdn.com/apsara-media-box/imp-web-rtc/7.1.9/aliyun-rtc-sdk.js'
let loading
// The pinned SDK exposes a singleton engine. A reconnect must wait for the
// previous player's leave/destroy before acquiring it, even across controllers.
let releaseBarrier = Promise.resolve()
let owner = null
export function loadArtcSdk() {
  if (globalThis.AliRtcEngine) return Promise.resolve(globalThis.AliRtcEngine)
  if (!loading) loading = new Promise((resolve, reject) => {
    const script = document.createElement('script')
    const timer = setTimeout(() => failed(), 30000)
    const failed = () => { clearTimeout(timer); script.remove(); loading = null; reject(new Error('ARTC SDK unavailable')) }
    script.src = ARTC_SDK_URL
    script.onload = () => { clearTimeout(timer); if (globalThis.AliRtcEngine) resolve(globalThis.AliRtcEngine); else failed() }
    script.onerror = failed
    document.head.append(script)
  })
  return loading
}
// Connection/track readiness does not prove that a particular response played.
export function createArtcPlayer({ video, onFrame = () => {}, loadSdk = loadArtcSdk,
  makeStream = tracks => new MediaStream(tracks), setTimer = setTimeout,
  clearTimer = clearTimeout, now = Date.now,
} = {}) {
  if (!video) throw new Error('ARTC requires a native video element')
  let session = null, closed = false, serial = Promise.resolve()
  const live = state => !closed && session === state && !state.cancelled
  const dispose = state => {
    if (!state) return Promise.resolve()
    state.disposing ||= (async () => {
      try { await state.engine?.leaveChannel() } catch {}
      try { await state.engine?.destroy() } catch {}
      if (owner === state) owner = null
    })()
    return state.disposing
  }
  const stop = state => {
    if (!state || state.cancelled) return
    state.cancelled = true; state.abortJoin?.(); clearTimer(state.expiry); clearTimer(state.readyTimer)
    video.muted = true; video.pause(); video.srcObject = null
    serial = serial.then(() => dispose(state))
    releaseBarrier = serial.catch(() => {})
  }
  const error = (state, cause) => {
    if (!live(state)) return
    stop(state)
    state.callbacks.onError?.(cause instanceof Error ? cause : new Error(cause))
  }
  const ready = state => {
    if (!live(state) || state.ready || !state.joined || !state.playSucceeded
      || video.paused || video.muted || video.srcObject !== state.stream) return
    const tracks = state.stream.getTracks()
    if (!['audio', 'video'].every(kind => tracks.some(track => track.kind === kind && track.readyState !== 'ended'))) return
    state.ready = true
    clearTimer(state.readyTimer)
    state.callbacks.onReady?.()
  }
  const waitForMedia = state => {
    if (!live(state) || !state.joined || !state.expectsMedia || state.ready || state.readyTimer) return
    state.readyTimer = setTimer(() => {
      if (!state.ready) error(state, 'ARTC media readiness timeout')
    }, 15000)
  }
  const play = state => {
    if (!live(state) || !state.stream.getTracks().length) return
    if (video.srcObject !== state.stream) video.srcObject = state.stream
    video.muted = false
    if (!video.paused && state.playSucceeded) { ready(state); return }
    state.playing ||= Promise.resolve().then(() => {
      if (live(state)) return video.play()
    }).then(() => {
      if (!live(state)) return
      state.playSucceeded = true
      ready(state)
    }).catch(() => error(state, 'ARTC native playback failed or blocked'))
      .finally(() => { state.playing = null })
  }
  return {
    // Vendors may publish their tracks only after receiving the first PCM.
    // Idle room membership is not missing media and must not start this timer.
    expectMedia() {
      if (!session || !live(session)) return
      session.expectsMedia = true
      waitForMedia(session)
    },
    disconnect() {
      stop(session)
      session = null
      return serial
    },
    connect(rtc, callbacks = {}) {
      if (closed || session) return false
      const state = session = { rtc, callbacks, stream: makeStream([]), cancelled: false }
      const priorCleanup = releaseBarrier
      serial = serial.then(async () => {
        await priorCleanup
        if (!live(state)) return
        if (owner) throw new Error('ARTC player already in use')
        owner = state
        const Engine = await loadSdk()
        if (!live(state)) return
        if (rtc.expires_at * 1000 <= now()) throw new Error('ARTC credentials expired')
        if (!(await Engine.isSupported()).support) throw new Error('ARTC unsupported')
        if (!live(state)) return
        const engine = state.engine = Engine.getInstance()
        engine.setPlayoutVolume(0) // the native element is the only audible RTC path
        for (const [kind, event] of [['audio', 'audioSubscribeStateChanged'], ['video', 'videoSubscribeStateChanged']]) {
          engine.on(event, async (uid, _previous, next) => {
            if (!live(state) || uid !== rtc.avatar_user_id || next !== 3 || state[kind]) return
            state[kind] = true
            try {
              const track = kind === 'audio' ? await engine.getAudioTrack(uid)
                : await engine.getVideoTrack({ userId: uid, streamType: 0 })
              if (!live(state)) return
              if (!track || track.kind !== kind) throw new Error('missing RTC track')
              state.stream.addTrack(track)
              if (kind === 'video') {
                if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(() => { if (live(state)) onFrame() })
                else onFrame()
              }
              play(state)
            } catch { error(state, 'ARTC track subscription failed') }
          })
        }
        for (const event of ['remoteAudioAutoPlayFail', 'remoteAudioPlayError', 'authInfoExpired', 'bye', 'connectionLost']) {
          engine.on(event, () => error(state, `ARTC ${event}`))
        }
        await engine.setChannelProfile('communication')
        await engine.publishLocalAudioStream(false); await engine.publishLocalVideoStream(false); await engine.enableLocalVideo(false)
        await engine.setDefaultSubscribeAllRemoteAudioStreams(true); await engine.setDefaultSubscribeAllRemoteVideoStreams(true)
        if (!live(state)) return
        await new Promise((resolve, reject) => {
          state.abortJoin = () => reject(new Error('ARTC join cancelled'))
          state.joinTimer = setTimer(() => reject(new Error('ARTC join timeout')), 10000)
          Promise.resolve(engine.joinChannel(rtc.token, rtc.user_id)).then(resolve, reject)
        }).finally(() => { clearTimer(state.joinTimer); state.abortJoin = null })
        if (!live(state)) return
        state.joined = true
        state.expiry = setTimer(() => error(state, 'ARTC credentials expired'), Math.min(rtc.expires_at * 1000 - now(), 2 * 60 * 60 * 1000))
        // Receiving is configured and the viewer is in the room. Source input
        // can now start; waiting for returned tracks here would deadlock a
        // vendor that creates them only when the first input arrives.
        callbacks.onInputReady?.()
        waitForMedia(state)
        ready(state)
      }).catch(cause => error(state, cause))
      return true
    },
    close() { if (!closed) { stop(session); closed = true }; return serial },
  }
}
