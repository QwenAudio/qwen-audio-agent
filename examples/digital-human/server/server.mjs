import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { extname, resolve, sep } from 'node:path'
import { WebSocket, WebSocketServer } from 'ws'
import { rendererAdapters } from './renderers/index.mjs'

const DEFAULT_CLIENT = fileURLToPath(new URL('../dist/', import.meta.url))
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' }
const LIMIT = 1024 * 1024

// This is an example client host, NOT a custom Gateway. Gateway packets are
// proxied unchanged. Renderer credentials and vendor APIs live only here.
export async function startExampleServer({
  host = '127.0.0.1', port = 5273, clientDir = DEFAULT_CLIENT,
  gatewayUrl = 'ws://127.0.0.1:18888/api/realtime', gatewayToken,
  rendererId = 'dhav', rendererUrl, rendererToken, persona = 'mock-default',
  adapters = rendererAdapters, providerOptions,
} = {}) {
  if (!['127.0.0.1', '::1'].includes(host)) throw new Error('Example host must be a loopback address; use an authenticated HTTPS reverse proxy for remote access')
  const adapter = adapters[rendererId]
  if (!adapter?.attach) throw new Error(`Unknown example renderer adapter: ${rendererId}`)
  const upstreamUrl = new URL(gatewayUrl)
  if (!['ws:', 'wss:'].includes(upstreamUrl.protocol) || upstreamUrl.username || upstreamUrl.password) throw new Error('Gateway URL must be ws(s), without embedded credentials')
  const root = resolve(clientDir)
  const cleanups = new Set()
  const proxies = new Set()
  let origin, authority, rendererClient = null
  const trustedHost = request => request.headers.host === authority
  const server = createServer(async (request, response) => {
    if (!trustedHost(request)) { response.writeHead(403).end(); return }
    if (request.method !== 'GET') { response.writeHead(405).end(); return }
    const url = new URL(request.url, origin)
    if (url.pathname === '/api/config') {
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      response.end(JSON.stringify({ persona, renderer: { id: rendererId, ...adapter.config?.({ providerOptions }) }, gatewayPath: '/gateway', rendererPath: '/avatar' }))
      return
    }
    try {
      const path = resolve(root, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname))
      if (!path.startsWith(root + sep)) { response.writeHead(403).end(); return }
      const body = await readFile(path)
      response.writeHead(200, { 'content-type': MIME[extname(path)] || 'application/octet-stream', 'x-content-type-options': 'nosniff', 'cache-control': 'no-cache' })
      response.end(body)
    } catch { response.writeHead(404).end('Not found; run npm run build:client first.') }
  })
  const wss = new WebSocketServer({ noServer: true, maxPayload: adapter.maxMessageBytes || LIMIT })
  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url, origin)
    // A loopback credential relay must reject hostile web pages / DNS rebinding.
    if (!trustedHost(request) || request.headers.origin !== origin
      || !['/gateway', '/avatar'].includes(url.pathname)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      return
    }
    if (url.pathname === '/avatar' && rendererClient) {
      socket.end('HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n')
      return
    }
    wss.handleUpgrade(request, socket, head, client => {
      if (url.pathname === '/avatar') {
        rendererClient = client
        client.once('close', () => { if (rendererClient === client) rendererClient = null })
        const attaching = Promise.resolve().then(() => adapter.attach(client, { rendererUrl, rendererToken, persona, providerOptions }))
        cleanups.add(attaching)
        attaching.catch(() => client.close(1011, 'renderer unavailable'))
        client.once('close', () => {
          void attaching.then(close => close?.()).catch(() => {}).finally(() => cleanups.delete(attaching))
        })
        return
      }
      const target = new URL(upstreamUrl)
      const sessionId = url.searchParams.get('sessionId')
      if (sessionId && !/^[A-Za-z0-9_.:-]{1,128}$/.test(sessionId)) { client.close(1008, 'invalid session'); return }
      if (sessionId) target.searchParams.set('sessionId', sessionId)
      const upstream = new WebSocket(target, {
        headers: gatewayToken ? { authorization: `Bearer ${gatewayToken}` } : {},
        origin: target.origin.replace(/^ws/, 'http'), maxPayload: LIMIT, handshakeTimeout: 5000,
      })
      proxies.add(upstream)
      let pending = [], pendingBytes = 0
      const forward = (to, data, binary) => {
        if (to.readyState !== WebSocket.OPEN) return
        if (to.bufferedAmount + data.length > LIMIT) {
          client.close(1013, 'client backpressure'); upstream.close(); return
        }
        to.send(data, { binary })
      }
      client.on('message', (data, binary) => {
        if (upstream.readyState === WebSocket.CONNECTING) {
          pendingBytes += data.length
          if (pendingBytes > 64 * 1024) { client.close(1013, 'connection backpressure'); upstream.terminate(); return }
          pending.push([data, binary])
        } else forward(upstream, data, binary)
      })
      upstream.on('open', () => { for (const [data, binary] of pending) forward(upstream, data, binary); pending = []; pendingBytes = 0 })
      upstream.on('message', (data, binary) => forward(client, data, binary))
      upstream.on('error', () => client.close(1011, 'gateway unavailable'))
      upstream.on('close', (code) => { proxies.delete(upstream); client.close(code === 1000 ? 1000 : 1011, 'gateway disconnected') })
      client.on('error', () => upstream.terminate())
      client.on('close', () => { pending = []; upstream.terminate() })
    })
  })
  await new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(port, host, resolveListen)
  })
  authority = `${host.includes(':') ? `[${host}]` : host}:${server.address().port}`
  origin = `http://${authority}`
  return {
    origin, url: origin,
    async close() {
      for (const client of wss.clients) client.terminate()
      for (const upstream of proxies) upstream.terminate()
      await Promise.all([...cleanups].map(async pending => { try { await (await pending)?.() } catch { /* shutdown */ } }))
      await new Promise(resolveClose => wss.close(resolveClose))
      server.closeAllConnections()
      await new Promise(resolveClose => server.close(resolveClose))
    },
  }
}
