// PCM/canvas playback for the self-hosted adapter, not a renderer requirement.
// AudioContext must be created/resumed by the caller's user gesture.
export function createBrowserAvatarPlayer({
  audioContext, canvas, onFrame = () => {},
  setTimer = setTimeout, clearTimer = clearTimeout,
  maxBufferedSeconds = 10, maxSources = 512, maxFrames = 256,
} = {}) {
  if (!audioContext) throw new Error('An unlocked AudioContext is required')
  const context = audioContext
  const painter = canvas?.getContext('2d')
  let active = null

  const markStarted = state => {
    if (active !== state || state.started || state.firstStart === null) return
    // A suspended context freezes currentTime. If it already passed the source
    // start, playback happened before suspension even if JS has not observed it.
    if (context.currentTime >= state.firstStart) {
      state.started = true
      state.callbacks.onStarted?.()
    }
  }
  const draw = frame => {
    if (!painter || !canvas) return
    const { width, height, data } = frame
    if (canvas.width !== width) canvas.width = width
    if (canvas.height !== height) canvas.height = height
    const image = painter.createImageData(width, height)
    const pixels = width * height
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const luma = data[y * width + x] - 16
        const chroma = Math.floor(y / 2) * width / 2 + Math.floor(x / 2)
        const u = data[pixels + chroma] - 128
        const v = data[pixels + pixels / 4 + chroma] - 128
        const offset = (y * width + x) * 4
        image.data[offset] = (298 * luma + 409 * v + 128) >> 8
        image.data[offset + 1] = (298 * luma - 100 * u - 208 * v + 128) >> 8
        image.data[offset + 2] = (298 * luma + 516 * u + 128) >> 8
        image.data[offset + 3] = 255
      }
    }
    painter.putImageData(image, 0, 0)
    onFrame(frame)
  }
  const finish = state => {
    if (active !== state || !state.ended || state.sources.size) return
    if (state.timer !== null) clearTimer(state.timer)
    active = null
    // Never turn an empty/silent placeholder into a successful delivery.
    if (state.started) state.callbacks.onDrained?.()
    else state.callbacks.onError?.(new Error('No response audio was played'))
  }
  const tick = state => {
    if (state.timer !== null) clearTimer(state.timer)
    state.timer = null
    if (active !== state) return
    markStarted(state)
    if (active !== state) return
    // This example has no pause/resume delivery mode. Fail closed instead of
    // leaving a stopped audio clock and a pending receipt polling forever.
    if (context.state !== 'running') { state.callbacks.onError?.(new Error('AudioContext is not running')); return }
    if (context.state === 'running') {
      // Drop superseded frames when a background tab wakes up.
      let due
      while (state.frames.length && state.frames[0].at <= context.currentTime) due = state.frames.shift()
      if (due) {
        try { draw(due.video) } catch (error) { state.callbacks.onError?.(error); return }
      }
    }
    finish(state)
    if (active === state && (state.sources.size || state.frames.length)) state.timer = setTimer(() => tick(state), 10)
  }
  const scheduleTick = state => {
    if (state.timer === null) state.timer = setTimer(() => tick(state), 10)
  }

  return {
    begin(key, callbacks) {
      if (active) this.clear(active.key)
      active = { key, callbacks, sources: new Set(), frames: [], cursor: context.currentTime,
        firstStart: null, started: false, ended: false, timer: null }
    },
    append(key, { audio, sampleRate = 24000, video, receiptEligible = true }) {
      const state = active
      if (!state || state.key !== key || state.ended) return
      if (!(audio instanceof Uint8Array) || audio.length % 2 || !Number.isInteger(sampleRate) || sampleRate <= 0) throw new Error('Invalid playback PCM')
      if (!audio.length) return
      if (context.state !== 'running') throw new Error('AudioContext is not running; click Connect to unlock audio')
      const start = Math.max(context.currentTime + 0.02, state.cursor)
      const duration = audio.length / 2 / sampleRate
      if (start + duration - context.currentTime > maxBufferedSeconds || state.sources.size >= maxSources
        || (video && state.frames.length >= maxFrames)) throw new Error('Playback buffer limit exceeded')
      const buffer = context.createBuffer(1, audio.length / 2, sampleRate)
      const samples = buffer.getChannelData(0)
      const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength)
      for (let index = 0; index < samples.length; index += 1) samples[index] = view.getInt16(index * 2, true) / 32768
      const source = context.createBufferSource()
      source.buffer = buffer
      source.connect(context.destination)
      source.onended = () => {
        if (active !== state || !state.sources.has(source)) return
        markStarted(state)
        state.sources.delete(source)
        source.disconnect?.()
        tick(state)
      }
      state.sources.add(source)
      try { source.start(start) } catch (error) { state.sources.delete(source); source.disconnect?.(); throw error }
      state.cursor = start + duration
      if (receiptEligible && state.firstStart === null) state.firstStart = start
      // A paired frame belongs to this audio chunk. Audio sample clock, not the
      // renderer's wall clock (some DHAV renderers timestamp the chunk's end).
      if (video && receiptEligible) state.frames.push({ at: start, video })
      scheduleTick(state)
    },
    end(key) {
      if (!active || active.key !== key) return
      active.ended = true
      tick(active)
    },
    clear(key) {
      const state = active
      if (!state || (key !== undefined && state.key !== key)) return
      // Close the timer race: elapsed audio cannot be replayed as fallback even
      // if the JS start callback was throttled in a background tab.
      markStarted(state)
      if (active !== state) return
      active = null
      if (state.timer !== null) clearTimer(state.timer)
      state.frames.length = 0
      for (const source of state.sources) {
        source.onended = null
        try { source.stop() } catch {}
        source.disconnect?.()
      }
      state.sources.clear()
    },
  }
}
