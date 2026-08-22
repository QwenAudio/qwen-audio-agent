import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  NativeInputFrameDecoder,
  encodeNativeInputFrame,
} from './native-input-protocol.mjs'

const SAFE_ENVIRONMENT_KEYS = Object.freeze([
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'PATH',
  'TMPDIR',
])

const HOST_REQUEST_TYPES = new Set([
  'session.arm',
  'session.partial',
  'session.final',
  'session.cancel',
  'session.pause',
  'session.resume',
  'lifecycle.status',
  'lifecycle.install',
  'lifecycle.repair',
  'lifecycle.uninstall',
  'bridge.stop',
])

export function nativeInputBridgePath({
  isPackaged = false,
  resourcesPath = process.resourcesPath,
} = {}) {
  if (isPackaged) {
    return resolve(resourcesPath, 'native-input', 'QwenInputBridge')
  }
  return resolve(
    fileURLToPath(new URL('../..', import.meta.url)),
    'dist/native-input/QwenInputBridge',
  )
}

export function nativeInputChildEnvironment(environment = process.env) {
  const result = {}
  for (const key of SAFE_ENVIRONMENT_KEYS) {
    const value = environment[key]
    if (typeof value === 'string' && value) result[key] = value
  }
  return result
}

export class NativeInputHost extends EventEmitter {
  constructor({
    resolveArtifact = () => nativeInputBridgePath(),
    spawnImpl = spawn,
    environment = process.env,
    startupTimeoutMs = 5_000,
    stopTimeoutMs = 1_000,
    requestTimeoutMs = 5_000,
    onEmergencyStop = () => {},
  } = {}) {
    super()
    this.resolveArtifact = resolveArtifact
    this.spawnImpl = spawnImpl
    this.environment = environment
    this.startupTimeoutMs = startupTimeoutMs
    this.stopTimeoutMs = stopTimeoutMs
    this.requestTimeoutMs = requestTimeoutMs
    this.onEmergencyStop = onEmergencyStop
    this.state = 'idle'
    this.child = null
    this.decoder = null
    this.startPromise = null
    this.resolveStart = null
    this.rejectStart = null
    this.startupTimer = null
    this.exitPromise = null
    this.resolveExit = null
    this.childListeners = null
    this.pendingRequests = new Map()
  }

  start() {
    if (this.state === 'ready') return Promise.resolve({ state: 'ready' })
    if (this.state === 'starting') return this.startPromise
    if (this.state !== 'idle') {
      return Promise.reject(new Error(
        `Native input Bridge cannot start from ${this.state}`,
      ))
    }

    const executable = this.resolveArtifact()
    if (!isAbsolute(executable)) {
      return Promise.reject(new Error('Native input Bridge path must be absolute'))
    }

    this.state = 'starting'
    this.decoder = new NativeInputFrameDecoder()
    this.startPromise = new Promise((resolveStart, rejectStart) => {
      this.resolveStart = resolveStart
      this.rejectStart = rejectStart
    })

    let child
    try {
      child = this.spawnImpl(executable, [], {
        detached: false,
        env: nativeInputChildEnvironment(this.environment),
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      this.fail('spawn_failed', error, { terminate: false })
      return this.startPromise
    }
    if (!child?.stdin || !child?.stdout || typeof child.kill !== 'function') {
      this.fail(
        'spawn_failed',
        new Error('Native input Bridge did not expose owned pipes'),
        { child, terminate: true },
      )
      return this.startPromise
    }

    this.child = child
    this.exitPromise = new Promise(resolveExit => {
      this.resolveExit = resolveExit
    })
    const onData = chunk => this.handleOutput(child, chunk)
    const onExit = (code, signal) => this.handleExit(child, code, signal)
    const onProcessError = error => this.fail('child_error', error, { child })
    child.stdout.on('data', onData)
    child.once('exit', onExit)
    child.once('error', onProcessError)
    this.childListeners = { child, onData, onExit, onProcessError }

    this.startupTimer = setTimeout(() => {
      this.fail(
        'startup_timeout',
        new Error('Native input Bridge startup timed out'),
        { child },
      )
    }, this.startupTimeoutMs)
    return this.startPromise
  }

  send(message) {
    if (this.state !== 'ready' || !this.child?.stdin?.writable) {
      throw new Error('Native input Bridge is not ready')
    }
    if (!HOST_REQUEST_TYPES.has(message?.type) || message.type === 'bridge.stop') {
      throw new Error('Native input message is not an allowed host operation')
    }
    this.child.stdin.write(encodeNativeInputFrame(message))
  }

  request(message) {
    if (this.state !== 'ready' || !this.child?.stdin?.writable) {
      return Promise.reject(new Error('Native input Bridge is not ready'))
    }
    const lifecycle = message?.type?.startsWith('lifecycle.')
    const requestId = String(
      lifecycle
        ? message?.requestId || randomUUID()
        : message?.operationId || randomUUID(),
    )
    if (!lifecycle && !message?.type?.startsWith('session.')) {
      return Promise.reject(new Error('Native input request type is not allowed'))
    }
    if (this.pendingRequests.has(requestId)) {
      return Promise.reject(new Error('Native input requestId is already pending'))
    }
    const request = lifecycle
      ? { ...message, requestId }
      : { ...message, operationId: requestId }
    const promise = new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId)
        rejectRequest(new Error('Native input Bridge request timed out'))
      }, this.requestTimeoutMs)
      this.pendingRequests.set(requestId, {
        resolve: resolveRequest,
        reject: rejectRequest,
        timer,
      })
    })
    try {
      this.child.stdin.write(encodeNativeInputFrame(request))
    } catch (error) {
      this.rejectRequest(requestId, error)
    }
    return promise
  }

  async stop(reason = 'requested') {
    const child = this.child
    if (!child) {
      this.clearStartup()
      this.state = 'idle'
      return { state: 'idle' }
    }

    this.state = 'stopping'
    this.rejectAllRequests(new Error('Native input Bridge stopped'))
    this.clearStartup(new Error('Native input Bridge stopped before ready'))
    try {
      if (child.stdin?.writable) {
        child.stdin.write(encodeNativeInputFrame({
          type: 'bridge.stop',
          reason,
        }))
      }
    } catch {
      // A broken control pipe is equivalent to an already-stopping Bridge.
    }

    const exited = await waitForExit(this.exitPromise, this.stopTimeoutMs)
    if (!exited && this.child === child) child.kill('SIGTERM')
    this.detach(child)
    if (this.child === child) this.child = null
    this.state = 'idle'
    return { state: 'idle' }
  }

  emergencyStop(reason = 'emergency') {
    if (this.state === 'error') return false
    const child = this.child
    this.state = 'error'
    this.clearStartup(new Error(`Native input stopped: ${reason}`))
    this.onEmergencyStop(reason)
    this.rejectAllRequests(new Error(`Native input stopped: ${reason}`))
    if (child) {
      this.requestOwnedStop(child, reason)
    }
    return true
  }

  handleOutput(child, chunk) {
    if (child !== this.child || this.state === 'error') return
    let messages
    try {
      messages = this.decoder.push(chunk)
    } catch (error) {
      this.fail('malformed_output', error, { child })
      return
    }

    for (const message of messages) {
      if (this.state === 'starting') {
        if (message.type !== 'bridge.ready' || message.state !== 'ready') {
          this.fail(
            'malformed_output',
            new Error('Native input Bridge did not send bridge.ready first'),
            { child },
          )
          return
        }
        this.state = 'ready'
        this.clearStartup()
        this.resolveStart?.({ state: 'ready' })
        this.resolveStart = null
        this.rejectStart = null
        continue
      }
      if (message.type === 'bridge.error') {
        this.fail(
          'bridge_error',
          new Error(message.reason || 'Native input Bridge error'),
          { child },
        )
        return
      }
      if (
        message.type === 'lifecycle.result'
        || message.type === 'operation.result'
      ) {
        const correlation = message.type === 'lifecycle.result'
          ? message.requestId
          : message.operationId
        const pending = this.pendingRequests.get(correlation)
        if (!pending) continue
        clearTimeout(pending.timer)
        this.pendingRequests.delete(correlation)
        pending.resolve(message)
        continue
      }
      this.emit('message', message)
    }
  }

  handleExit(child, code, signal) {
    if (child !== this.child) return
    this.resolveExit?.({ code, signal })
    this.resolveExit = null
    this.exitPromise = null
    this.detach(child)
    this.child = null
    if (this.state === 'stopping') return
    this.fail(
      'child_exit',
      new Error(`Native input Bridge exited (${code ?? signal ?? 'unknown'})`),
      { terminate: false },
    )
  }

  fail(reason, error, { child = this.child, terminate = true } = {}) {
    if (this.state === 'error') return
    this.state = 'error'
    this.clearStartup(error)
    this.onEmergencyStop(reason)
    this.rejectAllRequests(error)
    if (child && terminate) {
      this.requestOwnedStop(child, reason)
    }
    this.emit('failed', { reason, error })
  }

  clearStartup(error = null) {
    if (this.startupTimer) clearTimeout(this.startupTimer)
    this.startupTimer = null
    if (error) {
      this.rejectStart?.(error)
      this.resolveStart = null
      this.rejectStart = null
    }
  }

  detach(child) {
    const listeners = this.childListeners
    if (!listeners || listeners.child !== child) return
    child.stdout.off('data', listeners.onData)
    child.off('exit', listeners.onExit)
    child.off('error', listeners.onProcessError)
    this.childListeners = null
  }

  rejectRequest(requestId, error) {
    const pending = this.pendingRequests.get(requestId)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pendingRequests.delete(requestId)
    pending.reject(error)
  }

  rejectAllRequests(error) {
    for (const requestId of [...this.pendingRequests.keys()]) {
      this.rejectRequest(requestId, error)
    }
  }

  requestOwnedStop(child, reason) {
    try {
      if (child.stdin?.writable) {
        child.stdin.write(encodeNativeInputFrame({
          type: 'bridge.stop',
          reason,
        }))
      }
    } catch {
      // The bounded signal below handles a broken control pipe.
    }
    const timer = setTimeout(() => child.kill('SIGTERM'), this.stopTimeoutMs)
    timer.unref?.()
  }
}

function waitForExit(exitPromise, milliseconds) {
  return new Promise(resolveWait => {
    const timer = setTimeout(() => resolveWait(false), milliseconds)
    exitPromise.then(() => {
      clearTimeout(timer)
      resolveWait(true)
    })
  })
}
