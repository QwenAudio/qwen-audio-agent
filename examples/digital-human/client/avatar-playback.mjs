// Renderer-neutral response delivery. A renderer can play PCM/canvas, remote
// RTC, or another medium. It must callback only for *actual* playback:
// startTurn(turn, {onStarted,onDrained,onError}), appendAudio(turn, base64),
// endTurn(turn), cancelTurn(turn, reason). cancelTurn synchronously stops output
// and reports an elapsed start before returning (even if JS timers were late).
// No renderer-ready/session ID, DHAV, video, or transport assumption lives here.
export class AvatarPlaybackController {
  constructor({ renderer, fallbackPlayer, sendGateway, onStatus = () => {},
    maxBufferedBytes = 4_800_000, maxPendingResponses = 8, maxTrackedResponses = 4096,
    firstPlaybackTimeoutMs = 15000,
    setTimer = (callback, delay) => setTimeout(callback, delay), clearTimer = id => clearTimeout(id) } = {}) {
    if (!renderer || typeof sendGateway !== 'function') throw new Error('renderer and sendGateway are required')
    Object.assign(this, { renderer, fallbackPlayer, sendGateway, onStatus, maxBufferedBytes,
      maxPendingResponses, maxTrackedResponses, firstPlaybackTimeoutMs, setTimer, clearTimer })
    this.records = new Map()
    this.known = new Set()
    this.retired = new Set()
    this.active = null
    this.generation = 0
    this.bufferedBytes = 0
    this.closed = false
  }

  handleGateway(event) {
    if (this.closed || !event || typeof event !== 'object') return
    const id = event.responseId || event.response?.id || event.response_id
    if (event.type === 'playback.clear' || event.type === 'response.interrupted') {
      this._clear(id, event.reason || 'interrupted')
      return
    }
    if (typeof id !== 'string' || !id || id.length > 256 || this.retired.has(id)) return
    if (!this.known.has(id)) {
      if (this.known.size >= this.maxTrackedResponses) { this.close('response_tracking_limit'); return }
      this.known.add(id)
    }
    if (event.type === 'response.done') {
      if (['failed', 'cancelled', 'incomplete'].includes(event.response?.status || event.status)) {
        this._clear(id, event.response?.status || event.status)
      }
      // Generation completion is not an audio-stream boundary or a receipt.
      return
    }
    if (event.type === 'audio.done') {
      const record = this.records.get(id)
      if (record && !record.inputEnded) {
        record.inputEnded = true
        if (this.active === record) this._end(record)
      } else if (!record) this.retired.add(id)
      return
    }
    if (event.type !== 'audio.delta' || !event.audio) return
    let bytes
    try {
      if (event.sampleRate !== undefined && event.sampleRate !== 24000) throw new Error('Expected PCM24k')
      bytes = decodePcmBase64(event.audio, this.maxBufferedBytes)
    } catch (error) { this._rejectAudio(id, error.message); return }
    if (!bytes.length) return
    let record = this.records.get(id)
    if (!record) {
      if (this.records.size >= this.maxPendingResponses) { this._rejectAudio(id, 'response_queue_limit'); return }
      record = { id, chunks: [], bytes: 0, started: false, inputEnded: false, mode: 'queued', outputEpoch: 0, timer: null }
      this.records.set(id, record)
    }
    if (record.inputEnded) return
    const retain = !record.started && record.mode !== 'fallback'
    if (retain) {
      if (this.bufferedBytes + bytes.length > this.maxBufferedBytes) { this._cancel(record, 'source_buffer_limit'); return }
      record.chunks.push({ audio: event.audio, bytes })
      record.bytes += bytes.length
      this.bufferedBytes += bytes.length
    }
    if (!this.active) this._pump()
    else if (this.active === record) this._append(record, event.audio, bytes)
  }

  handleRenderer(data) { if (!this.closed) this.renderer.handleMessage?.(data) }
  rendererDisconnected(reason = 'renderer_disconnected') {
    if (this.closed) return
    this.renderer.disconnected?.(reason)
    if (this.active?.mode === 'renderer') this._fail(this.active, new Error(reason))
  }
  close(reason = 'closed') {
    if (this.closed) return
    this.closed = true
    this._clear(undefined, reason)
    this.renderer.close?.()
  }

  _status(state, record, reason) {
    this.onStatus({ state, responseId: record?.id, reason, output: record?.mode === 'fallback' ? 'audio_only' : 'renderer' })
  }
  _rejectAudio(id, reason) {
    if (!this.records.has(id)) this._receipt('playback.cancelled', { id }, reason)
    this._clear(id, reason)
  }
  _receipt(type, record, reason) {
    try { this.sendGateway({ type, responseId: record.id, ...(reason ? { reason } : {}) }) }
    catch { this._status('error', record, 'gateway_send_failed') }
  }
  _release(record) {
    this.bufferedBytes -= record.bytes
    record.bytes = 0
    record.chunks.length = 0
  }
  _callbacks(record) {
    const epoch = ++record.outputEpoch
    const current = () => this.active === record && record.outputEpoch === epoch && this.records.get(record.id) === record
    return {
      onStarted: () => {
        if (!current() || record.started) return
        record.started = true
        if (record.timer !== null) this.clearTimer(record.timer)
        record.timer = null
        this._release(record)
        this._receipt('playback.started', record)
        this._status('speaking', record)
      },
      onDrained: () => {
        if (!current()) return
        if (!record.started || !record.inputEnded) { this._fail(record, new Error('Premature renderer drain')); return }
        this._receipt('playback.ended', record)
        this._retire(record)
      },
      onError: error => { if (current()) this._fail(record, error) },
    }
  }
  _call(record, operation) {
    try {
      const result = operation()
      if (result === false) throw new Error('Renderer backpressure or unavailable')
      result?.catch?.(error => { if (this.active === record && record.mode === 'renderer') this._fail(record, error) })
    } catch (error) { this._fail(record, error) }
  }
  _pump() {
    if (this.closed || this.active) return
    const record = this.records.values().next().value
    if (!record) { this._status('idle'); return }
    this.active = record
    record.mode = 'renderer'
    record.turn = { responseId: record.id, generation: ++this.generation }
    record.key = `${record.turn.generation}:${record.id}`
    this._status('rendering', record)
    record.timer = this.setTimer(() => {
      record.timer = null
      if (this.active === record && !record.started) this._fail(record, new Error('Renderer first playback timeout'))
    }, this.firstPlaybackTimeoutMs)
    this._call(record, () => this.renderer.startTurn(record.turn, this._callbacks(record)))
    for (const chunk of [...record.chunks]) {
      if (this.active !== record || record.mode !== 'renderer') break
      this._append(record, chunk.audio, chunk.bytes)
    }
    if (this.active === record && record.mode === 'renderer' && record.inputEnded) this._end(record)
  }
  _append(record, audio, bytes) {
    if (record.mode === 'renderer') this._call(record, () => this.renderer.appendAudio(record.turn, audio))
    else if (record.mode === 'fallback') {
      try { this.fallbackPlayer.append(record.key, { audio: bytes, sampleRate: 24000 }) }
      catch (error) { this._cancel(record, error.message || 'playback_failed') }
    }
  }
  _end(record) {
    if (record.mode === 'renderer') this._call(record, () => this.renderer.endTurn(record.turn))
    else if (record.mode === 'fallback') this.fallbackPlayer.end(record.key)
  }
  _fail(record, error) {
    if (this.active !== record || record.failing) return
    record.failing = true
    if (record.mode === 'renderer') {
      // This call synchronously fences remote media and flushes any actual start
      // before we decide whether replaying original PCM is still safe.
      try { this.renderer.cancelTurn(record.turn, 'renderer_failed') } catch {}
    }
    const reason = error?.message || String(error || 'renderer_failed')
    if (record.started || record.mode !== 'renderer' || !this.fallbackPlayer || !record.chunks.length) {
      record.failing = false
      this._cancel(record, reason)
      return
    }
    record.mode = 'fallback'
    record.failing = false
    if (record.timer !== null) this.clearTimer(record.timer)
    record.timer = null
    this._status('audio_only', record, reason)
    const chunks = [...record.chunks]
    this._release(record)
    try {
      this.fallbackPlayer.begin(record.key, this._callbacks(record))
      for (const chunk of chunks) {
        if (this.active !== record) break
        this.fallbackPlayer.append(record.key, { audio: chunk.bytes, sampleRate: 24000 })
      }
      if (this.active === record && record.inputEnded) this.fallbackPlayer.end(record.key)
    } catch (failure) { this._cancel(record, failure.message || 'fallback_failed') }
  }
  _cancel(record, reason) {
    if (this.records.get(record.id) !== record) return
    if (record.mode === 'renderer') { try { this.renderer.cancelTurn(record.turn, reason) } catch {} }
    if (record.mode === 'fallback') this.fallbackPlayer.clear(record.key)
    this._receipt('playback.cancelled', record, reason)
    this._retire(record)
  }
  _retire(record) {
    if (record.timer !== null) this.clearTimer(record.timer)
    record.outputEpoch += 1
    this._release(record)
    this.records.delete(record.id)
    this.retired.add(record.id)
    if (this.active === record) this.active = null
    this._pump()
  }
  _clear(id, reason) {
    if (id) {
      if (!this.retired.has(id) && this.retired.size >= this.maxTrackedResponses) { this.close('response_tracking_limit'); return }
      this.retired.add(id)
      const record = this.records.get(id)
      if (record) this._cancel(record, reason)
      return
    }
    // Temporarily inhibit pumping: clear-all must never start a queued turn.
    const closed = this.closed
    this.closed = true
    for (const known of this.known) this.retired.add(known)
    for (const record of [...this.records.values()]) this._cancel(record, reason)
    this.closed = closed
    this._status('idle', null, reason)
  }
}

function decodePcmBase64(base64, maxBytes) {
  if (typeof base64 !== 'string' || base64.length > Math.ceil(maxBytes / 3) * 4 + 4
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) throw new Error('Invalid PCM base64')
  const binary = atob(base64)
  if (binary.length % 2 || binary.length > maxBytes) throw new Error('Invalid PCM length')
  return Uint8Array.from(binary, character => character.charCodeAt(0))
}
