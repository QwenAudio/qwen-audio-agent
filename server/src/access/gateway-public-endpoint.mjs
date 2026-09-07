import { spawn as nodeSpawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { createInterface } from 'node:readline'
import { GatewayUrlSchema } from '../../../shared/gateway/remote-access.mjs'

const HTTPS_ORIGIN = /https:\/\/[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::\d+)?/i

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

function endpointFromOutput(value) {
  const match = clean(value).match(HTTPS_ORIGIN)
  if (!match) return null
  try {
    return secureGatewayOrigin(match[0])
  } catch {
    return null
  }
}

function tailscaleCommand({
  env = process.env,
  platform = process.platform,
  homeDirectory = homedir(),
  fileExists = existsSync,
} = {}) {
  const configured = clean(env.QWEN_AUDIO_TAILSCALE_BINARY)
  if (configured) return configured
  if (platform !== 'darwin') return 'tailscale'
  const candidates = [
    '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
    `${homeDirectory}/Applications/Tailscale.app/Contents/MacOS/Tailscale`,
  ]
  return candidates.find(candidate => fileExists(candidate)) || 'tailscale'
}

// Network-specific adapter. It owns only the foreground `tailscale serve`
// claim; Gateway authentication and client pairing remain separate.
export class TailscaleServePublisher {
  constructor({
    command = tailscaleCommand(),
    spawnImpl = nodeSpawn,
    logger = null,
    timeoutMs = 30_000,
  } = {}) {
    this.command = command
    this.spawnImpl = spawnImpl
    this.logger = logger
    this.timeoutMs = timeoutMs
    this.child = null
    this.endpoint = null
    this.startPromise = null
    this.stopping = false
    this.state = 'stopped'
    this.error = null
  }

  status() {
    return {
      state: this.state,
      endpoint: this.endpoint,
      error: this.error,
    }
  }

  async start(localGatewayUrl) {
    if (this.endpoint && this.child) return this.endpoint
    if (this.startPromise) return this.startPromise
    const target = GatewayUrlSchema.parse(localGatewayUrl)
    this.stopping = false
    this.state = 'starting'
    this.error = null
    const operation = new Promise((resolveStart, rejectStart) => {
      let output = ''
      let settled = false
      let timer = null
      const child = this.spawnImpl(this.command, [
        'serve',
        '--yes',
        target,
      ], {
        stdio: ['inherit', 'pipe', 'pipe'],
        windowsHide: true,
      })
      this.child = child

      const fail = (code, message, cause = null) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.child = null
        const error = new Error(message)
        error.code = code
        if (cause) error.cause = cause
        this.state = 'error'
        this.error = error
        rejectStart(error)
      }
      const observe = chunk => {
        const text = clean(chunk)
        output = clean(`${output}\n${text}`)
        this.logger?.debug?.('tailnet.serve_output', { message: text })
        const endpoint = endpointFromOutput(text)
        if (!endpoint || settled) return
        settled = true
        clearTimeout(timer)
        this.endpoint = endpoint
        this.state = 'ready'
        this.logger?.info?.('tailnet.ready', { endpoint })
        resolveStart(endpoint)
      }
      for (const stream of [child.stdout, child.stderr]) {
        if (!stream) continue
        createInterface({ input: stream }).on('line', observe)
      }
      child.once('error', error => {
        fail(
          error?.code === 'ENOENT' ? 'tailscale_not_installed' : 'tailscale_serve_failed',
          error?.code === 'ENOENT'
            ? 'Tailscale 未安装；请先安装并登录官方 Tailscale 客户端'
            : `无法启动 Tailscale Serve：${error.message}`,
          error,
        )
      })
      child.once('exit', (code, signal) => {
        const wasStopping = this.stopping
        if (this.child === child) this.child = null
        this.endpoint = null
        if (wasStopping) {
          this.state = 'stopped'
          return
        }
        if (settled) {
          const error = new Error(
            output || `Tailscale Serve 已退出（${signal || code || 'unknown'}）`,
          )
          error.code = 'tailscale_serve_exited'
          this.state = 'error'
          this.error = error
          this.logger?.error?.('tailnet.exited', {
            code,
            signal,
            message: error.message,
          })
          return
        }
        fail(
          'tailscale_serve_exited',
          output || `Tailscale Serve 已退出（${signal || code || 'unknown'}）`,
        )
      })
      timer = setTimeout(() => {
        child.kill('SIGTERM')
        fail(
          'tailscale_serve_timeout',
          output || '等待 Tailscale Serve 提供 HTTPS 地址超时；请确认 Tailscale 已登录并启用 HTTPS',
        )
      }, this.timeoutMs)
      timer.unref?.()
    }).finally(() => {
      if (this.startPromise === operation) this.startPromise = null
    })
    this.startPromise = operation
    return operation
  }

  async close() {
    const child = this.child
    this.stopping = true
    this.child = null
    this.endpoint = null
    this.state = 'stopped'
    this.error = null
    if (!child) return
    await new Promise(resolveClose => {
      let done = false
      const finish = () => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolveClose()
      }
      child.once('exit', finish)
      child.kill('SIGTERM')
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        finish()
      }, 5_000)
      timer.unref?.()
    })
  }
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
    if (this.state === 'ready' && this.endpoint) return this.status()
    this.state = 'starting'
    this.error = null
    try {
      this.endpoint = await this.publisher.start(localGatewayUrl)
      this.state = 'ready'
    } catch (error) {
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
    await this.publisher?.close?.()
    if (this.mode === 'tailnet') {
      this.endpoint = null
      this.state = 'stopped'
    }
  }
}

export { endpointFromOutput, secureGatewayOrigin, tailscaleCommand }
