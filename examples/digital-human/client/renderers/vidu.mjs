import { createArtcPlayer } from './artc-player.mjs'

// Experimental native RTC output. Vidu has no documented per-response output
// boundary, so this adapter deliberately does NOT produce playback receipts.
// An epoch names a whole Vidu live/channel, not a model turn or playback claim.
export function createViduController({ player, sendRenderer, image = () => undefined,
  onError = () => {}, onStatus = () => {}, maxPendingBytes = 8 * 1024 * 1024 } = {}) {
  let closed = false, ready = false, opened = false, connected = false, failed = false
  let epoch = 0, generation = 0, current = null, turnId = '', hasInput = false, inputReady = false
  let pending = [], pendingBytes = 0, mediaPending = [], mediaBytes = 0
  const known = new Set(), retired = new Set(), inputEnded = new Set()
  const validId = id => typeof id === 'string' && id.length > 0 && id.length <= 256
  const notice = error => {
    if (closed || failed) return
    failed = true; pending = []; pendingBytes = 0; mediaPending = []; mediaBytes = 0
    void player.close()
    try { sendRenderer({ type: 'session.close' }) } catch { /* Transport may be gone. */ }
    onError(error instanceof Error ? error : new Error(error))
  }
  const write = event => {
    if (closed || failed) return
    if (!inputReady && ['turn.start', 'audio.append', 'audio.end'].includes(event.type)) {
      const size = JSON.stringify(event).length
      if (mediaBytes + size > maxPendingBytes) { notice('数字人等待入会的音频积压，请重新连接。'); return }
      mediaPending.push(event); mediaBytes += size
      return
    }
    if (!ready) {
      const size = JSON.stringify(event).length
      if (pendingBytes + size > maxPendingBytes) { notice('数字人输入积压，已停止输出，请重新连接。'); return }
      pending.push(event); pendingBytes += size
    } else {
      try {
        if (event.type === 'audio.append') player.expectMedia?.()
        if (sendRenderer(event) === false) notice('数字人连接不可用，请重新连接。')
      }
      catch { notice('数字人连接不可用，请重新连接。') }
    }
  }
  const open = () => {
    if (opened || failed || closed) return
    opened = true
    onStatus({ state: 'rendering', output: 'renderer' })
    write({ type: 'session.open', epoch, image: image() })
  }
  const cancel = (id, reason) => {
    if (id && !known.has(id)) { retired.add(id); return }
    for (const knownId of known) retired.add(knownId)
    known.clear(); inputEnded.clear(); current = null
    if (!hasInput) return // no submitted audio can survive in this channel
    // Stop locally before any network operation. The remote has no interrupt
    // ack/media fence; never unmute this channel again for a newer response.
    void player.disconnect()
    if (ready && opened) write({ type: 'session.cancel', epoch, reason })
    pending = []; pendingBytes = 0; mediaPending = []; mediaBytes = 0
    epoch += 1; opened = false; connected = false; hasInput = false; inputReady = false
    onStatus({ state: 'idle', output: 'renderer', reason })
    // A new live is allocated only if another valid audio response arrives.
  }
  return {
    handleGateway(event) {
      if (closed || failed || !event || typeof event !== 'object') return
      if (event.type === 'turn.started') turnId = event.turnId || ''
      else if (event.type === 'playback.clear') cancel(undefined, event.reason || 'gateway_clear')
      else if (event.type === 'voice.state' && event.state === 'listening'
        && (!event.turnId || event.turnId === turnId || event.origin !== 'model')) cancel(undefined, 'user_interruption')
      else if (event.type === 'response.interrupted' && validId(event.responseId)) cancel(event.responseId, 'user_interruption')
      else if (validId(event.responseId) && !retired.has(event.responseId)) {
        if (event.type === 'response.started') known.add(event.responseId)
        else if (event.type === 'audio.delta' && !inputEnded.has(event.responseId)) {
          if ((event.sampleRate !== undefined && event.sampleRate !== 24000)
            || typeof event.audio !== 'string' || !event.audio.length || event.audio.length > maxPendingBytes
            || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(event.audio)) {
            notice('无效的数字人音频输入。'); return
          }
          known.add(event.responseId)
          open()
          if (!current || current.responseId !== event.responseId) {
            current = { responseId: event.responseId, generation: ++generation, epoch }
            write({ type: 'turn.start', ...current })
          }
          hasInput = true
          write({ type: 'audio.append', ...current, sampleRate: 24000, audio: event.audio })
        } else if (event.type === 'audio.done' && current?.responseId === event.responseId) {
          write({ type: 'audio.end', ...current })
          inputEnded.add(current.responseId); current = null
          // Input completion is not RTC completion. Keep this live cancellable.
        }
      }
      if (retired.size + known.size > 4096) notice('数字人会话回复数达到上限，请重新连接。')
    },
    handleRenderer(raw) {
      if (closed || failed || typeof raw !== 'string') return
      let message
      try { message = JSON.parse(raw) } catch { notice('Invalid Vidu message'); return }
      if (message.type === 'session.ready' && !ready) {
        ready = true
        if (!opened && epoch === 0) open()
        const queued = pending; pending = []; pendingBytes = 0
        for (const event of queued) write(event)
      } else if (message.type === 'vidu.session' && message.epoch === epoch && opened && !connected) {
        connected = true
        const connectingEpoch = epoch
        if (player.connect(message.rtc, {
          onInputReady: () => {
            if (closed || failed || epoch !== connectingEpoch || inputReady) return
            inputReady = true
            const queued = mediaPending; mediaPending = []; mediaBytes = 0
            for (const event of queued) write(event)
          },
          onReady: () => {
            if (!closed && !failed && epoch === connectingEpoch) onStatus({ state: 'idle', output: 'renderer' })
          },
          onError: error => { if (epoch === connectingEpoch) notice(error) },
        }) === false) notice('数字人播放器未能建立新连接。')
      } else if (message.type === 'renderer.error' && (message.epoch === undefined || message.epoch === epoch)) {
        notice(message.message || 'Vidu unavailable')
      }
    },
    rendererDisconnected(reason) { notice(reason || '数字人连接已断开，请重新连接。') },
    close() {
      if (closed) return
      closed = true; pending = []; pendingBytes = 0; mediaPending = []; mediaBytes = 0
      void player.close() // synchronous local mute/detach, asynchronous RTC teardown
      try { sendRenderer({ type: 'session.close' }) } catch { /* Transport may be gone. */ }
    },
  }
}

export const viduAdapter = {
  playbackReceipts: false,
  maxBufferedBytes: 8 * 1024 * 1024,
  connectTimeoutMs: 65000,
  createPlayer: options => createArtcPlayer(options),
  createController: options => createViduController(options),
}
