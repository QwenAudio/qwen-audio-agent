// Own the ONLY audible path. SDK automatic audio stays muted; its remote track
// is played through our AudioContext, so cancellation can gate audio immediately.
// Silence, stats, video frames and subscription never imply end-of-response.
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
export function createArtcPlayer({ audioContext: context, video, onFrame = () => {},
  loadSdk = loadArtcSdk, makeStream = track => new MediaStream([track]),
  setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now,
} = {}) {
  if (!context) throw new Error('ARTC requires an unlocked AudioContext')
  let active = null, closed = false, serial = Promise.resolve()
  const live = state => !closed && active === state && !state.cancelled
  const observedStart = state => {
    if (state.started || !state.analyser || context.state !== 'running' || state.gain?.gain.value !== 1) return
    const samples = new Float32Array(state.analyser.fftSize)
    state.analyser.getFloatTimeDomainData(samples)
    // Energy is observed on the actual audible graph, never on source PCM or
    // SDK stats. It cannot reveal the final media sample or prove queue drain.
    if (samples.some(sample => Math.abs(sample) > 0.001)) {
      state.started = true
      state.callbacks.onStarted?.()
    }
  }
  const stopLocal = state => {
    if (!state) return
    observedStart(state) // flush a delayed true start before controller decides replay safety
    state.cancelled = true
    state.abortJoin?.()
    clearTimer(state.poll)
    clearTimer(state.expiry)
    if (state.gain) state.gain.gain.value = 0
    state.source?.disconnect()
    state.gain?.disconnect()
    state.analyser?.disconnect()
    try { state.engine?.setPlayoutVolume(0) } catch {}
    if (video) { video.pause(); video.srcObject = null; video.muted = true }
  }
  const dispose = state => {
    if (!state) return Promise.resolve()
    state.disposing ||= (async () => {
      try { await state.engine?.leaveChannel() } catch {}
      try { await state.engine?.destroy() } catch {}
      if (owner === state) owner = null
    })()
    return state.disposing
  }
  const error = (state, message) => {
    if (!live(state)) return
    // Fence output before reporting. There is never an original-PCM replay.
    stopLocal(state)
    state.callbacks.onError?.(new Error(message))
    serial = serial.then(() => dispose(state))
    releaseBarrier = serial.catch(() => {})
  }
  const poll = state => {
    if (!live(state)) return
    if (context.state !== 'running') { error(state, 'ARTC audio playback suspended'); return }
    observedStart(state)
    state.poll = setTimer(() => poll(state), 20)
  }
  return {
    start(turn, rtc, callbacks) {
      if (closed) return false
      if (active) this.stop()
      const state = active = { turn, rtc, callbacks, cancelled: false, started: false }
      const priorCleanup = releaseBarrier
      serial = serial.then(async () => {
        await priorCleanup
        if (!live(state)) return
        if (owner) throw new Error('ARTC player already in use')
        owner = state
        const Engine = await loadSdk()
        if (!live(state)) return
        if (rtc.expires_at * 1000 <= now()) throw new Error('ARTC credentials expired')
        if (context.state !== 'running') throw new Error('Click Connect to enable ARTC audio playback')
        const support = await Engine.isSupported()
        if (!support.support) throw new Error('ARTC unsupported')
        if (!live(state)) return
        const engine = state.engine = Engine.getInstance()
        // These public methods are present in the pinned official Web SDK.
        if (typeof engine.getAudioTrack !== 'function' || typeof engine.setPlayoutVolume !== 'function') throw new Error('ARTC SDK track playback API unavailable')
        engine.setPlayoutVolume(0)
        engine.on('audioSubscribeStateChanged', async (uid, _previous, next) => {
          if (!live(state) || uid !== rtc.avatar_user_id || next !== 3 || state.attachingAudio) return
          state.attachingAudio = true
          try {
            const track = await engine.getAudioTrack(uid)
            if (!live(state)) return
            if (!track || track.kind !== 'audio') throw new Error('ARTC remote audio track unavailable')
            state.source = context.createMediaStreamSource(makeStream(track))
            state.analyser = context.createAnalyser()
            state.analyser.fftSize = 2048
            state.gain = context.createGain()
            state.gain.gain.value = 1
            state.source.connect(state.analyser).connect(state.gain).connect(context.destination)
            poll(state)
          } catch { error(state, 'ARTC remote audio playback failed') }
        })
        engine.on('videoSubscribeStateChanged', (uid, _previous, next) => {
          if (!live(state) || uid !== rtc.avatar_user_id || next !== 3 || !video) return
          video.muted = true
          try {
            engine.setRemoteViewConfig(video, uid, 1)
            video.muted = true
            Promise.resolve(video.play()).then(() => { if (live(state)) onFrame() }, () => error(state, 'ARTC autoplay blocked'))
          } catch { error(state, 'ARTC video playback failed') }
        })
        for (const event of ['remoteAudioAutoPlayFail', 'remoteAudioPlayError']) engine.on(event, uid => {
          if (!uid || uid === rtc.avatar_user_id) error(state, 'ARTC audio playback blocked')
        })
        for (const event of ['authInfoExpired', 'bye', 'connectionLost']) engine.on(event, () => error(state, `ARTC ${event}`))
        await engine.setChannelProfile('communication')
        await engine.publishLocalAudioStream(false)
        await engine.publishLocalVideoStream(false)
        await engine.enableLocalVideo(false)
        await engine.setDefaultSubscribeAllRemoteAudioStreams(true)
        await engine.setDefaultSubscribeAllRemoteVideoStreams(true)
        if (!live(state)) { await dispose(state); return }
        await new Promise((resolve, reject) => {
          state.abortJoin = () => reject(new Error('ARTC join cancelled'))
          state.joinTimer = setTimer(() => reject(new Error('ARTC join timeout')), 10000)
          Promise.resolve(engine.joinChannel(rtc.token, rtc.user_id)).then(resolve, reject)
        }).finally(() => { clearTimer(state.joinTimer); state.abortJoin = null })
        if (!live(state)) { await dispose(state); return }
        state.expiry = setTimer(() => error(state, 'ARTC credentials expired'), Math.min(rtc.expires_at * 1000 - now(), 2 * 60 * 60 * 1000))
      }).catch(cause => { error(state, cause?.message || 'ARTC initialization failed'); return dispose(state) })
      return true
    },
    // No end()/drained(): Vidu currently has no verifiable final-media marker.
    stop() {
      const state = active
      if (!state) return
      stopLocal(state)
      active = null
      serial = serial.then(() => dispose(state))
      releaseBarrier = serial.catch(() => {})
    },
    close() { this.stop(); closed = true; return serial },
  }
}
