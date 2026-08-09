import { WebSocket, WebSocketServer } from 'ws'
import { config } from '../core/config.mjs'
import { isAllowedOrigin } from '../core/request-security.mjs'
import { logger } from '../core/logger.mjs'

export const SPEECH_TO_SPEECH_PATH = '/api/speech-to-speech'

function rejectUpgrade(socket, status, message) {
  socket.write(
    `HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\n${message}`,
  )
  socket.destroy()
}

/**
 * Authenticated same-origin bridge from the public WebUI to the local VAD
 * service. The cloud provider keys remain inside the Python service.
 */
export function attachSpeechToSpeechGateway(server, { identityManager }) {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 8 * 1024 * 1024,
  })

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url, 'http://localhost')
    if (url.pathname !== SPEECH_TO_SPEECH_PATH) return
    if (!isAllowedOrigin(request)) {
      rejectUpgrade(socket, '403 Forbidden', 'origin not allowed')
      return
    }
    const identity = identityManager.resolveUpgrade(request)
    if (!identity) {
      rejectUpgrade(socket, '401 Unauthorized', 'identity required')
      return
    }
    wss.handleUpgrade(request, socket, head, ws => {
      wss.emit('connection', ws, url, identity)
    })
  })

  wss.on('connection', (client, url, identity) => {
    const connectionLogger = logger.child({
      subsystem: 'speech_to_speech_bridge',
      ownerId: identity.ownerId,
    })
    const upstream = new WebSocket(config.speechToSpeechVadWebSocketUrl)
    const pending = []
    let closed = false

    const closeBoth = (code = 1000, reason = '') => {
      if (closed) return
      closed = true
      if (client.readyState === WebSocket.OPEN) client.close(code, reason)
      if (
        upstream.readyState === WebSocket.OPEN
        || upstream.readyState === WebSocket.CONNECTING
      ) upstream.close(code, reason)
    }

    client.on('message', (data, isBinary) => {
      if (closed) return
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.send(data, { binary: isBinary })
        return
      }
      if (pending.length >= 100) {
        closeBoth(1013, 'upstream is not ready')
        return
      }
      pending.push({ data, isBinary })
    })

    upstream.on('open', () => {
      for (const item of pending.splice(0)) {
        upstream.send(item.data, { binary: item.isBinary })
      }
      connectionLogger.debug('bridge.connected')
    })

    upstream.on('message', (data, isBinary) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data, { binary: isBinary })
      }
    })

    client.on('close', () => closeBoth())
    client.on('error', error => {
      connectionLogger.debug('bridge.client_error', { error })
      closeBoth(1011, 'client error')
    })
    upstream.on('close', () => closeBoth(1011, 'speech service closed'))
    upstream.on('error', error => {
      connectionLogger.warn('bridge.upstream_error', { error })
      closeBoth(1011, 'speech service unavailable')
    })
  })

  return { path: SPEECH_TO_SPEECH_PATH, wss }
}
