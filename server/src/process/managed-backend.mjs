import { spawn } from 'node:child_process'
import { createConnection, createServer } from 'node:net'
import { resolve } from 'node:path'
import {
  backendRuntimeDriver,
  normalizeBackendRuntimeProtocol,
} from './backend-drivers/registry.mjs'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

function permissionMode(env) {
  const mode = String(
    env.QWEN_AUDIO_AGENT_BACKEND_PERMISSION_MODE || 'native',
  ).toLowerCase()
  if (!['native', 'full'].includes(mode)) {
    throw new Error(`不支持的后台权限模式：${mode}（可选 native、full）`)
  }
  return mode
}

export function resolveManagedBackend(env = process.env) {
  const protocol = normalizeBackendRuntimeProtocol(env.AGENT_PROTOCOL)
  if (!protocol) return null
  const driver = backendRuntimeDriver(protocol)
  const resolvedPermissionMode = permissionMode(env)
  const ownership = driver.resolveOwnership?.({ env }) || 'owned'
  if (resolvedPermissionMode === 'full' && ownership !== 'owned') {
    throw new Error('最高权限模式只支持由 Gateway 启动的后台 Agent')
  }
  return driver.resolve({
    env,
    ownership,
    permissionMode: resolvedPermissionMode,
  })
}

export function applyBackendPermissionMode(env, backend) {
  if (backend.permissionMode !== 'full') return env
  if (backend.ownership !== 'owned') {
    throw new Error('最高权限模式只支持由 Gateway 启动的后台 Agent')
  }
  return backendRuntimeDriver(backend.protocol)
    .applyPermissionMode?.(env, backend)
    || env
}

export function isLocalBackend(baseUrl) {
  return LOOPBACK_HOSTS.has(new URL(baseUrl).hostname)
}

export function backendAddressInUse(baseUrl, timeoutMs = 300) {
  const target = new URL(baseUrl)
  const port = Number(target.port || (target.protocol === 'https:' ? 443 : 80))
  return new Promise(resolvePromise => {
    const socket = createConnection({ host: target.hostname, port })
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

export function allocateBackendAddress(baseUrl) {
  const target = new URL(baseUrl)
  const host = target.hostname === 'localhost' ? '127.0.0.1' : target.hostname
  return new Promise((resolvePromise, rejectPromise) => {
    const server = createServer()
    server.unref()
    server.once('error', rejectPromise)
    server.listen(0, host, () => {
      const address = server.address()
      server.close(error => {
        if (error) return rejectPromise(error)
        target.hostname = host
        target.port = String(address.port)
        resolvePromise(target.origin)
      })
    })
  })
}

function applyBackendAddress(env, backend) {
  backendRuntimeDriver(backend.protocol).applyAddress?.(env, backend)
}

function spawnSpec(root, platform, env, driver) {
  const childEnvironment = {
    ...env,
    QWEN_AUDIO_AGENT_ENV_LOADED: '1',
    QWEN_AUDIO_AGENT_NODE: process.execPath,
    ELECTRON_RUN_AS_NODE: '1',
  }
  return {
    command: process.execPath,
    args: [resolve(root, `scripts/${driver.managedScript}`)],
    options: {
      cwd: root,
      env: childEnvironment,
      detached: platform !== 'win32',
      stdio: 'inherit',
    },
  }
}

export class ManagedBackendRuntime {
  constructor(child = null, {
    platform = process.platform,
    killImpl = process.kill,
  } = {}) {
    this.child = child
    this.platform = platform
    this.killImpl = killImpl
  }

  get ownsProcess() {
    return Boolean(this.child)
  }

  close(signal = 'SIGTERM') {
    const child = this.child
    if (!child || child.exitCode != null || child.signalCode != null) return
    if (this.platform !== 'win32' && Number.isInteger(child.pid)) {
      try {
        this.killImpl(-child.pid, signal)
        return
      } catch {
        // The group may have exited between the status check and signal.
      }
    }
    child.kill(signal)
  }

  async stop(signal = 'SIGTERM', timeoutMs = 1500) {
    const child = this.child
    if (!child || child.exitCode != null || child.signalCode != null) return
    this.close(signal)
    await new Promise(resolvePromise => {
      let finished = false
      const finish = () => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        child.off?.('exit', finish)
        resolvePromise()
      }
      const timer = setTimeout(() => {
        this.close('SIGKILL')
        finish()
      }, timeoutMs)
      child.once?.('exit', finish)
    })
  }
}

export async function startManagedBackend({
  root,
  env = process.env,
  platform = process.platform,
  spawnImpl = spawn,
  isAddressInUse = backendAddressInUse,
  findFreeAddress = allocateBackendAddress,
  logger,
} = {}) {
  const backend = resolveManagedBackend(env)
  if (!backend) return new ManagedBackendRuntime(null, { platform })
  const driver = backendRuntimeDriver(backend.protocol)
  applyBackendPermissionMode(env, backend)
  if (!driver.separateManagedProcess) {
    return new ManagedBackendRuntime(null, { platform })
  }
  if (backend.ownership === 'external') {
    return new ManagedBackendRuntime(null, { platform })
  }
  if (backend.ownership !== 'owned') {
    throw new Error(`不支持的后台进程归属：${backend.ownership}`)
  }
  if (!isLocalBackend(backend.baseUrl)) {
    throw new Error(`Gateway 只能启动本机后台 Agent：${backend.baseUrl}`)
  }
  if (await isAddressInUse(backend.baseUrl)) {
    logger?.info('backend.address_reallocated', {
      backend: backend.protocol,
      requestedBaseUrl: backend.baseUrl,
    })
    backend.baseUrl = await findFreeAddress(backend.baseUrl)
  }
  applyBackendAddress(env, backend)
  const spec = spawnSpec(root, platform, env, driver)
  const child = spawnImpl(spec.command, spec.args, spec.options)
  logger?.info('backend.process_started', {
    backend: backend.protocol,
    pid: child.pid,
    baseUrl: backend.baseUrl,
    ownership: backend.ownership,
  })
  child.once?.('error', error => {
    logger?.error('backend.process_start_failed', {
      backend: backend.protocol,
      error,
    })
  })
  return new ManagedBackendRuntime(child, { platform })
}
