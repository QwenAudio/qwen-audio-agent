import { isIP } from 'node:net'
import { networkInterfaces } from 'node:os'
import { TailscaleServePublisher } from './tailscale-serve.mjs'

function clean(value, limit = 2_000) {
  return [...String(value || '').replaceAll('\0', '').trim()].slice(0, limit).join('')
}

const VIRTUAL_INTERFACE = /^(?:awdl|bridge|docker|ham|llw|lo|tailscale|tun|utun|vbox|vmnet|wg)/iu

function privateIpv4(address) {
  const [a, b] = address.split('.').map(Number)
  return a === 10
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
}

export function selectLanAddress(interfaces = networkInterfaces()) {
  const candidates = []
  for (const [name, entries] of Object.entries(interfaces || {})) {
    for (const entry of entries || []) {
      const family = entry.family === 4 ? 'IPv4' : entry.family
      if (entry.internal || family !== 'IPv4' || isIP(entry.address) !== 4) continue
      candidates.push({
        address: entry.address,
        preferredInterface: !VIRTUAL_INTERFACE.test(name),
        privateAddress: privateIpv4(entry.address),
        name,
      })
    }
  }
  candidates.sort((left, right) => (
    Number(right.preferredInterface) - Number(left.preferredInterface)
    || Number(right.privateAddress) - Number(left.privateAddress)
    || left.name.localeCompare(right.name)
    || left.address.localeCompare(right.address)
  ))
  return candidates[0]?.address || ''
}

function lanGatewayOrigin(localGatewayUrl, configuredHost, interfaces) {
  const local = new URL(localGatewayUrl)
  const host = String(configuredHost || '').trim() || selectLanAddress(interfaces)
  if (isIP(host) !== 4) {
    const error = new Error('未找到可用的局域网 IPv4 地址')
    error.code = 'gateway_lan_address_unavailable'
    throw error
  }
  return new URL(`http://${host}:${local.port || '80'}`).origin
}

// Gateway-facing endpoint abstraction. LAN derives a directly reachable URL;
// Tailnet obtains one through the system Tailscale adapter. External proxy
// addresses are connection-code overrides and intentionally do not live here.
export class GatewayPublicEndpointService {
  constructor({
    lan = false,
    lanHost = '',
    tailnet = false,
    publisher = null,
    logger = null,
    interfaces = undefined,
  } = {}) {
    if (lan && tailnet) {
      throw new TypeError('lan and tailnet are mutually exclusive')
    }
    this.mode = lan ? 'lan' : tailnet ? 'tailnet' : 'none'
    this.endpoint = null
    this.lanHost = lanHost
    this.interfaces = interfaces
    this.publisher = publisher || (tailnet
      ? new TailscaleServePublisher({ logger })
      : null)
    this.state = this.mode === 'none' ? 'disabled' : 'stopped'
    this.error = null
    this.generation = 0
  }

  status() {
    const publisherStatus = this.mode === 'tailnet'
      ? this.publisher?.status?.()
      : null
    if (publisherStatus?.state === 'error') {
      return {
        mode: this.mode,
        state: 'error',
        endpoint: null,
        error: {
          code: clean(publisherStatus.error?.code || 'tailscale_serve_failed', 100),
          message: clean(publisherStatus.error?.message || publisherStatus.error, 1_000),
        },
      }
    }
    return {
      mode: this.mode,
      state: this.state,
      endpoint: this.endpoint ? {
        url: this.endpoint,
        secure: this.endpoint.startsWith('https://'),
      } : null,
      error: this.error,
    }
  }

  async start(localGatewayUrl) {
    if (this.mode === 'lan') {
      try {
        this.endpoint = lanGatewayOrigin(
          localGatewayUrl,
          this.lanHost,
          this.interfaces,
        )
        this.state = 'ready'
        this.error = null
      } catch (error) {
        this.endpoint = null
        this.state = 'error'
        this.error = {
          code: clean(error?.code || 'gateway_lan_address_unavailable', 100),
          message: clean(error?.message || error, 1_000),
        }
      }
      return this.status()
    }
    if (this.mode !== 'tailnet') return this.status()
    if (this.status().state === 'ready' && this.endpoint) return this.status()
    const generation = ++this.generation
    this.state = 'starting'
    this.error = null
    try {
      const endpoint = await this.publisher.start(localGatewayUrl)
      if (generation !== this.generation) return this.status()
      this.endpoint = endpoint
      this.state = 'ready'
    } catch (error) {
      if (generation !== this.generation) return this.status()
      this.endpoint = null
      this.state = 'error'
      this.error = {
        code: clean(error?.code || 'tailscale_serve_failed', 100),
        message: clean(error?.message || error, 1_000),
      }
    }
    return this.status()
  }

  async close() {
    this.generation += 1
    if (this.mode === 'tailnet') {
      this.endpoint = null
      this.state = 'stopped'
      this.error = null
    }
    await this.publisher?.close?.()
  }
}
