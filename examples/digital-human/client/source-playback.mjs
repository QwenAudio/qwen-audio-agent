// The original PCM timeline owns Gateway receipts. Vidu is only a mirror.
// Muting changes the gain, never the samples, source schedule or lifecycle.
export function createSourcePlayback({ audioContext: context, sendGateway, onStatus = () => {},
  audible = false, setTimer = setTimeout, clearTimer = clearTimeout,
} = {}) {
  const output = context.createGain()
  output.gain.value = audible ? 1 : 0
  output.connect(context.destination)
  const records = new Map(), retired = new Set()
  let cursor = 0, turnId = '', closed = false
  const receipt = (type, record, reason) => sendGateway({ type, responseId: record.id, ...(reason ? { reason } : {}) })
  const status = () => onStatus({ state: [...records.values()].some(r => r.started) ? 'speaking' : 'idle' })
  const started = record => {
    if (records.get(record.id) !== record || record.started || context.currentTime < record.firstStart) return
    record.started = true
    receipt('playback.started', record)
    status()
  }
  const finish = record => {
    if (records.get(record.id) !== record || !record.done || record.sources.size || !record.started) return
    clearTimer(record.timer)
    records.delete(record.id); retired.add(record.id)
    receipt('playback.ended', record)
    status()
  }
  const observe = record => {
    if (records.get(record.id) !== record) return
    started(record)
    finish(record)
    if (!record.started) record.timer = setTimer(() => observe(record), 20)
  }
  const cancel = (record, reason) => {
    // Keep the existing client's cancellation semantics, independent of RTC.
    records.delete(record.id); retired.add(record.id)
    clearTimer(record.timer)
    receipt('playback.cancelled', record, reason)
    for (const source of record.sources) {
      source.onended = null
      try { source.stop() } catch {}
      source.disconnect()
    }
    record.sources.clear()
  }
  const clear = reason => {
    for (const record of [...records.values()]) cancel(record, reason)
    cursor = 0
    status()
  }
  const append = event => {
    if (!event.responseId || retired.has(event.responseId)) return
    let record = records.get(event.responseId)
    if (record?.done) return
    if (!record) {
      if (retired.size >= 4096 || records.size >= 8) throw new Error('Source response tracking limit exceeded')
      record = { id: event.responseId, sources: new Set(), firstStart: Infinity, started: false, done: false, timer: null }
      records.set(record.id, record)
    }
    try {
      const rate = event.sampleRate ?? 24000
      if (!Number.isInteger(rate) || rate <= 0 || typeof event.audio !== 'string' || event.audio.length > 6_400_000) throw new Error('Invalid source PCM')
      const bytes = Uint8Array.from(atob(event.audio), c => c.charCodeAt(0))
      if (!bytes.length || bytes.length % 2) throw new Error('Invalid source PCM')
      if (context.state === 'suspended') void context.resume().catch(() => {
        if (records.get(record.id) === record) { cancel(record, 'playback_error'); status() }
      })
      const buffer = context.createBuffer(1, bytes.length / 2, rate)
      const values = buffer.getChannelData(0), view = new DataView(bytes.buffer)
      for (let i = 0; i < values.length; i++) values[i] = view.getInt16(i * 2, true) / 32768
      const source = context.createBufferSource()
      source.buffer = buffer
      source.connect(output)
      // Same 20 ms scheduling lead as the ordinary local Web client. There
      // is no Vidu-specific reserve, wait or source-duration timer here.
      const start = Math.max(context.currentTime + 0.02, cursor)
      cursor = start + buffer.duration
      record.firstStart = Math.min(record.firstStart, start)
      record.sources.add(source)
      source.onended = () => {
        if (records.get(record.id) !== record || !record.sources.has(source)) return
        started(record)
        record.sources.delete(source)
        source.disconnect()
        finish(record)
      }
      source.start(start)
      if (!record.started && record.timer === null) record.timer = setTimer(() => observe(record), Math.max(0, (start - context.currentTime) * 1000))
    } catch {
      cancel(record, 'playback_error'); status()
    }
  }
  return {
    setAudible(value) { output.gain.value = value ? 1 : 0 },
    handleGateway(event) {
      if (closed) return
      if (event.type === 'turn.started') turnId = event.turnId || ''
      else if (event.type === 'playback.clear') clear(event.reason || '')
      else if (event.type === 'voice.state' && event.state === 'listening'
        && (!event.turnId || event.turnId === turnId || event.origin !== 'model')) clear('user_interruption')
      else if (event.type === 'response.interrupted') {
        const record = records.get(event.responseId)
        if (record) { cancel(record, event.reason || 'user_interruption'); status() }
        else retired.add(event.responseId)
      } else if (event.type === 'audio.delta') append(event)
      else if (event.type === 'audio.done') {
        const record = records.get(event.responseId)
        if (record) { record.done = true; finish(record) }
      }
    },
    close(reason = 'closed') { if (!closed) { closed = true; clear(reason); output.disconnect() } },
  }
}
