import { createSourcePlayback } from '../source-playback.mjs'
import { createArtcPlayer } from './artc-player.mjs'

// A best-effort display mirror. Only sourcePlayback can send Gateway receipts.
export function createViduController({ player, sourcePlayback, sendRenderer, image = () => undefined,
  onError = () => {}, maxPendingBytes = 8 * 1024 * 1024 } = {}) {
  let closed = false, opened = false, connected = false, failed = false, generation = 0, current = null, turnId = ''
  let pending = [], pendingBytes = 0
  const retired = new Set()
  const notice = error => {
    if (closed || failed) return
    failed = true; pending = []; pendingBytes = 0
    void player.close()
    onError(error instanceof Error ? error : new Error(error))
  }
  const write = event => {
    if (closed || failed) return
    if (!opened) {
      const size = JSON.stringify(event).length
      if (pendingBytes + size > maxPendingBytes) { notice('数字人输入积压，展示已停止；原始对话继续。'); return }
      pending.push(event); pendingBytes += size
    } else {
      try { if (sendRenderer(event) === false) notice('数字人连接不可用；原始对话继续。') }
      catch { notice('数字人连接不可用；原始对话继续。') }
    }
  }
  const retire = id => {
    if (id) retired.add(id)
    // Fencing future uploads is not a request to stop already uploaded media.
    if (current && (!id || current.responseId === id)) {
      write({ type: 'turn.cancel', ...current })
      retired.add(current.responseId); current = null
    }
  }
  return {
    handleGateway(event) {
      if (closed) return
      sourcePlayback.handleGateway(event) // always independent of renderer readiness
      if (event.type === 'turn.started') turnId = event.turnId || ''
      else if (event.type === 'playback.clear') retire()
      else if (event.type === 'voice.state' && event.state === 'listening'
        && (!event.turnId || event.turnId === turnId || event.origin !== 'model')) retire()
      else if (event.type === 'response.interrupted') retire(event.responseId)
      else if (event.type === 'audio.delta' && !retired.has(event.responseId)) {
        if (!current || current.responseId !== event.responseId) {
          if (current) retired.add(current.responseId)
          current = { responseId: event.responseId, generation: ++generation }
          write({ type: 'turn.start', ...current })
        }
        write({ type: 'audio.append', ...current, sampleRate: event.sampleRate ?? 24000, audio: event.audio })
      } else if (event.type === 'audio.done' && current?.responseId === event.responseId) {
        write({ type: 'audio.end', ...current })
        retired.add(current.responseId); current = null
      }
      if (retired.size > 4096) notice('数字人会话回复数达到上限，请重新连接展示。')
    },
    handleRenderer(raw) {
      if (closed || failed || typeof raw !== 'string') return
      let message
      try { message = JSON.parse(raw) } catch { notice('Invalid Vidu message'); return }
      if (message.type === 'session.ready' && !opened) {
        opened = true
        if (sendRenderer({ type: 'session.open', image: image() }) === false) { notice('Vidu connection unavailable'); return }
        const queued = pending; pending = []; pendingBytes = 0
        for (const event of queued) write(event)
      } else if (message.type === 'vidu.session' && !connected) {
        connected = true
        player.connect(message.rtc, { onError: error => {
          notice(error)
          sendRenderer({ type: 'session.close' })
        } })
      } else if (message.type === 'renderer.error') notice(message.message || 'Vidu unavailable')
    },
    setSourceAudible(value) {
      // Swap only the output paths. Source scheduling and receipts are identical.
      if (value) { player.setAudible(false); sourcePlayback.setAudible(true) }
      else { sourcePlayback.setAudible(false); player.setAudible(true) }
    },
    rendererDisconnected(reason) { notice(reason || '数字人连接已断开；原始对话继续。') },
    close(reason = 'closed') {
      if (closed) return
      sourcePlayback.close(reason)
      closed = true; pending = []; pendingBytes = 0
      try { sendRenderer({ type: 'session.close' }) } catch {}
      void player.close()
    },
  }
}

export const viduAdapter = {
  presentationOnly: true,
  maxBufferedBytes: 8 * 1024 * 1024,
  connectTimeoutMs: 65000,
  createPlayer: options => createArtcPlayer(options),
  createController: ({ player, audioContext, sendGateway, onStatus, ...options }) => createViduController({
    ...options, player,
    sourcePlayback: createSourcePlayback({ audioContext, sendGateway, onStatus }),
  }),
}
