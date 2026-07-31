import { createConnection } from 'node:net'
import { execFileSync } from 'node:child_process'
import { dirname, posix, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateAppUrl } from './security.mjs'

const here = dirname(fileURLToPath(import.meta.url))

export const DEFAULT_GATEWAY_ENTRY = resolve(here, '../../server/src/index.mjs')
export const GATEWAY_READY_MESSAGE = 'qwen-audio-agent:gateway-ready'

function uniquePath(entries, separator = ':') {
  return [...new Set(entries.filter(Boolean))].join(separator)
}

export function desktopExecutablePath({
  env = process.env,
  platform = process.platform,
  execFileSyncImpl = execFileSync,
} = {}) {
  const separator = platform === 'win32' ? ';' : ':'
  const configured = String(env.PATH || '').split(separator)
  if (platform !== 'darwin') return uniquePath(configured, separator)
  let loginPath = []
  try {
    const shell = env.SHELL || '/bin/zsh'
    const output = execFileSyncImpl(
      shell,
      ['-ilc', 'printf "__QWAUDIO_PATH__%s" "$PATH"'],
      {
        encoding: 'utf8',
        env,
        timeout: 3000,
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    )
    const marker = String(output).lastIndexOf('__QWAUDIO_PATH__')
    if (marker >= 0) {
      loginPath = String(output)
        .slice(marker + '__QWAUDIO_PATH__'.length)
        .trim()
        .split(':')
    }
  } catch {
    // Fall back to common macOS installation paths below.
  }
  return uniquePath([
    ...loginPath,
    env.HOME ? posix.join(env.HOME, '.local/bin') : '',
    env.HOME ? posix.join(env.HOME, '.npm-global/bin') : '',
    '/opt/homebrew/bin',
    '/usr/local/bin',
    ...configured,
  ], separator)
}

export function desktopGatewayEnvironment({
  env = process.env,
  configured = {},
  runtimeRoot = '',
  sourceRoot = '',
  platform = process.platform,
  execFileSyncImpl = execFileSync,
} = {}) {
  const merged = {
    ...env,
    ...configured,
  }
  if (Object.hasOwn(configured, 'DASHSCOPE_API_KEY')) {
    merged.QWEN_AUDIO_REALTIME_API_KEY = configured.DASHSCOPE_API_KEY
  }
  return {
    ...merged,
    PATH: desktopExecutablePath({
      env: merged,
      platform,
      execFileSyncImpl,
    }),
    QWEN_AUDIO_AGENT_DESKTOP: '1',
    QWEN_AUDIO_AGENT_DESKTOP_INSTALLED_ONLY: '1',
    ...(runtimeRoot
      ? { QWEN_AUDIO_AGENT_RUNTIME_ROOT: runtimeRoot }
      : {}),
    ...(sourceRoot
      ? { QWEN_AUDIO_AGENT_SOURCE_ROOT: sourceRoot }
      : {}),
  }
}

export function portInUse(host, port, timeoutMs = 300) {
  return new Promise(resolvePromise => {
    const socket = createConnection({ host, port })
    const finish = value => {
      socket.destroy()
      resolvePromise(value)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

export class EmbeddedGateway {
  constructor({
    entry = DEFAULT_GATEWAY_ENTRY,
    host = '127.0.0.1',
    preferredPort = 3101,
    env = process.env,
    envFactory = null,
    forkImpl = null,
    probeImpl = portInUse,
    startupTimeoutMs = 15000,
    stopTimeoutMs = 2000,
  } = {}) {
    this.entry = entry
    this.host = host
    this.preferredPort = preferredPort
    this.env = env
    this.envFactory = envFactory
    this.forkImpl = forkImpl
    this.probeImpl = probeImpl
    this.startupTimeoutMs = startupTimeoutMs
    this.stopTimeoutMs = stopTimeoutMs
    this.child = null
    this.childState = null
    this.origin = null
    this.startOperation = null
    this.startPromise = null
    this.stopPromise = null
    this.onUnexpectedExit = null
  }

  get running() {
    return Boolean(this.child && this.origin)
  }

  start({ preferredPort = this.preferredPort } = {}) {
    if (this.running) return Promise.resolve(this.origin)
    if (this.startPromise) return this.startPromise

    const operation = {
      cancelled: false,
      cancel: null,
      childState: null,
    }
    const pendingStop = this.stopPromise
    this.startOperation = operation
    const startPromise = (async () => {
      if (pendingStop) await pendingStop
      this.assertActiveStart(operation)
      return this.startOnce(preferredPort, operation)
    })().finally(() => {
      if (this.startOperation === operation) this.startOperation = null
      if (this.startPromise === startPromise) this.startPromise = null
    })
    this.startPromise = startPromise
    return startPromise
  }

  assertActiveStart(operation) {
    if (operation.cancelled || this.startOperation !== operation) {
      throw new Error('内嵌 Gateway 启动已取消')
    }
  }

  async startOnce(preferredPort, operation) {
    this.preferredPort = preferredPort
    const busy = await this.probeImpl(this.host, preferredPort)
    this.assertActiveStart(operation)
    // PORT=0 tells the gateway to bind a random loopback port; the actual
    // origin arrives with the ready message.
    const port = busy ? 0 : preferredPort
    // Imported lazily so this module also loads outside Electron (tests).
    const fork = this.forkImpl || (await import('electron')).utilityProcess.fork
    this.assertActiveStart(operation)
    const environment = this.envFactory ? this.envFactory() : this.env
    const child = fork(this.entry, [], {
      env: {
        ...environment,
        HOST: this.host,
        PORT: String(port),
      },
      stdio: 'inherit',
    })
    const childState = {
      child,
      exited: false,
      killIssued: false,
      planned: false,
      ready: false,
    }
    operation.childState = childState
    this.child = child
    this.childState = childState
    child.once('exit', (code, signal) => {
      childState.exited = true
      if (this.childState === childState) {
        this.child = null
        this.childState = null
        this.origin = null
      }
      if (childState.ready && !childState.planned) {
        this.onUnexpectedExit?.(code, signal)
      }
    })

    try {
      const origin = await this.waitUntilReady(operation, childState)
      this.assertActiveStart(operation)
      if (childState.exited || this.childState !== childState) {
        throw new Error('内嵌 Gateway 提前退出（unknown）')
      }
      childState.ready = true
      this.origin = origin
      return origin
    } catch (error) {
      if (this.childState === childState) {
        this.child = null
        this.childState = null
        this.origin = null
      }
      if (!childState.planned) childState.planned = true
      if (!childState.killIssued) {
        childState.killIssued = true
        child.kill()
      }
      throw error
    }
  }

  waitUntilReady(operation, childState) {
    const { child } = childState
    return new Promise((resolvePromise, rejectPromise) => {
      let settled = false
      let timer
      const finish = (callback, value) => {
        if (settled) return
        settled = true
        cleanup()
        callback(value)
      }
      const onMessage = message => {
        if (message?.type !== GATEWAY_READY_MESSAGE || !message.origin) return
        try {
          finish(resolvePromise, validateAppUrl(message.origin))
        } catch (error) {
          finish(rejectPromise, error)
        }
      }
      const onExit = code => {
        finish(
          rejectPromise,
          new Error(`内嵌 Gateway 提前退出（${code ?? 'unknown'}）`),
        )
      }
      const cancel = () => {
        finish(rejectPromise, new Error('内嵌 Gateway 启动已取消'))
      }
      timer = setTimeout(() => {
        finish(rejectPromise, new Error('内嵌 Gateway 启动超时'))
      }, this.startupTimeoutMs)
      const cleanup = () => {
        clearTimeout(timer)
        child.off('message', onMessage)
        child.off('exit', onExit)
        if (operation.cancel === cancel) operation.cancel = null
      }
      operation.cancel = cancel
      child.on('message', onMessage)
      child.once('exit', onExit)
      if (operation.cancelled || this.startOperation !== operation) cancel()
    })
  }

  async restart(options = {}) {
    await this.stop()
    return this.start(options)
  }

  stop() {
    const operation = this.startOperation
    if (operation) {
      operation.cancelled = true
      operation.cancel?.()
    }
    if (this.startOperation === operation) this.startOperation = null
    this.startPromise = null

    const childState = this.childState || operation?.childState || null
    if (childState) childState.planned = true
    this.child = null
    this.childState = null
    this.origin = null
    if (this.stopPromise) return this.stopPromise
    if (!childState || childState.exited) return Promise.resolve()

    const stopPromise = new Promise(resolvePromise => {
      const timer = setTimeout(() => {
        childState.child.kill()
        resolvePromise()
      }, this.stopTimeoutMs)
      childState.child.once('exit', () => {
        clearTimeout(timer)
        resolvePromise()
      })
      if (!childState.killIssued) {
        childState.killIssued = true
        childState.child.kill()
      }
    }).finally(() => {
      if (this.stopPromise === stopPromise) this.stopPromise = null
    })
    this.stopPromise = stopPromise
    return stopPromise
  }
}
