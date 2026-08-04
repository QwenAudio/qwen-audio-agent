export const GATEWAY_READY_MESSAGE = 'qwen-audio-agent:gateway-ready'

export function notifyGatewayReady({
  origin,
  instanceId = null,
  parentPort = process.parentPort,
  send = typeof process.send === 'function'
    ? process.send.bind(process)
    : null,
} = {}) {
  const message = {
    type: GATEWAY_READY_MESSAGE,
    origin,
    ...(instanceId ? { instanceId } : {}),
  }
  if (typeof parentPort?.postMessage === 'function') {
    parentPort.postMessage(message)
    return 'parentPort'
  }
  if (typeof send === 'function') {
    send(message)
    return 'ipc'
  }
  return null
}
