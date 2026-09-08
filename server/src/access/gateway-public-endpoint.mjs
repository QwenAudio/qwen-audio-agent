import { GatewayUrlSchema } from '../../../shared/gateway/remote-access.mjs'
import { TailscaleServePublisher } from './tailscale-serve.mjs'

function clean(value, limit = 2_000) {
  return [...String(value || '').replaceAll('\0', '').trim()].slice(0, limit).join('')
}

function secureGatewayOrigin(value) {
  const origin = GatewayUrlSchema.parse(value)
  if (!origin.startsWith('https://')) {
    const error = new Error('Gateway public URL must use HTTPS')
    error.code = 'gateway_public_url_insecure'
    throw error
  }
  return origin
}

// Gateway-facing endpoint abstraction. A self-hosted proxy supplies a URL;
// Tailnet mode supplies the same URL through the system Tailscale adapter.
export class GatewayPublicEndpointService {
  constructor({
    tailnet = false,
    publicUrl = '',
    publisher = null,
    logger = null,
  } = {}) {
    if (tailnet && publicUrl) {
      throw new TypeError('tailnet and publicUrl are mutually exclusive')
    }
    this.mode = tailnet ? 'tailnet' : publicUrl ? 'external' : 'none'
    this.endpoint = publicUrl ? secureGatewayOrigin(publicUrl) : null
    this.publisher = publisher || (tailnet
      ? new TailscaleServePublisher({ logger })
      : null)
    this.state = this.endpoint ? 'ready' : this.mode === 'none' ? 'disabled' : 'stopped'
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
      endpoint: this.endpoint ? { url: this.endpoint, secure: true } : null,
      error: this.error,
    }
  }

  async start(localGatewayUrl) {
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

export { secureGatewayOrigin }
