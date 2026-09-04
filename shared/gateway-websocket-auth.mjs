export const GATEWAY_WEBSOCKET_PROTOCOL = 'qwaudio.gcp.v6'

const GATEWAY_WEBSOCKET_BEARER_PREFIX = 'qwaudio.bearer.'
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{24,256}$/

function protocolValues(header = '') {
  return String(header)
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
}

// Browsers cannot attach Authorization to a WebSocket upgrade. Remote web
// clients therefore carry the revocable device token in a secondary, TLS-
// protected subprotocol value. The server only selects the public GCP
// protocol, so the credential is never echoed back to JavaScript.
export function gatewayWebSocketProtocols(accessToken = '') {
  const token = String(accessToken || '').trim()
  if (!token) return []
  if (!TOKEN_PATTERN.test(token)) {
    throw new TypeError('Gateway WebSocket credential contains invalid characters')
  }
  return [GATEWAY_WEBSOCKET_PROTOCOL, `${GATEWAY_WEBSOCKET_BEARER_PREFIX}${token}`]
}

export function gatewayWebSocketBearer(header = '') {
  const value = protocolValues(header).find(protocol => (
    protocol.startsWith(GATEWAY_WEBSOCKET_BEARER_PREFIX)
  ))
  if (!value) return ''
  const token = value.slice(GATEWAY_WEBSOCKET_BEARER_PREFIX.length)
  return TOKEN_PATTERN.test(token) ? token : ''
}

export function selectGatewayWebSocketProtocol(protocols) {
  return protocols.has(GATEWAY_WEBSOCKET_PROTOCOL)
    ? GATEWAY_WEBSOCKET_PROTOCOL
    : false
}
