// Example-local commercial adapter. Each turn owns a fresh RTC channel/live;
// no vendor secret or control URL is sent to the browser. The public component
// API has no response media-end marker: do not manufacture one here.
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
  if (!options.experimental) return { enabled: false, reason: 'Vidu playback completion is unverified; set VIDU_EXPERIMENTAL=1 only for manual preview.' }
  if (!/^vda_[^\s]+$/.test(options.apiKey || '') || !options.appId?.trim() || !options.appKey?.trim()) {
    return { enabled: false, reason: 'Configure VIDU_API_KEY, ARTC_APP_ID and ARTC_APP_KEY on the local server.' }
  }
  if (!['api.vidu.cn', 'api.vidu.com'].includes(options.host || 'api.vidu.cn')) return { enabled: false, reason: 'Invalid VIDU_HOST.' }
  return { enabled: true, playbackCompletion: false }
}

// Dependency injection is restricted to trusted server startup/tests.
export async function attachViduRenderer(socket, { providerOptions = {} } = {}) {
  const options = providerOptions
  const available = viduAvailability(options)
  const { request = fetch, Socket = WebSocket, retryMs = 2500, initTimeoutMs = 60000,
    liveTimeoutMs = 120000, now = Date.now } = options
  let current = null, closed = false, generation = -1, queuedBytes = 0
  let chain = Promise.resolve()
  const pending = new Set()
  const send = message => {
    if (closed || socket.readyState !== WebSocket.OPEN) return
    const data = JSON.stringify(message)
    if (socket.bufferedAmount + Buffer.byteLength(data) > 64 * 1024) { socket.close(1013, 'renderer backpressure'); return }
    socket.send(data)
  }
  const signal = (turn, type) => {
    if (turn.upstream?.readyState === WebSocket.OPEN) turn.upstream.send(JSON.stringify({
      type, live_id: turn.liveId, conn_id: turn.connId, seq_id: ++turn.sequence,
      payload: type === 1 ? { conn_init: { version: 1 } } : type === 5 ? { hangup: { hangup_reason: 'client_hangup' } } : {},
    }))
  }
  const dispose = turn => {
    if (!turn || turn.disposed) return
    turn.disposed = true
    clearTimeout(turn.expiry)
    clearTimeout(turn.retry)
    clearTimeout(turn.initTimer)
    turn.rejectReady?.(new Error('cancelled'))
    // Opening a WS and closing it also hangs up an allocated Vidu live. Let a
    // late HTTP result finish initialization/cleanup instead of losing its id.
    if (turn.upstream?.readyState === WebSocket.OPEN) {
      signal(turn, 7); signal(turn, 5); turn.upstream.close()
    }
  }
  const fail = (turn, code) => {
    if (closed || !turn || current !== turn) return
    send({ type: 'renderer.error', code, message: `Vidu preview stopped (${code})`, responseId: turn.responseId, generation: turn.generation })
    current = null
    dispose(turn)
  }
  const close = async () => {
    if (closed) return
    closed = true
    dispose(current)
    current = null
    await Promise.allSettled([...pending])
  }
  socket.once('close', () => { void close() })
  socket.once('error', () => { void close() })
  if (!available.enabled) {
    send({ type: 'renderer.error', code: 'vidu_not_enabled', message: available.reason })
    socket.close(1008, 'vidu not enabled')
    return close
  }
  async function initialize(turn) {
    const channel = randomUUID().replaceAll('-', '')
    const channelId = `vidu${channel}`, viewerId = `viewer${channel}`, avatarId = `avatar${channel}`
    const expiresAt = Math.floor(now() / 1000) + 7500
    const rtc = { token: createArtcToken({ appId: options.appId, appKey: options.appKey, channelId, userId: viewerId, expiresAt }),
      user_id: viewerId, avatar_user_id: avatarId, expires_at: expiresAt }
    const host = options.host || 'api.vidu.cn'
    const response = await request(`${options.httpOrigin || `https://${host}`}/live/s_avatar/component`, {
      method: 'POST', headers: { authorization: `Token ${options.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'vidu-s2', image_uri: turn.image,
        rtc_info: { provider: 'artc', app_id: options.appId, channel_id: channelId, user_id: avatarId,
          token: createArtcToken({ appId: options.appId, appKey: options.appKey, channelId, userId: avatarId, expiresAt }) } }),
      signal: AbortSignal.timeout(initTimeoutMs),
    })
    if (!response.ok) throw new Error('vidu_session_failed')
    const data = await response.json()
    if (typeof data.live?.id !== 'string' || typeof data.client_secret !== 'string') throw new Error('vidu_session_invalid')
    turn.liveId = data.live.id
    turn.connId = randomUUID()
    if (!closed && current === turn && !turn.disposed) {
      // Preview spending/resource cap, never a successful playback boundary.
      turn.expiry = setTimeout(() => fail(turn, 'session_expired'), liveTimeoutMs)
      turn.expiry.unref?.()
    }
    const url = new URL(`/live/v1/external-lives/${encodeURIComponent(turn.liveId)}/stream`, options.wsOrigin || `wss://${host}`)
    url.searchParams.set('conn_id', turn.connId)
    url.searchParams.set('client_secret', data.client_secret)
    // Even if cancelled during POST, connect solely to hang up the late live.
    const upstream = turn.upstream = new Socket(url, { handshakeTimeout: initTimeoutMs })
    upstream.on('error', () => fail(turn, 'control_connection_failed'))
    upstream.on('close', () => fail(turn, 'control_disconnected'))
    await new Promise((resolve, reject) => {
      turn.rejectReady = reject
      turn.initTimer = setTimeout(() => reject(new Error('vidu_init_timeout')), initTimeoutMs)
      const init = () => signal(turn, 1)
      upstream.once('open', () => {
        if (closed || turn.disposed || current !== turn) { signal(turn, 5); upstream.close(); reject(new Error('cancelled')); return }
        init()
      })
      upstream.on('message', (bytes, binary) => {
        if (binary || closed || current !== turn || turn.disposed) return
        let message
        try { message = JSON.parse(bytes) } catch { reject(new Error('invalid_control')); return }
        if (message.type === 6) { fail(turn, 'force_hangup'); reject(new Error('force_hangup')); return }
        if (message.type !== 2 || turn.ready) return
        const ack = message.payload?.conn_init_ack
        if (ack?.success) { turn.ready = true; clearTimeout(turn.initTimer); clearTimeout(turn.retry); resolve() }
        else if (ack?.error_code === 'NOT_READY') { clearTimeout(turn.retry); turn.retry = setTimeout(init, retryMs) }
        else reject(new Error('vidu_init_failed'))
      })
      upstream.once('close', () => reject(new Error('control_disconnected')))
      upstream.once('error', () => reject(new Error('control_connection_failed')))
    }).finally(() => { clearTimeout(turn.initTimer); clearTimeout(turn.retry); turn.rejectReady = null })
    if (closed || current !== turn || turn.disposed) return
    send({ type: 'vidu.session', responseId: turn.responseId, generation: turn.generation, rtc })
  }
  socket.on('message', (raw, binary) => {
    if (closed) return
    let message, turn
    try {
      if (binary || raw.length > 6 * 1024 * 1024) throw new Error('invalid_message')
      message = JSON.parse(raw)
      if (typeof message.responseId !== 'string' || !message.responseId || message.responseId.length > 256
        || !Number.isSafeInteger(message.generation) || message.generation < 0) throw new Error('invalid_turn')
      if (message.type === 'turn.cancel') {
        if (same(current, message)) { turn = current; current = null; dispose(turn) }
        return
      }
      if (message.type === 'turn.start') {
        if (message.generation <= generation) return
        const image = validateViduImage(message.image || DEFAULT_VIDU_IMAGE)
        dispose(current)
        generation = message.generation
        turn = current = { responseId: message.responseId, generation, image, sequence: 0, inputEnded: false, disposed: false, audioBytes: 0 }
      } else {
        if (!['audio.append', 'audio.end'].includes(message.type)) throw new Error('invalid_command')
        if (!same(current, message)) return
        turn = current
      }
      if (queuedBytes + raw.length > MAX_AUDIO * 2) throw new Error('input_backpressure')
      queuedBytes += raw.length
      const operation = chain.then(async () => {
        if (closed || current !== turn || turn.disposed) return
        if (message.type === 'turn.start') await initialize(turn)
        else if (message.type === 'audio.append') {
          if (turn.inputEnded || message.sampleRate !== 24000 || typeof message.audio !== 'string'
            || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(message.audio)) throw new Error('invalid_pcm')
          const pcm = Buffer.from(message.audio, 'base64')
          if (!pcm.length || pcm.length % 2 || turn.upstream.readyState !== WebSocket.OPEN
            || turn.upstream.bufferedAmount + pcm.length > MAX_AUDIO) throw new Error('invalid_pcm')
          turn.audioBytes += pcm.length
          if (turn.audioBytes > MAX_AUDIO) throw new Error('response_audio_limit')
          turn.upstream.send(pcm)
        } else if (message.type === 'audio.end') {
          turn.inputEnded = true
          // No public Vidu end-of-response signal. This is input-only metadata.
          send({ type: 'vidu.input_ended', responseId: turn.responseId, generation: turn.generation })
        }
      }).catch(() => fail(turn, 'vidu_request_failed')).finally(() => { queuedBytes -= raw.length; pending.delete(operation) })
      pending.add(operation)
      chain = operation
    } catch { fail(current, 'invalid_input'); socket.close(1008, 'invalid renderer input') }
  })
  send({ type: 'session.ready', playbackCompletion: false, experimental: true })
  return close
}
