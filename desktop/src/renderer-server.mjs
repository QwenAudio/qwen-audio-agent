import { randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import {
  createServer,
  request as httpRequest,
} from 'node:http'
import { request as httpsRequest } from 'node:https'
import { extname, relative, resolve } from 'node:path'
import { WebSocket, WebSocketServer } from 'ws'

const CONTENT_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.webp', 'image/webp'],
])

const CSP = [
  "default-src 'self'",
  "base-uri 'none'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "object-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
].join('; ')

function targetUrl(target) {
  const value = typeof target === 'function' ? target() : target
  return new URL(value)
}

function gatewayHeaders(headers, target) {
  return {
    ...headers,
    host: target.host,
    origin: target.origin,
  }
}

function proxyHttp(request, response, target) {
  const url = targetUrl(target)
  const requestImpl = url.protocol === 'https:' ? httpsRequest : httpRequest
  const upstream = requestImpl({
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port || undefined,
    method: request.method,
    path: request.url,
    headers: gatewayHeaders(request.headers, url),
  }, upstreamResponse => {
    response.writeHead(
      upstreamResponse.statusCode || 502,
      upstreamResponse.headers,
    )
    upstreamResponse.pipe(response)
  })
  upstream.on('error', () => {
    sendError(response, 502, 'Gateway is unavailable')
  })
  request.on('aborted', () => upstream.destroy())
  request.pipe(upstream)
}

function gatewayWebSocketUrl(target, requestUrl) {
  const url = targetUrl(target)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = new URL(requestUrl, 'http://127.0.0.1').pathname
  url.search = new URL(requestUrl, 'http://127.0.0.1').search
  return url
}

function relayClose(destination, code, reason) {
  const validCode = (
    Number.isInteger(code)
    && code >= 1000
    && code <= 4999
    && ![1004, 1005, 1006, 1015].includes(code)
  ) ? code : 1000
  destination.close(validCode, reason)
}

function relayWebSocket({
  localSockets,
  request,
  socket,
  head,
  target,
}) {
  localSockets.handleUpgrade(request, socket, head, client => {
    const gatewayUrl = gatewayWebSocketUrl(target, request.url)
    const upstream = new WebSocket(gatewayUrl, {
      headers: {
        ...(request.headers.cookie ? { cookie: request.headers.cookie } : {}),
        origin: targetUrl(target).origin,
        ...(request.headers['user-agent']
          ? { 'user-agent': request.headers['user-agent'] }
          : {}),
      },
      handshakeTimeout: 5000,
      maxPayload: 2 * 1024 * 1024,
    })
    const pending = []
    const forward = (destination, data, isBinary) => {
      if (destination.readyState === WebSocket.OPEN) {
        destination.send(data, { binary: isBinary })
      }
    }
    client.on('message', (data, isBinary) => {
      if (upstream.readyState === WebSocket.CONNECTING) {
        pending.push({ data, isBinary })
      } else {
        forward(upstream, data, isBinary)
      }
    })
    upstream.once('open', () => {
      for (const message of pending) {
        forward(upstream, message.data, message.isBinary)
      }
    })
    upstream.on('message', (data, isBinary) => {
      forward(client, data, isBinary)
    })
    client.once('close', (code, reason) => {
      if (upstream.readyState === WebSocket.CONNECTING) {
        upstream.terminate()
      } else if (upstream.readyState === WebSocket.OPEN) {
        relayClose(upstream, code, reason)
      }
    })
    upstream.once('close', (code, reason) => {
      if (client.readyState === WebSocket.OPEN) {
        relayClose(client, code === 1006 ? 1011 : code, reason)
      }
    })
    client.once('error', () => upstream.terminate())
    upstream.once('error', () => {
      if (client.readyState === WebSocket.OPEN) {
        client.close(1011, 'Gateway is unavailable')
      }
    })
  })
}

function sendError(response, status, message) {
  if (response.headersSent) {
    response.destroy()
    return
  }
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'text/plain; charset=utf-8',
    'x-content-type-options': 'nosniff',
  })
  response.end(message)
}

function safeStaticPath(webRoot, pathname) {
  let decoded
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null
  }
  const candidate = resolve(webRoot, decoded || 'index.html')
  const pathFromRoot = relative(webRoot, candidate)
  if (pathFromRoot.startsWith('..') || pathFromRoot.includes('\0')) return null
  return candidate
}

async function serveStatic(response, request, webRoot, pathname) {
  if (!['GET', 'HEAD'].includes(request.method || 'GET')) {
    sendError(response, 405, 'method not allowed')
    return
  }
  let filePath = safeStaticPath(webRoot, pathname)
  if (!filePath) {
    sendError(response, 404, 'not found')
    return
  }
  try {
    if (!(await stat(filePath)).isFile()) throw new Error('not a file')
  } catch {
    filePath = resolve(webRoot, 'index.html')
    try {
      if (!(await stat(filePath)).isFile()) throw new Error('not a file')
    } catch {
      sendError(response, 503, 'desktop renderer is unavailable')
      return
    }
  }
  const extension = extname(filePath).toLowerCase()
  response.writeHead(200, {
    'cache-control': pathname.startsWith('assets/')
      ? 'public, max-age=31536000, immutable'
      : 'no-store',
    'content-security-policy': CSP,
    'content-type': CONTENT_TYPES.get(extension) || 'application/octet-stream',
    'cross-origin-resource-policy': 'same-origin',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
  })
  if (request.method === 'HEAD') {
    response.end()
    return
  }
  createReadStream(filePath).pipe(response)
}

async function serveSkinStatic(response, request, skinsRoot, pathname) {
  if (!['GET', 'HEAD'].includes(request.method || 'GET')) {
    sendError(response, 405, 'method not allowed')
    return
  }
  const filePath = skinsRoot ? safeStaticPath(skinsRoot, pathname) : null
  if (!filePath) {
    sendError(response, 404, 'not found')
    return
  }
  try {
    if (!(await stat(filePath)).isFile()) throw new Error('not a file')
  } catch {
    // 皮肤资源缺失直接 404，不回退 index.html。
    sendError(response, 404, 'not found')
    return
  }
  const extension = extname(filePath).toLowerCase()
  response.writeHead(200, {
    'cache-control': 'no-store',
    'content-security-policy': CSP,
    'content-type': CONTENT_TYPES.get(extension) || 'application/octet-stream',
    'cross-origin-resource-policy': 'same-origin',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
  })
  if (request.method === 'HEAD') {
    response.end()
    return
  }
  createReadStream(filePath).pipe(response)
}

export async function startDesktopRendererServer({
  webRoot,
  target,
  skinsRoot = '',
  token = randomBytes(24).toString('hex'),
} = {}) {
  if (!webRoot) throw new Error('desktop renderer web root is required')
  targetUrl(target)
  const prefix = `/${token}/`
  const localSockets = new WebSocketServer({
    noServer: true,
    maxPayload: 2 * 1024 * 1024,
  })
  let origin = ''
  const server = createServer((request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1')
    if (!url.pathname.startsWith(prefix)) {
      sendError(response, 404, 'not found')
      return
    }
    const pathname = url.pathname.slice(prefix.length)
    if (pathname === 'api' || pathname.startsWith('api/')) {
      if (request.headers.origin && request.headers.origin !== origin) {
        sendError(response, 403, 'origin not allowed')
        return
      }
      request.url = `/${pathname}${url.search}`
      proxyHttp(request, response, target)
      return
    }
    if (pathname.startsWith('skins/')) {
      void serveSkinStatic(
        response,
        request,
        skinsRoot,
        pathname.slice('skins/'.length),
      )
      return
    }
    void serveStatic(response, request, webRoot, pathname)
  })

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1')
    const realtimePath = `${prefix}api/realtime`
    if (url.pathname !== realtimePath) {
      socket.destroy()
      return
    }
    if (request.headers.origin !== origin) {
      socket.destroy()
      return
    }
    request.url = `/api/realtime${url.search}`
    relayWebSocket({
      localSockets,
      request,
      socket,
      head,
      target,
    })
  })

  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectListen)
      resolveListen()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    throw new Error('desktop renderer did not bind a TCP port')
  }
  origin = `http://127.0.0.1:${address.port}`
  let closed = false
  return {
    origin,
    baseUrl: `${origin}${prefix}`,
    async close() {
      if (closed) return
      closed = true
      for (const client of localSockets.clients) client.terminate()
      localSockets.close()
      await new Promise(resolveClose => server.close(resolveClose))
    },
  }
}
