import { createConnection } from 'node:net'
import { backendEnvironment } from '../../../../../shared/backend/environment.mjs'

function serviceEndpointPort(target) {
  if (target.port) return Number(target.port)
  return ['https:', 'wss:'].includes(target.protocol) ? 443 : 80
}

export function clean(value) {
  return String(value || '').trim()
}

export function processAcpConnection({
  command,
  args = [],
  cwd,
  env = process.env,
  prepare,
}) {
  return {
    kind: 'process',
    command,
    args,
    cwd,
    env,
    prepare,
  }
}

export function endpointAvailable(value, timeoutMs = 300) {
  let target
  try {
    target = new URL(value)
  } catch {
    return Promise.resolve(false)
  }
  const port = serviceEndpointPort(target)
  return new Promise(resolvePromise => {
    const socket = createConnection({
      host: target.hostname,
      port,
    })
    const finish = available => {
      socket.destroy()
      resolvePromise(available)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

export function baseEnvironment(protocol, additions = {}) {
  return backendEnvironment(protocol, { additions })
}

export function websocketUrl(httpUrl) {
  const url = new URL(httpUrl)
  url.protocol = ['https:', 'wss:'].includes(url.protocol) ? 'wss:' : 'ws:'
  return url.toString().replace(/\/+$/, '')
}
