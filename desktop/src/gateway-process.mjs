import { createConnection } from 'node:net'
import { dirname, posix, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeBackendProtocol } from '../../shared/backend-catalog.mjs'
import {
  resolveRealtimeFrontendConfiguration,
} from '../../shared/realtime-provider-catalog.mjs'
import { validateAppUrl } from './security.mjs'

const here = dirname(fileURLToPath(import.meta.url))

export const DEFAULT_GATEWAY_ENTRY = resolve(here, '../../server/src/index.mjs')
export const GATEWAY_READY_MESSAGE = 'qwen-audio-agent:gateway-ready'

function uniquePath(entries, separator = ':') {
  return [...new Set(entries.filter(Boolean))].join(separator)
}

// Gateway 子进程的 PATH 直接继承主进程：主进程入口的 expandProcessPath
// 已把登录 shell 的 PATH（含磁盘缓存，零阻塞）合入 process.env，这里只
// 叠加常见安装目录兜底。不要再在这里同步调用登录 shell——主进程事件
// 循环会被阻塞数秒，直接拖慢桌面启动。
export function desktopExecutablePath({
  env = process.env,
  platform = process.platform,
} = {}) {
  const separator = platform === 'win32' ? ';' : ':'
  const configured = String(env.PATH || '').split(separator)
  if (platform !== 'darwin') return uniquePath(configured, separator)
  return uniquePath([
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

export function desktopGatewayCompatibility(health, env = process.env) {
  const expectedRealtime = resolveRealtimeFrontendConfiguration(env)
  if (
    health?.realtimeProvider !== expectedRealtime.provider
    || health?.realtimeConfigurationSignature !== expectedRealtime.signature
  ) {
    return {
      compatible: false,
      code: 'realtime',
      reason: '已有 Gateway 的语音前台配置与桌面设置不一致',
    }
  }
  const expectedProtocol = normalizeBackendProtocol(env.AGENT_PROTOCOL)
  const actualEnabled = health?.backend?.enabled !== false
  const actualProtocol = normalizeBackendProtocol(
    health?.backend?.kind || health?.backend?.protocol,
  )
  if (
    actualEnabled !== Boolean(expectedProtocol)
    || actualProtocol !== expectedProtocol
  ) {
    return {
      compatible: false,
      code: 'backend',
      reason: '已有 Gateway 的后台 Agent 与桌面设置不一致',
    }
  }
  if (expectedProtocol) {
    const expectedPermission = String(
      env.QWEN_AUDIO_AGENT_BACKEND_PERMISSION_MODE || 'native',
    ).toLowerCase()
    const actualPermission = String(
      health?.backend?.permissionMode || 'native',
    ).toLowerCase()
    if (expectedPermission !== actualPermission) {
      return {
        compatible: false,
        code: 'permission',
        reason: '已有 Gateway 的后台权限模式与桌面设置不一致',
      }
    }
    const expectedModel = String(
      env.QWEN_AUDIO_AGENT_BACKEND_MODEL || '',
    ).trim().toLowerCase()
    const actualModel = String(health?.backend?.model || '').trim().toLowerCase()
    if (expectedModel && expectedModel !== actualModel) {
      return {
        compatible: false,
        code: 'model',
        reason: '已有 Gateway 的后台模型与桌面设置不一致',
      }
    }
  }
  return { compatible: true, code: '', reason: '' }
}

export function assertDesktopGatewayCompatibility(health, env = process.env) {
  const result = desktopGatewayCompatibility(health, env)
  if (!result.compatible) {
    throw new Error(`${result.reason}，请先关闭现有 Gateway`)
  }
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
    logger = null,
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
    // 同目录实例产生租约竞争，启动失败后由 main 的 findRunningGateway
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
