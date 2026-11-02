import { decodeDhavRecord, RecordKind } from '../dhav-decoder.mjs'

// The DHAV-specific wire/session state lives here. An RTC renderer implements
// this same playback lifecycle directly, without decoding/re-encoding DHAV.
export function createDhavRenderer({ player, sendRenderer,
  mediaTimeoutMs = 15000, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let avatarSessionId = null
  let active = null
  let closed = false
  const send = message => {
    if (closed || sendRenderer(message) === false) throw new Error('Renderer connection unavailable')
  }
  const current = turn => active && active.turn.responseId === turn.responseId && active.turn.generation === turn.generation
  const clearWatch = state => { if (state.timer !== null) clearTimer(state.timer); state.timer = null }
  const watch = state => {
    clearWatch(state)
    state.timer = setTimer(() => {
      state.timer = null
      if (active === state) state.callbacks.onError(new Error('Renderer media timeout'))
    }, mediaTimeoutMs)
  }
  return {
    startTurn(turn, callbacks) {
      if (!avatarSessionId) throw new Error('Renderer session is not ready')
      if (active) throw new Error('Renderer already has an active turn')
      const state = { turn: { ...turn }, key: `${turn.generation}:${turn.responseId}`, callbacks,
        sequence: 0, sampleOffset: 0, ended: false, timer: null }
      active = state
      player.begin(state.key, {
        onStarted: () => { if (active === state) callbacks.onStarted() },
        onDrained: () => {
          if (active !== state) return
          clearWatch(state)
          active = null
          callbacks.onDrained()
        },
        onError: error => { if (active === state) callbacks.onError(error) },
      })
      watch(state)
      send({ type: 'turn.start', ...turn })
    },
    appendAudio(turn, audio) { if (current(turn)) send({ type: 'audio.append', ...turn, audio, sampleRate: 24000 }) },
    endTurn(turn) { if (current(turn)) send({ type: 'audio.end', ...turn }) },
    cancelTurn(turn, reason) {
      if (!current(turn)) return
      const state = active
      clearWatch(state)
      // clear() flushes any elapsed audio start before fencing callbacks.
      player.clear(state.key)
      active = null
      try { send({ type: 'turn.cancel', ...turn, reason }) } catch {}
    },
    handleMessage(message) {
      if (closed) return
      let value
      try {
        value = typeof message === 'string' ? JSON.parse(message) : message
        if (value && !ArrayBuffer.isView(value) && !(value instanceof ArrayBuffer)) {
          if (value.type === 'session.ready') {
            if (typeof value.avatarSessionId !== 'string' || !value.avatarSessionId || value.avatarSessionId.length > 256) throw new Error('Invalid renderer session')
            if (active && avatarSessionId !== value.avatarSessionId) throw new Error('Renderer session changed during playback')
            avatarSessionId = value.avatarSessionId
          } else if (value.type === 'renderer.error' && active
            && (!value.responseId || value.responseId === active.turn.responseId)
            && (value.generation === undefined || value.generation === active.turn.generation)) {
            throw new Error(value.message || 'Renderer failed')
          }
          return
        }
        const record = decodeDhavRecord(value)
        const { header } = record
        if (header.turn.avatarSessionId !== avatarSessionId) return
        // Idle animation belongs to no reply: paint it without an active turn and
        // keep it off the receipt-bearing timeline. Optional, so a renderer whose
        // player owns a continuous RTC track can simply not implement it.
        if (record.kind === RecordKind.PAIRED_AV && header.idle) {
          player.paintIdle?.({ ...header.video, data: record.video })
          return
        }
        const state = active
        if (!state || !current(header.turn) || state.ended) return
        if (record.kind === RecordKind.MEDIA_END) {
          if (header.lastSequence !== state.sequence - 1 || header.reason !== 'finished') throw new Error(`Renderer ended unexpectedly: ${header.reason}`)
          state.ended = true
          clearWatch(state)
          player.end(state.key)
          return
        }
        if (record.kind !== RecordKind.PAIRED_AV) throw new Error('Unexpected renderer input record')
        if (header.sequence < state.sequence) return
        if (header.sequence !== state.sequence || header.sampleOffset !== state.sampleOffset) throw new Error('Renderer media discontinuity')
        if (header.format.sampleRate !== 24000) throw new Error('Expected renderer PCM24k')
        state.sequence += 1
        state.sampleOffset += header.samples - header.paddingSamples
        watch(state)
        // Synthetic padding and silent frames never acknowledge assistant
        // playback. Trim terminal padding instead of treating it as speech.
        const actualSamples = header.samples - header.paddingSamples
        if (!header.silence && actualSamples > 0) {
          player.append(state.key, { audio: record.audio.subarray(0, actualSamples * 2), sampleRate: header.format.sampleRate,
            video: { ...header.video, data: record.video }, receiptEligible: true })
        }
      } catch (error) { active?.callbacks.onError(error) }
    },
    disconnected(reason) {
      avatarSessionId = null
      if (active) active.callbacks.onError(new Error(reason || 'Renderer disconnected'))
    },
    close() {
      if (active) { clearWatch(active); player.clear(active.key); active = null }
      avatarSessionId = null
      closed = true
    },
  }
}
