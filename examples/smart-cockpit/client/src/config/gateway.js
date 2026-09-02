function gatewayOrigin() {
  return import.meta.env.VITE_GATEWAY_ORIGIN || window.location.origin
}

export function gatewayHttpUrl(path) {
  return new URL(path, gatewayOrigin()).toString()
}

export function gatewayWebSocketUrl(path) {
  const url = new URL(path, gatewayOrigin())
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url
}
