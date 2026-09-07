// The hosted Gateway process manager: forking, port probing, the readiness
// handshake, restart, and telling a planned exit from a crash. Our own
// desktop app runs exactly this implementation, which is what keeps a host's
// behaviour from drifting away from ours.
//
// The module stays runnable outside Electron: the fork implementation is
// imported lazily (Electron's utilityProcess by default) and injectable, so
// a plain Node host passes child_process.fork.
import { createConnection } from 'node:net'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gatewayOptionsEnvironment } from './options.mjs'

const here = dirname(fileURLToPath(import.meta.url))

export const DEFAULT_GATEWAY_ENTRY = resolve(here, '../../server/src/index.mjs')
export const GATEWAY_READY_MESSAGE = 'qwen-audio-agent:gateway-ready'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

// The origin a child reported, checked before anything is pointed at it. A
// child that reports something else is not trusted merely because it is ours.
export function validateGatewayOrigin(value) {
  const url = new URL(value)
  const localHttp = url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)
  if (url.protocol !== 'https:' && !localHttp) {
    throw new Error('Gateway origin must use HTTPS, or HTTP on localhost.')
  }
  return url.origin
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

export class GatewayProcess {
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
    logger = null,
    // Host-facing options, translated once into child environment entries so
    // `backend: 'none'` or `wakeWord: false` cannot drift between launch
    // shapes. Unset options leave the environment's decision in place.
    configDir,
    backend,
    wakeWord,
    owner,
    logConsole,
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
    this.logger = logger
    this.hostEnvironment = gatewayOptionsEnvironment({
      configDir,
      backend,
      wakeWord,
      owner,
      logConsole,
    })
    this.child = null
    this.childState = null
    this.origin = null
    this.startOperation = null
    this.startPromise = null
    this.stopPromise = null
    this.onUnexpectedExit = null
    this.onGatewayMessage = null
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
    // 首选端口可能被另一套独立数据目录的产品实例（如 CLI 或另一份
    // 桌面版）或外部程序占用；回退随机端口让它们并行运行。若因此与
    // 同目录实例产生租约竞争，启动失败后由调用方经 findRunningGateway
    // 兜底复用。
    const port = busy ? 0 : preferredPort
    if (busy) {
      this.logger?.warn('gateway.port_busy_fallback', {
        preferredPort,
        selectedPort: 'random',
      })
    }
    this.logger?.info('gateway.starting', {
      preferredPort,
      selectedPort: busy ? 'random' : port,
      portReallocated: busy,
    })
    // Imported lazily so this module also loads outside Electron (tests and
    // plain Node hosts).
    const fork = this.forkImpl || (await import('electron')).utilityProcess.fork
    this.assertActiveStart(operation)
    // The environment is rebuilt on every start, so a restart after a
    // configuration change serves the new values instead of replaying the
    // first launch.
    const environment = this.envFactory ? this.envFactory() : this.env
    const child = fork(this.entry, [], {
      env: {
        ...environment,
        ...this.hostEnvironment,
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
    // Persistent message handler: survives after waitUntilReady's
    // temporary handler is removed. Used for offline notifications
    // and other runtime IPC from the gateway child process.
    child.on('message', message => {
      if (message?.type === GATEWAY_READY_MESSAGE) return
      this.onGatewayMessage?.(message)
    })
    child.once('exit', (code, signal) => {
      this.logger?.[childState.planned ? 'info' : 'error']('gateway.exited', {
        code,
        signal,
        planned: childState.planned,
      })
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
      this.logger?.info('gateway.ready', { origin })
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
          finish(resolvePromise, validateGatewayOrigin(message.origin))
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
    this.logger?.info('gateway.stopping')

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

export function createGatewayProcess(options = {}) {
  return new GatewayProcess(options)
}
