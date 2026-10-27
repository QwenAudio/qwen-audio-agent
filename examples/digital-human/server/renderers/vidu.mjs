// Example-local session-scoped Vidu live and RTC credentials.
import { randomUUID } from 'node:crypto'
import { WebSocket } from 'ws'
import { createArtcToken } from './artc-token.mjs'

export const DEFAULT_VIDU_IMAGE = 'https://scene.vidu.zone/media-asset/083014-Qww8rvO5sOtAKZW8.png'
const MAX_AUDIO = 4_800_000
const MAX_IMAGE = 4 * 1024 * 1024
const MAX_PENDING_LIVES = 4
const same = (a, b) => a && b && a.responseId === b.responseId && a.generation === b.generation
export function validateViduImage(value) {
  if (typeof value !== 'string') throw new Error('invalid_image')
  if (/^https:\/\/\S+$/i.test(value) && value.length <= 4096) return value
  if (/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(value)
    && Buffer.from(value.split(',')[1], 'base64').length <= MAX_IMAGE) return value
  throw new Error('invalid_image')
}
export function readViduOptions(env = process.env) {
  return { apiKey: env.VIDU_API_KEY || '', appId: env.ARTC_APP_ID || '', appKey: env.ARTC_APP_KEY || '',
    host: env.VIDU_HOST || 'api.vidu.cn', experimental: env.VIDU_EXPERIMENTAL === '1' }
}
export function viduAvailability(options = {}) {
  if (!options.experimental) return { enabled: false, reason: 'Vidu native RTC is experimental and has no playback receipts; set VIDU_EXPERIMENTAL=1 for testing.' }
  if (!/^vda_[^\s]+$/.test(options.apiKey || '') || !options.appId?.trim() || !options.appKey?.trim()) {
    return { enabled: false, reason: 'Configure VIDU_API_KEY, ARTC_APP_ID and ARTC_APP_KEY on the local server.' }
  }
  if (!['api.vidu.cn', 'api.vidu.com'].includes(options.host || 'api.vidu.cn')) return { enabled: false, reason: 'Invalid VIDU_HOST.' }
  return { enabled: true, playbackCompletion: false, completionMode: 'unavailable' }
}

// Dependency injection is restricted to trusted startup/tests.
export async function attachViduRenderer(socket, { providerOptions: options = {} } = {}) {
  const available = viduAvailability(options)
  const { request = fetch, Socket = WebSocket, retryMs = 2500, initTimeoutMs = 60000,
    liveTimeoutMs = 30 * 60 * 1000, now = Date.now } = options
  let session = null, closed = false, epoch = -1, queuedBytes = 0, openingCount = 0
  const pending = new Set()
  const active = live => !closed && session === live && !live.disposed
  const send = message => {
    if (closed || socket.readyState !== WebSocket.OPEN) return
    const data = JSON.stringify(message)
    if (socket.bufferedAmount + Buffer.byteLength(data) > 64 * 1024) { socket.close(1013, 'renderer backpressure'); return }
    socket.send(data)
  }
  const signal = (live, type) => {
    if (live?.upstream?.readyState === WebSocket.OPEN) live.upstream.send(JSON.stringify({
      type, live_id: live.liveId, conn_id: live.connId, seq_id: ++live.sequence,
      payload: type === 1 ? { conn_init: { version: 1 } } : type === 5 ? { hangup: { hangup_reason: 'client_hangup' } } : {},
    }))
  }
  const hangup = live => {
    if (live.upstream?.readyState !== WebSocket.OPEN) return
    if (live.interrupted) signal(live, 7)
    signal(live, 5)
    live.upstream.close()
  }
  const dispose = (live, interrupted = false) => {
    if (!live || live.disposed) return
    live.disposed = true; live.interrupted = interrupted; live.current = null
    for (const timer of ['expiry', 'retry', 'initTimer']) clearTimeout(live[timer])
    live.rejectReady?.(new Error('cancelled'))
    live.rejectInit?.(new Error('cancelled'))
    hangup(live)
  }
  const fail = (code, live = session) => {
    if (closed || (live && !active(live))) return
    send({ type: 'renderer.error', code, message: `Vidu session stopped (${code})`,
      ...(live ? { epoch: live.epoch } : {}),
      ...(live?.current ? { responseId: live.current.responseId, generation: live.current.generation } : {}) })
    session = null
    dispose(live)
    socket.close(1011, 'vidu session stopped')
  }
  const close = async () => {
    if (closed) return
    closed = true; dispose(session); session = null
    await Promise.allSettled([...pending])
  }
  socket.once('close', () => { void close() })
  socket.once('error', () => { void close() })
  if (!available.enabled) {
    send({ type: 'renderer.error', code: 'vidu_not_enabled', message: available.reason })
    socket.close(1008, 'vidu not enabled'); return close
  }
  async function initialize(live) {
    const channel = randomUUID().replaceAll('-', '')
    const channelId = `vidu${channel}`, viewerId = `viewer${channel}`, avatarId = `avatar${channel}`
    const expiresAt = Math.floor(now() / 1000) + 7500
    const rtc = { token: createArtcToken({ appId: options.appId, appKey: options.appKey, channelId, userId: viewerId, expiresAt }),
      user_id: viewerId, avatar_user_id: avatarId, expires_at: expiresAt }
    const host = options.host || 'api.vidu.cn'
    const response = await request(`${options.httpOrigin || `https://${host}`}/live/s_avatar/component`, {
      method: 'POST', headers: { authorization: `Token ${options.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'vidu-s2', image_uri: live.image,
        rtc_info: { provider: 'artc', app_id: options.appId, channel_id: channelId, user_id: avatarId,
          token: createArtcToken({ appId: options.appId, appKey: options.appKey, channelId, userId: avatarId, expiresAt }) } }),
      signal: AbortSignal.timeout(initTimeoutMs),
    })
    if (!response.ok) throw new Error('vidu_session_failed')
    const data = await response.json()
    if (typeof data.live?.id !== 'string' || typeof data.client_secret !== 'string') throw new Error('vidu_session_invalid')
    live.liveId = data.live.id; live.connId = randomUUID()
    if (active(live)) {
      live.expiry = setTimeout(() => fail('session_expired', live), liveTimeoutMs); live.expiry.unref?.()
    }
    const url = new URL(`/live/v1/external-lives/${encodeURIComponent(live.liveId)}/stream`, options.wsOrigin || `wss://${host}`)
    url.searchParams.set('conn_id', live.connId); url.searchParams.set('client_secret', data.client_secret)
    // A late HTTP allocation is still connected solely to hang it up.
    const upstream = live.upstream = new Socket(url, { handshakeTimeout: initTimeoutMs })
    upstream.on('error', () => fail('control_connection_failed', live))
    upstream.on('close', () => fail('control_disconnected', live))
    await new Promise((resolve, reject) => {
      live.rejectInit = reject
      live.initTimer = setTimeout(() => reject(new Error('vidu_init_timeout')), initTimeoutMs)
      const init = () => { if (active(live)) signal(live, 1) }
      upstream.once('open', () => {
        if (!active(live)) { hangup(live); reject(new Error('cancelled')); return }
        init()
      })
      upstream.on('message', (bytes, binary) => {
        if (binary || !active(live)) return
        let message
        try { message = JSON.parse(bytes) } catch { reject(new Error('invalid_control')); return }
        if (message.type === 6) { fail('force_hangup', live); reject(new Error('force_hangup')); return }
        if (message.type !== 2 || live.ready) return
        const ack = message.payload?.conn_init_ack
        if (ack?.success) { live.ready = true; clearTimeout(live.initTimer); clearTimeout(live.retry); resolve() }
        else if (ack?.error_code === 'NOT_READY') { clearTimeout(live.retry); live.retry = setTimeout(init, retryMs) }
        else reject(new Error('vidu_init_failed'))
      })
      upstream.once('close', () => reject(new Error('control_disconnected')))
      upstream.once('error', () => reject(new Error('control_connection_failed')))
    }).finally(() => { clearTimeout(live.initTimer); clearTimeout(live.retry); live.rejectInit = null })
    if (active(live)) send({ type: 'vidu.session', epoch: live.epoch, rtc })
  }
  const writePcm = (live, turn, pcm) => {
    if (live.upstream?.readyState !== WebSocket.OPEN || live.upstream.bufferedAmount + pcm.length > MAX_AUDIO) throw new Error('audio_backpressure')
    if (!turn.cancelled) live.upstream.send(pcm)
  }
  socket.on('message', (raw, binary) => {
    if (closed) return
    try {
      if (binary || raw.length > 6 * 1024 * 1024) throw new Error('invalid_message')
      const message = JSON.parse(raw)
      if (message.type === 'session.close') { void close(); socket.close(1000, 'session ended'); return }
      if (!Number.isSafeInteger(message.epoch) || message.epoch < 0) throw new Error('invalid_epoch')
      if (message.type === 'session.open') {
        if (message.epoch <= epoch) return
        if (session) throw new Error('session_already_open')
        if (openingCount >= MAX_PENDING_LIVES) throw new Error('session_backpressure')
        const live = session = { image: validateViduImage(message.image || DEFAULT_VIDU_IMAGE),
          epoch: message.epoch, sequence: 0, generation: -1, current: null }
        epoch = live.epoch
        // Queued writes wait on this live only. Cancelling releases them even if
        // its HTTP allocation is still pending; the next epoch can start now.
        live.chain = new Promise((resolve, reject) => { live.resolveReady = resolve; live.rejectReady = reject })
        live.chain.catch(() => {})
        openingCount++
        const opening = initialize(live).then(() => live.resolveReady()).catch(() => fail('vidu_request_failed', live))
          .finally(() => { openingCount--; pending.delete(opening) })
        pending.add(opening); return
      }
      const live = session
      if (!live || message.epoch !== live.epoch) return // a retired live cannot affect its replacement
      if (message.type === 'session.cancel') {
        session = null
        dispose(live, true)
        return
      }
      if (typeof message.responseId !== 'string' || !message.responseId || message.responseId.length > 256
        || !Number.isSafeInteger(message.generation) || message.generation < 0) throw new Error('invalid_turn')
      if (['turn.cancel', 'turn.finish'].includes(message.type)) {
        if (same(live.current, message)) {
          if (message.type === 'turn.cancel') { session = null; dispose(live, true) }
          else live.current = null
        }
        return
      }
      let turn
      if (message.type === 'turn.start') {
        if (message.generation <= live.generation) return
        live.generation = message.generation
        turn = live.current = { responseId: message.responseId, generation: message.generation, inputEnded: false, audioBytes: 0 }
      } else {
        if (!['audio.append', 'audio.end'].includes(message.type)) throw new Error('invalid_command')
        if (!same(live.current, message)) return
        turn = live.current
      }
      if (queuedBytes + raw.length > MAX_AUDIO * 2) throw new Error('input_backpressure')
      queuedBytes += raw.length
      const operation = live.chain.then(() => {
        if (!active(live) || turn.cancelled) return
        if (message.type === 'turn.start') send({ type: 'vidu.turn', epoch: live.epoch, responseId: turn.responseId, generation: turn.generation })
        else if (message.type === 'audio.append') {
          if (turn.inputEnded || message.sampleRate !== 24000 || typeof message.audio !== 'string'
            || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(message.audio)) throw new Error('invalid_pcm')
          const pcm = Buffer.from(message.audio, 'base64')
          if (!pcm.length || pcm.length % 2) throw new Error('invalid_pcm')
          turn.audioBytes += pcm.length
          if (turn.audioBytes > MAX_AUDIO) throw new Error('response_audio_limit')
          writePcm(live, turn, pcm)
        } else {
          turn.inputEnded = true
          send({ type: 'vidu.input_ended', epoch: live.epoch, responseId: turn.responseId, generation: turn.generation })
        }
      }).catch(() => fail('vidu_request_failed', live)).finally(() => { queuedBytes -= raw.length; pending.delete(operation) })
      pending.add(operation); live.chain = operation
    } catch { fail('invalid_input'); socket.close(1008, 'invalid renderer input') }
  })
  send({ type: 'session.ready', playbackCompletion: false, completionMode: 'unavailable', experimental: true })
  return close
}
