// Example-local session-scoped Vidu live and RTC credentials.
import { randomUUID } from 'node:crypto'
import { WebSocket } from 'ws'
import { createArtcToken } from './artc-token.mjs'

export const DEFAULT_VIDU_IMAGE = 'https://scene.vidu.zone/media-asset/083014-Qww8rvO5sOtAKZW8.png'
const MAX_AUDIO = 4_800_000
const MAX_IMAGE = 4 * 1024 * 1024
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
  if (!options.experimental) return { enabled: false, reason: 'Vidu delayed presentation is experimental; set VIDU_EXPERIMENTAL=1 for testing.' }
  if (!/^vda_[^\s]+$/.test(options.apiKey || '') || !options.appId?.trim() || !options.appKey?.trim()) {
    return { enabled: false, reason: 'Configure VIDU_API_KEY, ARTC_APP_ID and ARTC_APP_KEY on the local server.' }
  }
  if (!['api.vidu.cn', 'api.vidu.com'].includes(options.host || 'api.vidu.cn')) return { enabled: false, reason: 'Invalid VIDU_HOST.' }
  return { enabled: true, playbackCompletion: false, completionMode: 'source-pcm-timeline' }
}

// Dependency injection is restricted to trusted startup/tests.
export async function attachViduRenderer(socket, { providerOptions: options = {} } = {}) {
  const available = viduAvailability(options)
  const { request = fetch, Socket = WebSocket, retryMs = 2500, initTimeoutMs = 60000,
    liveTimeoutMs = 30 * 60 * 1000, now = Date.now } = options
  let session = null, current = null, closed = false, generation = -1, queuedBytes = 0
  let chain = Promise.resolve()
  const pending = new Set()
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
  const dispose = live => {
    if (!live || live.disposed) return
    live.disposed = true
    for (const timer of ['expiry', 'retry', 'initTimer']) clearTimeout(live[timer])
    live.rejectReady?.(new Error('cancelled'))
    if (live.upstream?.readyState === WebSocket.OPEN) { signal(live, 5); live.upstream.close() }
  }
  const fail = code => {
    if (closed) return
    send({ type: 'renderer.error', code, message: `Vidu session stopped (${code})`,
      ...(current ? { responseId: current.responseId, generation: current.generation } : {}) })
    current = null
    dispose(session)
    socket.close(1011, 'vidu session stopped')
  }
  const close = async () => {
    if (closed) return
    closed = true; current = null; dispose(session)
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
    if (!closed && !live.disposed) {
      live.expiry = setTimeout(() => fail('session_expired'), liveTimeoutMs); live.expiry.unref?.()
    }
    const url = new URL(`/live/v1/external-lives/${encodeURIComponent(live.liveId)}/stream`, options.wsOrigin || `wss://${host}`)
    url.searchParams.set('conn_id', live.connId); url.searchParams.set('client_secret', data.client_secret)
    // A late HTTP allocation is still connected solely to hang it up.
    const upstream = live.upstream = new Socket(url, { handshakeTimeout: initTimeoutMs })
    upstream.on('error', () => { if (!live.disposed) fail('control_connection_failed') })
    upstream.on('close', () => { if (!live.disposed) fail('control_disconnected') })
    await new Promise((resolve, reject) => {
      live.rejectReady = reject
      live.initTimer = setTimeout(() => reject(new Error('vidu_init_timeout')), initTimeoutMs)
      const init = () => signal(live, 1)
      upstream.once('open', () => {
        if (closed || live.disposed) { signal(live, 5); upstream.close(); reject(new Error('cancelled')); return }
        init()
      })
      upstream.on('message', (bytes, binary) => {
        if (binary || closed || live.disposed) return
        let message
        try { message = JSON.parse(bytes) } catch { reject(new Error('invalid_control')); return }
        if (message.type === 6) { fail('force_hangup'); reject(new Error('force_hangup')); return }
        if (message.type !== 2 || live.ready) return
        const ack = message.payload?.conn_init_ack
        if (ack?.success) { live.ready = true; clearTimeout(live.initTimer); clearTimeout(live.retry); resolve() }
        else if (ack?.error_code === 'NOT_READY') { clearTimeout(live.retry); live.retry = setTimeout(init, retryMs) }
        else reject(new Error('vidu_init_failed'))
      })
      upstream.once('close', () => reject(new Error('control_disconnected')))
      upstream.once('error', () => reject(new Error('control_connection_failed')))
    }).finally(() => { clearTimeout(live.initTimer); clearTimeout(live.retry); live.rejectReady = null })
    if (!closed && !live.disposed) send({ type: 'vidu.session', rtc })
  }
  const writePcm = (turn, pcm) => {
    if (session?.upstream?.readyState !== WebSocket.OPEN || session.upstream.bufferedAmount + pcm.length > MAX_AUDIO) throw new Error('audio_backpressure')
    if (!turn.cancelled) session.upstream.send(pcm)
  }
  socket.on('message', (raw, binary) => {
    if (closed) return
    try {
      if (binary || raw.length > 6 * 1024 * 1024) throw new Error('invalid_message')
      const message = JSON.parse(raw)
      if (message.type === 'session.close') { void close(); socket.close(1000, 'session ended'); return }
      if (message.type === 'session.open') {
        if (session) throw new Error('session_already_open')
        session = { image: validateViduImage(message.image || DEFAULT_VIDU_IMAGE), sequence: 0 }
        const opening = chain.then(() => initialize(session)).catch(() => fail('vidu_request_failed')).finally(() => pending.delete(opening))
        pending.add(opening); chain = opening; return
      }
      if (!session || typeof message.responseId !== 'string' || !message.responseId || message.responseId.length > 256
        || !Number.isSafeInteger(message.generation) || message.generation < 0) throw new Error('invalid_turn')
      if (['turn.cancel', 'turn.finish'].includes(message.type)) {
        if (same(current, message)) { current.cancelled = message.type === 'turn.cancel'; current = null }
        return
      }
      let turn
      if (message.type === 'turn.start') {
        if (message.generation <= generation) return
        generation = message.generation
        turn = current = { responseId: message.responseId, generation, inputEnded: false, audioBytes: 0 }
      } else {
        if (!['audio.append', 'audio.end'].includes(message.type)) throw new Error('invalid_command')
        if (!same(current, message)) return
        turn = current
      }
      if (queuedBytes + raw.length > MAX_AUDIO * 2) throw new Error('input_backpressure')
      queuedBytes += raw.length
      const operation = chain.then(() => {
        if (closed || turn.cancelled || session.disposed) return
        if (message.type === 'turn.start') send({ type: 'vidu.turn', responseId: turn.responseId, generation: turn.generation })
        else if (message.type === 'audio.append') {
          if (turn.inputEnded || message.sampleRate !== 24000 || typeof message.audio !== 'string'
            || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(message.audio)) throw new Error('invalid_pcm')
          const pcm = Buffer.from(message.audio, 'base64')
          if (!pcm.length || pcm.length % 2) throw new Error('invalid_pcm')
          turn.audioBytes += pcm.length
          if (turn.audioBytes > MAX_AUDIO) throw new Error('response_audio_limit')
          writePcm(turn, pcm)
        } else {
          turn.inputEnded = true
          send({ type: 'vidu.input_ended', responseId: turn.responseId, generation: turn.generation })
        }
      }).catch(() => fail('vidu_request_failed')).finally(() => { queuedBytes -= raw.length; pending.delete(operation) })
      pending.add(operation); chain = operation
    } catch { fail('invalid_input'); socket.close(1008, 'invalid renderer input') }
  })
  send({ type: 'session.ready', playbackCompletion: false, completionMode: 'source-pcm-timeline', experimental: true })
  return close
}
