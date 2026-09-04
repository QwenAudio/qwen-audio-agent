import { execFile as nodeExecFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  defineGatewayEndpointPublisher,
  GatewayUrlSchema,
} from './gateway-remote-access.mjs'

const execFile = promisify(nodeExecFile)

function commandError(error, code, fallback) {
  const wrapped = new Error(String(error?.stderr || error?.message || fallback).trim())
  wrapped.code = code
  wrapped.cause = error
  return wrapped
}

export function createTailscaleCommandRunner({
  command = 'tailscale',
  execFileImpl = execFile,
} = {}) {
  return async args => {
    try {
      return await execFileImpl(command, args, {
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      })
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw commandError(error, 'tailscale_not_installed', 'Tailscale is not installed')
      }
      throw commandError(error, 'tailscale_command_failed', 'Tailscale command failed')
    }
  }
}

function parseJson(stdout, label) {
  try {
    return JSON.parse(stdout || '{}')
  } catch (error) {
    const wrapped = new Error(`Tailscale ${label} returned invalid JSON`)
    wrapped.code = 'tailscale_invalid_json'
    wrapped.cause = error
    throw wrapped
  }
}

function normalizedDnsName(status) {
  return String(status?.Self?.DNSName || status?.MagicDNSSuffix || '')
    .trim()
    .replace(/\.$/, '')
}

function webRoute(config, dnsName, port) {
  const web = config?.Web || {}
  const host = Object.keys(web).find(key => (
    key === `${dnsName}:${port}`
    || (port === 443 && key === dnsName)
  ))
  if (!host) return null
  const handlers = web[host]?.Handlers || {}
  return {
    host,
    handlers,
    proxy: handlers['/']?.Proxy || null,
  }
}

function tcpRoute(config, port) {
  const route = config?.TCP?.[String(port)]
  if (!route) return null
  return route
}

function endpointUrl({ dnsName, mode, port }) {
  const protocol = mode === 'https' ? 'https' : 'http'
  const defaultPort = mode === 'https' ? 443 : 80
  return `${protocol}://${dnsName}${port === defaultPort ? '' : `:${port}`}`
}

export function createTailscaleGatewayEndpointPublisher({
  gatewayUrl = 'http://127.0.0.1:3101',
  mode = 'https',
  port = mode === 'https' ? 8443 : 8310,
  run = createTailscaleCommandRunner(),
} = {}) {
  if (!['https', 'tcp'].includes(mode)) {
    throw new TypeError('Tailscale Gateway publisher mode must be https or tcp')
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new TypeError('Tailscale Gateway publisher port must be between 1 and 65535')
  }
  const target = GatewayUrlSchema.parse(gatewayUrl)

  async function inspect() {
    let status
    try {
      status = parseJson((await run(['status', '--json'])).stdout, 'status')
    } catch (error) {
      if (error.code === 'tailscale_not_installed') {
        return { available: false, connected: false, published: false, error: error.code }
      }
      throw error
    }
    const dnsName = normalizedDnsName(status)
    const connected = status.BackendState === 'Running' && Boolean(dnsName)
    if (!connected) {
      return {
        available: true,
        connected: false,
        published: false,
        backendState: status.BackendState || 'Unknown',
      }
    }
    const serve = parseJson((await run(['serve', 'status', '--json'])).stdout, 'Serve status')
    const route = mode === 'https'
      ? webRoute(serve, dnsName, port)
      : tcpRoute(serve, port)
    const owned = mode === 'https'
      ? route?.proxy === target && Object.keys(route.handlers).length === 1
      : route?.TCPForward === target || route?.TCPForward === target.replace(/^http:/, 'tcp:')
    const occupied = Boolean(route) && !owned
    return {
      available: true,
      connected: true,
      published: Boolean(owned),
      occupied,
      backendState: status.BackendState,
      dnsName,
      endpoint: owned ? {
        url: endpointUrl({ dnsName, mode, port }),
        secure: mode === 'https',
        publisher: 'tailscale',
      } : null,
    }
  }

  async function publish() {
    const before = await inspect()
    if (!before.connected) {
      const error = new Error('Tailscale is not connected')
      error.code = before.error || 'tailscale_not_connected'
      throw error
    }
    if (before.occupied) {
      const error = new Error(`Tailscale Serve port ${port} is already in use`)
      error.code = 'tailscale_serve_port_occupied'
      throw error
    }
    if (!before.published) {
      const args = mode === 'https'
        ? ['serve', '--bg', '--yes', `--https=${port}`, target]
        : ['serve', '--bg', '--yes', `--tcp=${port}`, target.replace(/^http:/, 'tcp:')]
      await run(args)
    }
    return {
      url: endpointUrl({ dnsName: before.dnsName, mode, port }),
      secure: mode === 'https',
      publisher: 'tailscale',
    }
  }

  async function unpublish() {
    const before = await inspect()
    if (!before.published) return { published: false, changed: false }
    const args = mode === 'https'
      ? ['serve', `--https=${port}`, 'off']
      : ['serve', `--tcp=${port}`, 'off']
    await run(args)
    return { published: false, changed: true }
  }

  return defineGatewayEndpointPublisher({
    id: 'tailscale',
    inspect,
    publish,
    unpublish,
  })
}
