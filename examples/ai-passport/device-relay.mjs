#!/usr/bin/env node
/* AI Passport LAN relay. The upstream Gateway remains loopback-only. */
import http from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export function createDeviceRelay({
  WebSocket,
  WebSocketServer,
  upstream,
  accessToken,
  requireToken = true,
}) {
  const target = new URL(upstream)
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname))
    throw Error('Upstream must be loopback')
  if (!accessToken || accessToken.length < 24)
    throw Error('Configure a private device access token')
  const equal = (value) => {
    const a = Buffer.from(value),
      b = Buffer.from(`Bearer ${accessToken}`)
    return a.length === b.length && timingSafeEqual(a, b)
  }
  const allowed = (request) => {
    const supplied = request.headers.authorization
    return supplied ? equal(supplied) : !requireToken
  }
  const server = http.createServer((request, response) => {
    if (
      request.method !== 'GET' ||
      !['/', '/api/health'].includes(request.url)
    ) {
      response.writeHead(404)
      response.end()
      return
    }
    if (!allowed(request)) {
      response.writeHead(401)
      response.end('Access token required')
      return
    }
    const probe = http.get(
      new URL('/api/health', target),
      { headers: { Authorization: `Bearer ${accessToken}` }, timeout: 3000 },
      (up) => {
        let body = ''
        up.on('data', (chunk) => {
          body += chunk
          if (body.length > 65536) up.destroy()
        })
        up.on('end', () => {
          try {
            const j = JSON.parse(body)
            response.writeHead(200, {
              'Content-Type': 'application/json',
              'Cache-Control': 'no-store',
            })
            response.end(
              JSON.stringify({
                ok: j.ok === true,
                voiceConfigured: j.voiceConfigured,
                devicePort: 3101,
                tokenRequired: requireToken,
              }),
            )
          } catch {
            response.writeHead(502)
            response.end('Gateway unavailable')
          }
        })
        up.on('error', () => {
          if (!response.writableEnded) {
            response.writeHead(502)
            response.end('Gateway unavailable')
          }
        })
      },
    )
    probe.on('timeout', () => probe.destroy())
    probe.on('error', () => {
      if (!response.writableEnded) {
        response.writeHead(502)
        response.end('Gateway unavailable')
      }
    })
  })
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 65536,
    perMessageDeflate: false,
  })
  server.on('upgrade', (request, socket, head) => {
    // Browsers use the original local WebUI. Reject cross-site browser origins.
    if (
      request.url !== '/api/realtime' ||
      request.headers.origin ||
      !allowed(request)
    ) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      return
    }
    const url = new URL('/api/realtime', target)
    url.protocol = 'ws:'
    const remote = new WebSocket(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      maxPayload: 1048576,
      perMessageDeflate: false,
      handshakeTimeout: 8000,
    })
    let client
    socket.once('close', () => remote.terminate())
    remote.on('error', () => {
      if (client) client.close(1011, 'Gateway unavailable')
      else socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n')
    })
    remote.on('open', () => {
      if (socket.destroyed) {
        remote.terminate()
        return
      }
      wss.handleUpgrade(request, socket, head, (peer) => {
        client = peer
        const forward = (destination, data, binary) => {
          if (
            binary ||
            destination.readyState !== WebSocket.OPEN ||
            destination.bufferedAmount > 262144
          ) {
            console.warn(
              'Device relay closed: binary=' +
                binary +
                ' state=' +
                destination.readyState +
                ' buffered=' +
                destination.bufferedAmount,
            )
            peer.close(1013, 'Connection congested')
            remote.close()
            return
          }
          destination.send(data, { binary: false })
        }
        peer.on('message', (data, binary) => forward(remote, data, binary))
        // A voice provider can generate audio faster than real-time playback.
        // Bound downstream buffering without pausing upstream reads: WebSocket
        // control-frame pings must still be consumed and answered during congestion.
        const outbound = []
        let queuedBytes = 0,
          pumpTimer = null
        const clearOutbound = () => {
          if (pumpTimer) clearTimeout(pumpTimer)
          pumpTimer = null
          outbound.length = 0
          queuedBytes = 0
        }
        const pump = () => {
          pumpTimer = null
          if (peer.readyState !== WebSocket.OPEN) {
            clearOutbound()
            return
          }
          while (outbound.length && peer.bufferedAmount < 32768) {
            const data = outbound.shift()
            queuedBytes -= Buffer.byteLength(data)
            peer.send(data, { binary: false }, (error) => {
              if (error) peer.terminate()
            })
          }
          if (outbound.length || peer.bufferedAmount > 16384) {
            pumpTimer = setTimeout(pump, 10)
          }
        }
        const enqueue = (data) => {
          const bytes = Buffer.byteLength(data)
          if (queuedBytes + bytes > 2097152) {
            console.warn('Device relay queue limit exceeded')
            clearOutbound()
            peer.close(1013, 'Queue limit exceeded')
            remote.close()
            return false
          }
          outbound.push(data)
          queuedBytes += bytes
          return true
        }
        remote.on('message', (data, binary) => {
          if (binary) {
            peer.close(1003, 'Text messages required')
            remote.close()
            return
          }
          if (peer.readyState !== WebSocket.OPEN) return
          let event
          try {
            event = JSON.parse(data.toString())
          } catch {}
          // Negotiated GCP heartbeats must not wait behind the audio backlog.
          // Forward the ping unchanged; only the actual device may answer it.
          if (event?.type === 'session.ping') {
            forward(peer, data, false)
            return
          }
          if (
            event?.type === 'audio.delta' &&
            typeof event.audio === 'string' &&
            event.audio.length > 4096
          ) {
            for (let offset = 0; offset < event.audio.length; offset += 4096) {
              const chunk = {
                ...event,
                audio: event.audio.slice(offset, offset + 4096),
              }
              if (event.event_id)
                chunk.event_id = `${event.event_id}_${offset / 4096}`
              if (!enqueue(JSON.stringify(chunk))) return
            }
          } else if (!enqueue(data)) return
          if (!pumpTimer) pump()
        })
        peer.once('close', clearOutbound)
        peer.on('error', () => remote.terminate())
        peer.on('close', (code) => {
          console.info('Device socket closed: code=' + code)
          remote.close()
        })
        remote.on('close', (code, reason) => {
          console.info('Upstream socket closed: code=' + code)
          clearOutbound()
          // 1005/1006 are local observations, not valid close-frame status codes.
          // Preserve GCP codes (including 4001/4002/4003) and their reasons so
          // clients can distinguish terminal lease/auth states from transport loss.
          if (code === 1005) peer.close()
          else if (code === 1006) peer.close(1011, 'Gateway disconnected')
          else peer.close(code, reason)
        })
      })
    })
  })
  const closeServer = server.close.bind(server)
  server.close = (...args) => {
    for (const client of wss.clients) client.terminate()
    return closeServer(...args)
  }
  server.on('close', () => wss.close())
  return server
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const { WebSocket, WebSocketServer } = await import('ws')
  const host = process.env.DEVICE_HOST || '127.0.0.1'
  const port = Number(process.env.DEVICE_PORT || 3101)
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw Error('Invalid DEVICE_PORT')
  const requireToken = process.env.DEVICE_ALLOW_TOKEN_FREE !== '1'
  const server = createDeviceRelay({
    WebSocket,
    WebSocketServer,
    upstream: process.env.GATEWAY_URL || 'http://127.0.0.1:18888',
    accessToken: process.env.DEVICE_ACCESS_TOKEN,
    requireToken,
  })
  server.listen(port, host, () =>
    console.log(
      `Device relay listening on ${host}:${port}; token required: ${requireToken}`,
    ),
  )
  for (const signal of ['SIGTERM', 'SIGINT'])
    process.on(signal, () => server.close(() => process.exit(0)))
}
