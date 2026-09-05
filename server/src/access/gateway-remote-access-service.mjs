import { spawn as nodeSpawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { GatewayUrlSchema } from '../../../shared/gateway-remote-access.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const PACKAGE_VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
const SUPPORTED_PORTS = new Set([443, 8443, 10000])
const AUTH_URL = /^https:\/\/login\.tailscale\.com\//
const ACTION_URL = /^https:\/\/tailscale\.com\//

function clean(value, limit = 1_000) {
  return [...String(value || '').replaceAll('\0', '').trim()].slice(0, limit).join('')
}

function platformKey(platform = process.platform, arch = process.arch) {
  const supported = (
    (platform === 'darwin' && ['arm64', 'x64'].includes(arch))
    || (platform === 'linux' && ['arm64', 'x64'].includes(arch))
    || (platform === 'win32' && arch === 'x64')
  )
  if (!supported) {
    const error = new Error(`Remote access is not available on ${platform}/${arch}`)
    error.code = 'tsnet_platform_unsupported'
    throw error
  }
  return `${platform}-${arch}`
}

function executableName(platform = process.platform) {
  return platform === 'win32' ? 'qwaudio-tsnet.exe' : 'qwaudio-tsnet'
}

function parseChecksum(value) {
  const checksum = String(value || '').trim().split(/\s+/)[0]?.toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(checksum || '')) {
    const error = new Error('Remote access component returned an invalid checksum')
    error.code = 'tsnet_checksum_invalid'
    throw error
  }
  return checksum
}

async function fetchBytes(url, fetchImpl, { maxBytes = 128 * 1024 * 1024 } = {}) {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(120_000) })
  if (!response.ok) {
    const error = new Error(`Remote access component download failed (HTTP ${response.status})`)
    error.code = 'tsnet_download_failed'
    throw error
  }
  const length = Number(response.headers.get('content-length') || 0)
  if (length > maxBytes) {
    const error = new Error('Remote access component is unexpectedly large')
    error.code = 'tsnet_download_too_large'
    throw error
  }
  const bytes = Buffer.from(await response.arrayBuffer())
  if (!bytes.length || bytes.length > maxBytes) {
    const error = new Error('Remote access component has an invalid size')
    error.code = 'tsnet_download_invalid'
    throw error
  }
  return bytes
}

export async function ensureTsnetComponent({
  configDirectory,
  version = PACKAGE_VERSION,
  platform = process.platform,
  arch = process.arch,
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) {
  const configured = clean(env.QWEN_AUDIO_TSNET_BINARY, 4_000)
  if (configured) {
    const path = resolve(configured)
    if (!existsSync(path)) {
      const error = new Error(`Configured remote access component was not found: ${path}`)
      error.code = 'tsnet_binary_missing'
      throw error
    }
    return { path, source: 'configured' }
  }

  const key = platformKey(platform, arch)
  const developmentPath = join(
    ROOT,
    'sidecars',
    'tsnet',
    'bin',
    `qwaudio-tsnet-${key}${platform === 'win32' ? '.exe' : ''}`,
  )
  if (
    version === PACKAGE_VERSION
    && platform === process.platform
    && arch === process.arch
    && existsSync(developmentPath)
  ) {
    return { path: developmentPath, source: 'development' }
  }

  const componentDirectory = resolve(
    configDirectory,
    'components',
    'tsnet',
    version,
    key,
  )
  const destination = join(componentDirectory, executableName(platform))
  if (existsSync(destination)) return { path: destination, source: 'installed' }

  mkdirSync(componentDirectory, { recursive: true, mode: 0o700 })
  const asset = `qwen-audio-agent-tsnet-${key}.gz`
  const baseUrl = clean(env.QWEN_AUDIO_TSNET_DOWNLOAD_BASE_URL, 4_000)
    || `https://github.com/QwenAudio/qwen-audio-agent/releases/download/v${version}`
  const assetUrl = `${baseUrl.replace(/\/$/, '')}/${asset}`
  const [archive, checksumBytes] = await Promise.all([
    fetchBytes(assetUrl, fetchImpl),
    fetchBytes(`${assetUrl}.sha256`, fetchImpl, { maxBytes: 4_096 }),
  ])
  const expected = parseChecksum(checksumBytes.toString('utf8'))
  const actual = createHash('sha256').update(archive).digest('hex')
  if (actual !== expected) {
    const error = new Error('Remote access component checksum verification failed')
    error.code = 'tsnet_checksum_mismatch'
    throw error
  }

  let executable
  try {
    executable = gunzipSync(archive)
  } catch (cause) {
    const error = new Error('Remote access component archive is invalid')
    error.code = 'tsnet_archive_invalid'
    error.cause = cause
    throw error
  }
  const temporary = `${destination}.${process.pid}.tmp`
  writeFileSync(temporary, executable, { mode: 0o700 })
  if (platform !== 'win32') chmodSync(temporary, 0o700)
  try {
    renameSync(temporary, destination)
  } catch (error) {
    try { unlinkSync(temporary) } catch {}
    throw error
  }
  return { path: destination, source: 'downloaded' }
}

function readEnabled(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))?.enabled === true
  } catch {
    return false
  }
}

function writeEnabled(path, enabled) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify({ version: 1, enabled }, null, 2)}\n`, {
    mode: 0o600,
  })
  renameSync(temporary, path)
}

export class GatewayRemoteAccessService {
  constructor({
    configDirectory,
    logger = null,
    env = process.env,
    port = Number(env.QWEN_AUDIO_REMOTE_ACCESS_PORT || 443),
    hostname = clean(env.QWEN_AUDIO_REMOTE_ACCESS_HOSTNAME, 63) || 'qwen-audio-agent',
    spawnImpl = nodeSpawn,
    ensureComponent = options => ensureTsnetComponent(options),
  } = {}) {
    if (!configDirectory) throw new TypeError('configDirectory is required')
    if (!SUPPORTED_PORTS.has(port)) {
      throw new TypeError('Remote access port must be 443, 8443, or 10000')
    }
    this.configDirectory = resolve(configDirectory)
    this.settingsPath = join(this.configDirectory, 'state', 'remote-access.json')
    this.stateDirectory = join(this.configDirectory, 'state', 'tsnet')
    this.logger = logger
    this.env = env
    this.port = port
    this.hostname = hostname
    this.spawnImpl = spawnImpl
    this.ensureComponent = ensureComponent
    this.enabled = readEnabled(this.settingsPath)
    this.gatewayUrl = ''
    this.child = null
    this.startPromise = null
    this.stopPromise = null
    this.state = this.enabled ? 'stopped' : 'disabled'
    this.endpoint = null
    this.authUrl = null
    this.actionUrl = null
    this.error = null
    this.componentSource = null
    this.waiters = new Set()
  }

  status() {
    return {
      available: true,
      enabled: this.enabled,
      connected: this.state === 'connected',
      published: Boolean(this.endpoint),
      state: this.state,
      endpoint: this.endpoint ? {
        url: this.endpoint,
        secure: true,
      } : null,
      authUrl: this.authUrl,
      actionUrl: this.actionUrl,
      error: this.error,
    }
  }

  async enable(gatewayUrl) {
    this.enabled = true
    writeEnabled(this.settingsPath, true)
    return this.start(gatewayUrl)
  }

  async resume(gatewayUrl) {
    if (!this.enabled) return this.status()
    try {
      return await this.start(gatewayUrl)
    } catch (error) {
      this.logger?.warn?.('remote_access.resume_failed', { error })
      return this.status()
    }
  }

  async start(gatewayUrl = this.gatewayUrl) {
    this.gatewayUrl = GatewayUrlSchema.parse(gatewayUrl)
    if (this.child) return this.status()
    if (this.startPromise) return this.startPromise
    const operation = (async () => {
      if (this.stopPromise) await this.stopPromise
      this.state = 'installing'
      this.error = null
      this.authUrl = null
      this.actionUrl = null
      this.endpoint = null
      const component = await this.ensureComponent({
        configDirectory: this.configDirectory,
        env: this.env,
      })
      this.componentSource = component.source
      this.state = 'starting'
      const child = this.spawnImpl(component.path, [
        '--gateway', this.gatewayUrl,
        '--state-dir', this.stateDirectory,
        '--hostname', this.hostname,
        '--port', String(this.port),
      ], {
        env: { ...this.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
      this.child = child
      let stderr = ''
      child.stderr?.on('data', chunk => {
        stderr = clean(`${stderr}${chunk}`, 2_000)
        this.logger?.debug?.('remote_access.tsnet_log', { message: clean(chunk, 500) })
      })
      createInterface({ input: child.stdout }).on('line', line => {
        this.#handleEvent(line)
      })
      child.once('error', error => {
        this.#fail(error.code || 'tsnet_spawn_failed', error.message)
      })
      child.once('exit', (code, signal) => {
        if (this.child !== child) return
        this.child = null
        if (this.state === 'error') {
          this.#resolveWaiters()
          return
        }
        if (this.state === 'stopping' || !this.enabled) {
          this.state = this.enabled ? 'stopped' : 'disabled'
          this.#resolveWaiters()
          return
        }
        this.#fail(
          'tsnet_exited',
          stderr || `Remote access component exited (${signal || code || 'unknown'})`,
        )
      })
      return await this.#waitUntilActionable()
    })().catch(error => {
      this.#fail(error.code || 'remote_access_start_failed', error.message)
      this.child?.kill('SIGTERM')
      throw error
    }).finally(() => {
      if (this.startPromise === operation) this.startPromise = null
    })
    this.startPromise = operation
    return operation
  }

  async disable() {
    this.enabled = false
    writeEnabled(this.settingsPath, false)
    await this.stop()
    this.state = 'disabled'
    return { ...this.status(), changed: true }
  }

  async close() {
    return this.stop()
  }

  async stop() {
    if (this.stopPromise) return this.stopPromise
    const child = this.child
    if (!child) {
      this.state = this.enabled ? 'stopped' : 'disabled'
      this.endpoint = null
      this.authUrl = null
      this.actionUrl = null
      return this.status()
    }
    this.state = 'stopping'
    const operation = new Promise(resolveStop => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.child = null
        this.state = this.enabled ? 'stopped' : 'disabled'
        this.endpoint = null
        this.authUrl = null
        this.actionUrl = null
        resolveStop(this.status())
      }
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        finish()
      }, 5_000)
      timer.unref?.()
      child.once('exit', finish)
      child.kill('SIGTERM')
    }).finally(() => {
      if (this.stopPromise === operation) this.stopPromise = null
    })
    this.stopPromise = operation
    return operation
  }

  #handleEvent(line) {
    let event
    try {
      event = JSON.parse(line)
    } catch {
      this.logger?.warn?.('remote_access.invalid_event', { line: clean(line, 500) })
      return
    }
    if (event.type === 'starting') {
      this.state = 'starting'
    } else if (event.type === 'auth_required' && AUTH_URL.test(event.url || '')) {
      this.state = 'auth_required'
      this.authUrl = event.url
      this.actionUrl = null
      this.error = null
      this.#resolveWaiters()
    } else if (event.type === 'endpoint_ready') {
      const endpoint = GatewayUrlSchema.parse(event.url)
      if (!endpoint.startsWith('https://')) {
        this.#fail('tsnet_endpoint_insecure', 'Remote access endpoint must use HTTPS')
        return
      }
      this.state = 'connected'
      this.endpoint = endpoint
      this.authUrl = null
      this.actionUrl = null
      this.error = null
      this.logger?.info?.('remote_access.ready', { endpoint })
      this.#resolveWaiters()
    } else if (event.type === 'error') {
      this.actionUrl = ACTION_URL.test(event.action_url || '')
        ? event.action_url
        : null
      this.#fail(event.code || 'tsnet_failed', event.message || 'Remote access failed')
    }
  }

  #fail(code, message) {
    this.state = 'error'
    this.endpoint = null
    this.authUrl = null
    this.error = { code: clean(code, 100), message: clean(message, 1_000) }
    this.logger?.error?.('remote_access.failed', this.error)
    this.#resolveWaiters()
  }

  #waitUntilActionable() {
    if (['auth_required', 'connected', 'error'].includes(this.state)) {
      return Promise.resolve(this.status())
    }
    return new Promise((resolveWaiter, rejectWaiter) => {
      const waiter = { resolve: resolveWaiter, reject: rejectWaiter, timer: null }
      waiter.timer = setTimeout(() => {
        this.waiters.delete(waiter)
        const error = new Error('Remote access startup timed out')
        error.code = 'tsnet_start_timeout'
        rejectWaiter(error)
      }, 120_000)
      waiter.timer.unref?.()
      this.waiters.add(waiter)
    })
  }

  #resolveWaiters() {
    const status = this.status()
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer)
      waiter.resolve(status)
    }
    this.waiters.clear()
  }
}
