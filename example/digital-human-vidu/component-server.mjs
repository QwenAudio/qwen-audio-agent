import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { WebSocket, WebSocketServer } from 'ws'
import { createArtcToken } from './artc-token.mjs'

function parse(text) { try { return JSON.parse(text) } catch { return null } }
function reply(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  response.end(JSON.stringify(value))
}
async function requestBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > 6 * 1024 * 1024) throw Object.assign(new Error('图片过大'), { status: 413 })
    chunks.push(chunk)
  }
  return parse(Buffer.concat(chunks).toString())
}

export function createComponentServer({
  viduKey = '', appId = '', appKey = '', host = 'api.vidu.cn',
  httpOrigin = `https://${host}`, wsOrigin = `wss://${host}`,
  retryMs = 2500, initTimeoutMs = 60000, pendingTimeoutMs = 60000,
  allowedOrigin = 'http://127.0.0.1:5181',
} = {}) {
  if (!['api.vidu.cn', 'api.vidu.com'].includes(host)) throw new Error('VIDU_HOST 只支持 api.vidu.cn 或 api.vidu.com')
  let closing = false
  const allowedRequest = request => !request.headers.origin || request.headers.origin === allowedOrigin
  const token = viduKey.trim().replace(/^Token\s+/i, '')
  const sessions = new Map()
  const websocketServer = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 })
  const configured = /^vda_[^\s]+$/.test(token) && Boolean(appId.trim() && appKey.trim())
  const authorization = `Token ${token}`

  function closeSession(session) {
    clearTimeout(session.expiry)
    sessions.delete(session.controlId)
  }

  async function createSession(request, response) {
    if (!configured) return reply(response, 503, { error: '请配置 VIDU_API_KEY、ARTC_APP_ID 和 ARTC_APP_KEY' })
    const input = await requestBody(request)
    const imageUri = input?.image_uri
    if (typeof imageUri !== 'string' || !(/^https?:\/\/\S+$/i.test(imageUri) || /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/i.test(imageUri))) {
      return reply(response, 400, { error: '请提供角色图片 URL 或 PNG/JPEG/WEBP 图片' })
    }
    if (imageUri.startsWith('data:') && Buffer.from(imageUri.split(',')[1], 'base64').length > 4 * 1024 * 1024) {
      return reply(response, 413, { error: '图片超过 4 MB' })
    }
    const suffix = randomUUID().replaceAll('-', '')
    const channelId = `vidu${suffix}`
    const viewerId = `viewer${suffix}`
    const avatarId = `avatar${suffix}`
    const expiresAt = Math.floor(Date.now() / 1000) + 7500
    const viewerToken = createArtcToken({ appId, appKey, channelId, userId: viewerId, expiresAt })
    const avatarToken = createArtcToken({ appId, appKey, channelId, userId: avatarId, expiresAt })
    const upstream = await fetch(`${httpOrigin}/live/s_avatar/component`, {
      method: 'POST',
      headers: { Authorization: authorization, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        model: 'vidu-s2', image_uri: imageUri,
        rtc_info: { provider: 'artc', app_id: appId, channel_id: channelId, user_id: avatarId, token: avatarToken },
      }),
      signal: AbortSignal.timeout(60000),
    })
    const result = parse(await upstream.text())
    if (!upstream.ok) return reply(response, upstream.status, { error: result?.error?.message || result?.message || result?.reason || `Vidu HTTP ${upstream.status}` })
    if (typeof result?.live?.id !== 'string' || !result.client_secret) return reply(response, 502, { error: 'Vidu 返回的数据缺少 live.id 或 client_secret' })
    if (closing) return reply(response, 503, { error: '服务正在关闭' })
    const session = { id: result.live.id, controlId: randomUUID(), clientSecret: result.client_secret, proxy: null }
    session.expiry = setTimeout(() => { session.proxy?.close(); closeSession(session) }, pendingTimeoutMs)
    session.expiry.unref?.()
    sessions.set(session.controlId, session)
    reply(response, 200, {
      session_id: session.controlId,
      live: { id: session.id, status: result.live.status, trace_id: result.live.trace_id },
      rtc: { token: viewerToken, user_id: viewerId, avatar_user_id: avatarId, channel_id: channelId, expires_at: expiresAt },
    })
  }

  const server = createServer(async (request, response) => {
    try {
      if (closing || !allowedRequest(request)) return reply(response, 403, { error: '请求来源不被允许' })
      const url = new URL(request.url, 'http://localhost')
      if (request.method === 'GET' && url.pathname === '/api/config') return reply(response, 200, { example: 'digital-human-vidu', configured, host })
      if (request.method === 'POST' && url.pathname === '/api/session') return await createSession(request, response)
      if (request.method === 'DELETE' && url.pathname.startsWith('/api/session/')) {
        const session = sessions.get(url.pathname.slice('/api/session/'.length))
        if (session) { session.proxy?.close(); closeSession(session) }
        return reply(response, 200, { closed: true })
      }
      reply(response, 404, { error: '未找到接口' })
    } catch (error) { reply(response, error.status || 500, { error: error.message }) }
  })

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url, 'http://localhost')
    const session = sessions.get(url.searchParams.get('session_id'))
    if (closing || !allowedRequest(request) || url.pathname !== '/ws/session' || !session || session.proxy) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
      return
    }
    websocketServer.handleUpgrade(request, socket, head, client => {
      const proxy = new ComponentProxy({ client, session, authorization, wsOrigin, retryMs, initTimeoutMs, onClose: () => closeSession(session) })
      session.proxy = proxy
      clearTimeout(session.expiry)
      session.expiry = setTimeout(() => proxy.close(), 2 * 3600 * 1000)
      session.expiry.unref?.()
      proxy.start()
    })
  })
  const dispose = () => {
    closing = true
    for (const session of sessions.values()) session.proxy?.close()
    for (const session of sessions.values()) closeSession(session)
    websocketServer.close()
  }
  server.on('close', dispose)
  server.shutdown = async () => {
    dispose()
    server.closeAllConnections()
    if (server.listening) await new Promise(resolve => server.close(resolve))
  }
  return server
}

class ComponentProxy {
  constructor(options) {
    Object.assign(this, options)
    this.connId = randomUUID()
    this.seq = 0
    this.closed = false
    this.ready = false
  }

  start() {
    const params = new URLSearchParams({ conn_id: this.connId, client_secret: this.session.clientSecret })
    this.remote = new WebSocket(`${this.wsOrigin}/live/v1/external-lives/${encodeURIComponent(this.session.id)}/stream?${params}`, {
      headers: { Authorization: this.authorization }, handshakeTimeout: 15000, maxPayload: 256 * 1024,
    })
    this.client.on('message', (bytes, binary) => this.command(bytes, binary))
    this.client.on('close', () => this.close())
    this.client.on('error', () => this.close())
    this.deadline = setTimeout(() => this.fail('Vidu 组件初始化超时'), this.initTimeoutMs)
    this.remote.on('open', () => this.signal(1, { conn_init: { version: 1 } }))
    this.remote.on('message', bytes => {
      if (this.closed) return
      const message = parse(bytes.toString())
      if (!message) return
      const ack = message.payload?.conn_init_ack
      if (message.type === 2 && ack) {
        if (ack.success === true) {
          clearTimeout(this.deadline)
          clearTimeout(this.retry)
          this.ready = true
          this.send({ event: 'ready' })
        } else if (ack.error_code === 'NOT_READY') {
          this.send({ event: 'warming' })
          clearTimeout(this.retry)
          this.retry = setTimeout(() => this.signal(1, { conn_init: { version: 1 } }), this.retryMs)
        } else this.fail(ack.error_msg || ack.error_code || 'Vidu 组件初始化失败')
      }
      if (message.type === 6) {
        this.send({ event: 'ended', reason: message.payload?.hangup?.hangup_reason || '服务端结束会话' })
        this.close(false)
      }
    })
    this.remote.on('error', () => this.fail('Vidu 组件连接失败'))
    this.remote.on('close', () => { if (!this.closed) { this.send({ event: 'ended', reason: 'Vidu 连接关闭' }); this.close(false) } })
  }

  command(bytes, binary) {
    if (this.closed) return
    if (binary) {
      if (!this.ready || this.remote?.readyState !== WebSocket.OPEN) return
      if (bytes.length % 2 !== 0) return this.fail('无效的 PCM 音频')
      if (this.remote.bufferedAmount > 2 * 1024 * 1024) return this.fail('数字人音频链路拥塞')
      this.remote.send(bytes, { binary: true })
      return
    }
    const message = parse(bytes.toString())
    if (message?.action === 'hangup') return this.close()
    if (!this.ready) return this.send({ event: 'error', message: '数字人尚未就绪' })
    if (message?.action === 'interrupt') return this.signal(7, {})
    if (message?.action === 'transcript' && message.role === 'output' && typeof message.content === 'string' && message.content.trim()) {
      return this.signal(10, { text_msg: { msg_id: randomUUID(), content: message.content.trim(), timestamp: Date.now() } })
    }
    this.send({ event: 'error', message: '不支持的操作' })
  }

  signal(type, payload) {
    if (this.remote?.readyState === WebSocket.OPEN) {
      this.remote.send(JSON.stringify({ type, live_id: this.session.id, conn_id: this.connId, seq_id: ++this.seq, payload }))
    }
  }
  send(message) { if (this.client.readyState === WebSocket.OPEN) this.client.send(JSON.stringify(message)) }
  fail(message) { if (!this.closed) { this.send({ event: 'error', message }); this.close() } }
  close(hangup = true) {
    if (this.closed) return
    if (hangup) this.signal(5, { hangup: { hangup_reason: 'client_hangup' } })
    this.closed = true
    clearTimeout(this.deadline)
    clearTimeout(this.retry)
    if (this.remote?.readyState < WebSocket.CLOSING) this.remote.close()
    if (this.client.readyState < WebSocket.CLOSING) this.client.close()
    this.onClose()
  }
}
