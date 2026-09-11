import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'
import { GatewayUrlSchema } from '../../../shared/gateway/remote-access.mjs'

const execute = promisify(execFile)

export function tailscaleCommand({
  env = process.env, platform = process.platform,
  homeDirectory = homedir(), fileExists = existsSync,
} = {}) {
  if (env.QWEN_AUDIO_TAILSCALE_BINARY?.trim()) return env.QWEN_AUDIO_TAILSCALE_BINARY.trim()
  if (platform !== 'darwin') return 'tailscale'
  return [
    '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
    `${homeDirectory}/Applications/Tailscale.app/Contents/MacOS/Tailscale`,
  ].find(fileExists) || 'tailscale'
}

// Serve prints the service URL on its own line. Consent/help URLs are not
// endpoints, and even a candidate must be checked against structured status.
export function endpointFromOutput(text) {
  for (const line of String(text).split('\n')) {
    try {
      const origin = GatewayUrlSchema.parse(line.trim())
      const url = new URL(origin)
      if (url.protocol === 'https:' && url.hostname.endsWith('.ts.net')) return origin
    } catch { /* Not an endpoint line. */ }
  }
  return null
}

// --json emits ipn.ServeConfig, including Foreground, unlike the human table:
// https://github.com/tailscale/tailscale/blob/main/cmd/tailscale/cli/serve_legacy.go
/** Match only a private, foreground HTTPS root proxy to this Gateway. */
export function confirmsServeEndpoint(status, endpoint, target) {
  const url = new URL(endpoint)
  const hostPort = `${url.hostname}:${url.port || '443'}`
  if (status?.AllowFunnel?.[hostPort]) return false
  return Object.values(status?.Foreground || {}).some(config => {
    if (!config?.TCP?.[url.port || '443']?.HTTPS || config.AllowFunnel?.[hostPort]) return false
    const proxy = config.Web?.[hostPort]?.Handlers?.['/']?.Proxy
    try { return GatewayUrlSchema.parse(proxy) === target } catch { return false }
  })
}

async function readServeStatus(command, { signal }) {
  const { stdout } = await execute(command, ['serve', 'status', '--json'], {
    signal, timeout: 3_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, windowsHide: true,
  })
  return JSON.parse(stdout)
}

function failure(code, message) {
  return Object.assign(new Error(message), { code })
}

/** Owns one foreground Serve claim, never the user's Tailscale daemon. */
export class TailscaleServePublisher {
  constructor({
    command = tailscaleCommand(), spawnImpl = spawn, readStatus = readServeStatus,
    logger = null, timeoutMs = 30_000, probeIntervalMs = 500, shutdownMs = 5_000,
  } = {}) {
    Object.assign(this, { command, spawnImpl, readStatus, logger, timeoutMs, probeIntervalMs, shutdownMs })
    this.run = null
    this.closePromise = null
    this.state = 'stopped'
    this.endpoint = null
    this.error = null
  }

  status() { return { state: this.state, endpoint: this.endpoint, error: this.error } }

  async start(localGatewayUrl) {
    if (this.closePromise) await this.closePromise
    if (this.run && this.state === 'ready') return this.endpoint
    if (this.run && this.state === 'starting') return this.run.promise
    if (this.run) {
      await this.close()
      return this.start(localGatewayUrl)
    }
    const target = GatewayUrlSchema.parse(localGatewayUrl)
    const run = { controller: new AbortController(), exited: false, settled: false, readers: [] }
    this.run = run
    this.state = 'starting'
    this.endpoint = null
    this.error = null
    run.promise = new Promise((resolveStart, rejectStart) => {
      const settle = (error, endpoint) => {
        if (run.settled) return
        run.settled = true
        clearTimeout(run.timer)
        clearTimeout(run.probeTimer)
        run.controller.abort()
        if (error) rejectStart(error)
        else resolveStart(endpoint)
      }
      run.cancel = () => settle(failure('tailscale_serve_cancelled', 'Tailscale Serve 启动已取消'))
      const fail = error => {
        if (this.run !== run || run.stopping || this.state === 'error') return
        this.state = 'error'
        this.error = error
        this.endpoint = null
        settle(error)
        this.logger?.error?.('tailnet.failed', { code: error.code, message: error.message })
        void this.stopRun(run)
      }
      run.exitPromise = new Promise(resolveExit => { run.resolveExit = resolveExit })
      const exited = () => {
        run.exited = true
        clearTimeout(run.killTimer)
        run.readers.forEach(reader => reader.close())
        run.resolveExit()
      }
      try {
        run.child = this.spawnImpl(this.command, ['serve', '--yes', target], {
          stdio: ['inherit', 'pipe', 'pipe'], windowsHide: true,
        })
      } catch (error) {
        exited()
        fail(failure(error.code === 'ENOENT' ? 'tailscale_not_installed' : 'tailscale_serve_failed', error.message))
        return
      }
      run.child.once('error', error => {
        exited()
        fail(failure(error.code === 'ENOENT' ? 'tailscale_not_installed' : 'tailscale_serve_failed',
          error.code === 'ENOENT'
            ? 'Tailscale 未安装；请先安装并登录官方 Tailscale 客户端'
            : `无法启动 Tailscale Serve：${error.message}`))
      })
      run.child.once('exit', (code, signal) => {
        exited()
        fail(failure('tailscale_serve_exited', `Tailscale Serve 已退出（${signal || code || 'unknown'}）`))
      })
      const check = async () => {
        if (run.checking || run.settled || !run.candidate) return
        run.checking = true
        try {
          const status = await this.readStatus(this.command, { signal: run.controller.signal })
          if (this.run !== run || run.settled || run.exited) return
          if (confirmsServeEndpoint(status, run.candidate, target)) {
            this.endpoint = run.candidate
            this.state = 'ready'
            this.logger?.info?.('tailnet.ready', { endpoint: this.endpoint })
            settle(null, this.endpoint)
          }
        } catch {
          // A startup race or a transient status-query failure is retried
          // within the same deadline. It can never establish readiness.
        } finally {
          run.checking = false
          if (!run.settled) {
            run.probeTimer = setTimeout(check, this.probeIntervalMs)
            run.probeTimer.unref?.()
          }
        }
      }
      for (const stream of [run.child.stdout, run.child.stderr]) {
        if (!stream) continue
        const reader = createInterface({ input: stream })
        run.readers.push(reader)
        reader.on('line', line => {
          if (run.settled) return
          const candidate = endpointFromOutput(line)
          if (!candidate) return
          run.candidate = candidate
          clearTimeout(run.probeTimer)
          void check()
        })
      }
      run.timer = setTimeout(() => fail(failure('tailscale_serve_timeout',
        '等待 Tailscale Serve 就绪超时；请确认已登录并启用 HTTPS，可运行 tailscale serve 完成授权')), this.timeoutMs)
      run.timer.unref?.()
    })
    return run.promise
  }

  stopRun(run) {
    if (run.stopPromise) return run.stopPromise
    if (run.exited) return Promise.resolve()
    run.stopPromise = run.exitPromise
    // Install the deadline before signalling: test doubles and failed spawns
    // may report exit immediately. Keep the child reference until cleanup.
    run.killTimer = setTimeout(() => {
      run.child.kill('SIGKILL')
      run.readers.forEach(reader => reader.close())
      run.resolveExit()
    }, this.shutdownMs)
    run.killTimer.unref?.()
    run.child.kill('SIGTERM')
    return run.stopPromise
  }

  async close() {
    if (this.closePromise) return this.closePromise
    const run = this.run
    this.state = 'stopped'
    this.endpoint = null
    this.error = null
    if (!run) return
    run.stopping = true
    run.cancel()
    const closing = this.stopRun(run).finally(() => {
      if (this.run === run) this.run = null
      if (this.closePromise === closing) this.closePromise = null
    })
    this.closePromise = closing
    return closing
  }
}
