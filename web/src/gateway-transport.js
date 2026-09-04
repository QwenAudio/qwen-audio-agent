import { gatewayWebSocketProtocols } from '../../shared/gateway-websocket-auth.mjs'

let runtime = Object.freeze({
  gatewayUrl: '',
  accessToken: '',
  clientType: '',
  clientLabel: '',
})

function cleanGatewayUrl(value = '') {
  if (!String(value).trim()) return ''
  const url = new URL(String(value))
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new TypeError('Gateway URL must use http or https')
  }
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new TypeError('Gateway URL must be an origin')
  }
  return url.origin
}

export function configureGatewayTransport(options = {}) {
  runtime = Object.freeze({
    gatewayUrl: cleanGatewayUrl(options.gatewayUrl),
    accessToken: String(options.accessToken || '').trim(),
    clientType: String(options.clientType || '').trim(),
    clientLabel: String(options.clientLabel || '').trim(),
  })
  return runtime
}

export function gatewayTransportConfig() {
  return runtime
}

export function gatewayClientType(fallback = 'web') {
  return runtime.clientType || fallback
}

export function gatewayClientLabel(fallback = 'WebUI') {
  return runtime.clientLabel || fallback
}

export function gatewayHttpUrl(path) {
  if (!runtime.gatewayUrl) return path
  return new URL(String(path).replace(/^\//, ''), `${runtime.gatewayUrl}/`).toString()
}

export function gatewayFetch(path, init = {}, fetchImpl = globalThis.fetch) {
  const headers = new Headers(init.headers || {})
  if (runtime.accessToken) headers.set('Authorization', `Bearer ${runtime.accessToken}`)
  return fetchImpl(gatewayHttpUrl(path), {
    ...init,
    headers,
    credentials: 'include',
  })
}

export function gatewayRealtimeUrl(sessionId, locationValue = globalThis.location) {
  const base = runtime.gatewayUrl
    ? new URL(runtime.gatewayUrl)
    : new URL(locationValue.href)
  const protocol = base.protocol === 'https:' ? 'wss:' : 'ws:'
  const basePath = runtime.gatewayUrl
    ? '/'
    : base.pathname.endsWith('/')
      ? base.pathname
      : base.pathname.replace(/[^/]*$/, '')
  return `${protocol}//${base.host}${basePath}api/realtime?sessionId=${encodeURIComponent(sessionId)}`
}

export function createGatewayWebSocket(url, _options = {}, WebSocketImpl = globalThis.WebSocket) {
  const protocols = gatewayWebSocketProtocols(runtime.accessToken)
  if (protocols.length && new URL(url).protocol !== 'wss:') {
    throw new Error('Remote Gateway credentials require a secure WebSocket endpoint')
  }
  return protocols.length
    ? new WebSocketImpl(url, protocols)
    : new WebSocketImpl(url)
}
