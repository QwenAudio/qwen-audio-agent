import { fork as nodeFork } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { StringDecoder } from 'node:string_decoder'
import { redactDesktopHostValue } from '../../shared/desktop-host-protocol.mjs'

export const GATEWAY_READY_MESSAGE = 'qwen-audio-agent:gateway-ready'

const DEFAULT_RESTART_DELAYS_MS = Object.freeze([1_000, 2_000, 4_000])
const MAX_LOG_LINES = 500
const MAX_LOG_LINE_CHARACTERS = 8_192

function validateGatewayOrigin(value) {
  let url
  try {
    url = new URL(value)
  } catch (error) {
    throw new Error('Gateway ready origin is not a valid URL', {
      cause: error,
    })
  }
  if (url.protocol !== 'http:') {
    throw new Error('Gateway ready origin must use HTTP')
  }
  if (!['127.0.0.1', 'localhost'].includes(url.hostname)) {
    throw new Error('Gateway ready origin must use a loopback host')
  }
  const port = Number(url.port)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('Gateway ready origin must include a valid port')
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Gateway ready origin must contain only its loopback origin')
  }
  return url.origin
}

function defaultKillProcessGroup(pid, signal) {
  process.kill(pid, signal)
}

function errorMessage(error) {
  return String(redactDesktopHostValue(error?.message || error || 'Unknown error'))
}

export class DesktopHostGateway extends EventEmitter {
  constructor({
    entryPath,
    environment = process.env,
    environmentFactory = null,
    forkImpl = nodeFork,
    killImpl = defaultKillProcessGroup,
    timers = { setTimeout, clearTimeout },
    startupTimeoutMs = 15_000,
    stopTimeoutMs = 5_000,
    restartDelaysMs = DEFAULT_RESTART_DELAYS_MS,
  } = {}) {
    super()
    if (!entryPath) throw new Error('DesktopHostGateway requires entryPath')
    this.entryPath = entryPath
    this.environment = environment
    this.environmentFactory = environmentFactory
    this.forkImpl = forkImpl
    this.killImpl = killImpl
    this.timers = timers
    this.startupTimeoutMs = startupTimeoutMs
    this.stopTimeoutMs = stopTimeoutMs
    this.restartDelaysMs = [...restartDelaysMs]
    this.child = null
    this.childState = null
    this.origin = null
    this.status = {
      state: 'stopping',
      origin: null,
      retry: 0,
      delayMs: null,
      reason: null,
    }
    this.logs = []
    this.startPromise = null
    this.stopPromise = null
    this.recoveryTimer = null
    this.recoveryAttempt = 0
    this.stopping = false
  }

  get running() {
    return Boolean(this.childState?.ready && this.origin)
  }

  start() {
    if (this.running) return Promise.resolve(this.origin)
    if (this.startPromise) return this.startPromise
    this.stopping = false
    this.recoveryAttempt = 0
    this.#clearRecoveryTimer()
    const pendingStop = this.stopPromise
    const startPromise = (async () => {
      if (pendingStop) await pendingStop
      if (this.stopping) throw new Error('Gateway start was cancelled')
      this.#setStatus('starting', { retry: 0 })
      try {
        return await this.#spawnAndWaitUntilReady({ retry: 0 })
      } catch (error) {
        if (!this.stopping) {
          this.#setStatus('error', {
            retry: 0,
            reason: errorMessage(error),
          })
        }
        throw error
      }
    })().finally(() => {
      if (this.startPromise === startPromise) this.startPromise = null
    })
    this.startPromise = startPromise
    return startPromise
  }

  async restart() {
    await this.stop()
    this.stopping = false
    return this.start()
  }

  stop() {
    if (this.stopPromise) return this.stopPromise
    this.stopping = true
    this.#clearRecoveryTimer()
    this.#setStatus('stopping', { retry: this.recoveryAttempt })
    const childState = this.childState
    if (childState) {
      childState.planned = true
      childState.cancelReady?.()
    }
    this.child = null
    this.childState = null
    this.origin = null

    const stopPromise = (async () => {
      if (childState && !childState.exited) {
        await this.#stopChildGracefully(childState)
      }
      await this.startPromise?.catch(() => {})
    })().finally(() => {
      if (this.stopPromise === stopPromise) this.stopPromise = null
    })
    this.stopPromise = stopPromise
    return stopPromise
  }

  tailLogs({ limit = 100 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LOG_LINES) {
      throw new RangeError('Log limit must be between 1 and 500')
    }
    return this.logs.slice(-limit).map(entry => ({ ...entry }))
  }

  async #spawnAndWaitUntilReady({ retry }) {
    const environment = this.environmentFactory
      ? this.environmentFactory()
      : this.environment
    const child = this.forkImpl(this.entryPath, [], {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: {
        ...environment,
        HOST: '127.0.0.1',
        PORT: '0',
      },
    })
    const childState = {
      child,
      exited: false,
      killIssued: false,
      planned: false,
      ready: false,
      cancelReady: null,
    }
    this.child = child
    this.childState = childState
    this.#captureLogStream(child.stdout, 'stdout')
    this.#captureLogStream(child.stderr, 'stderr')
    child.once('exit', (code, signal) => {
      this.#handleChildExit(childState, code, signal)
    })

    try {
      const origin = await this.#waitUntilReady(childState)
      if (
        this.stopping
        || childState.exited
        || this.childState !== childState
      ) {
        throw new Error('Gateway start was cancelled')
      }
      childState.ready = true
      this.origin = origin
      this.#setStatus('ready', { origin, retry })
      return origin
    } catch (error) {
      childState.planned = true
      if (this.childState === childState) {
        this.child = null
        this.childState = null
        this.origin = null
      }
      this.#killOwnedProcessGroup(childState, 'SIGTERM')
      throw error
    }
  }

  #waitUntilReady(childState) {
    const { child } = childState
    return new Promise((resolvePromise, rejectPromise) => {
      let settled = false
      const finish = (callback, value) => {
        if (settled) return
        settled = true
        this.timers.clearTimeout(timer)
        child.off('message', onMessage)
        child.off('exit', onExit)
        if (childState.cancelReady === cancel) childState.cancelReady = null
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
      const onExit = (code, signal) => {
        const reason = signal || code || 'unknown'
        finish(
          rejectPromise,
          new Error(`Gateway exited before ready (${reason})`),
        )
      }
      const cancel = () => {
        finish(rejectPromise, new Error('Gateway start was cancelled'))
      }
      const timer = this.timers.setTimeout(() => {
        finish(rejectPromise, new Error('Gateway startup timed out'))
      }, this.startupTimeoutMs)
      childState.cancelReady = cancel
      child.on('message', onMessage)
      child.once('exit', onExit)
      if (this.stopping || childState.planned) cancel()
    })
  }

  #handleChildExit(childState, code, signal) {
    childState.exited = true
    if (this.childState === childState) {
      this.child = null
      this.childState = null
      this.origin = null
    }
    if (!childState.ready || childState.planned || this.stopping) return
    const reason = signal || code || 'unknown'
    this.#scheduleRecovery(`Gateway exited unexpectedly (${reason})`)
  }

  #scheduleRecovery(reason) {
    if (this.stopping || this.recoveryTimer) return
    if (this.recoveryAttempt >= this.restartDelaysMs.length) {
      this.#setStatus('error', {
        retry: this.recoveryAttempt,
        reason,
      })
      return
    }
    const retry = this.recoveryAttempt + 1
    const delayMs = this.restartDelaysMs[this.recoveryAttempt]
    this.recoveryAttempt = retry
    this.#setStatus('recovering', { retry, delayMs, reason })
    this.recoveryTimer = this.timers.setTimeout(() => {
      this.recoveryTimer = null
      if (this.stopping) return
      this.#setStatus('starting', { retry })
      this.#spawnAndWaitUntilReady({ retry }).catch(error => {
        if (!this.stopping) this.#scheduleRecovery(errorMessage(error))
      })
    }, delayMs)
  }

  async #stopChildGracefully(childState) {
    const { child } = childState
    if (child.connected !== false && typeof child.disconnect === 'function') {
      try {
        child.disconnect()
      } catch (error) {
        if (error?.code !== 'ERR_IPC_DISCONNECTED') throw error
      }
    }
    if (childState.exited) return
    await new Promise(resolvePromise => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        this.timers.clearTimeout(timer)
        child.off('exit', onExit)
        resolvePromise()
      }
      const onExit = () => finish()
      const timer = this.timers.setTimeout(() => {
        this.#killOwnedProcessGroup(childState, 'SIGTERM')
        finish()
      }, this.stopTimeoutMs)
      child.once('exit', onExit)
    })
  }

  #killOwnedProcessGroup(childState, signal) {
    if (childState.exited || childState.killIssued) return
    childState.killIssued = true
    const pid = Number(childState.child.pid)
    if (!Number.isSafeInteger(pid) || pid < 1) {
      throw new Error('Owned Gateway process has no valid process-group id')
    }
    try {
      this.killImpl(-pid, signal)
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error
      childState.exited = true
    }
  }

  #captureLogStream(stream, streamName) {
    if (!stream?.on) return
    const decoder = new StringDecoder('utf8')
    let buffered = ''
    const consume = text => {
      buffered += text
      let newlineIndex = buffered.indexOf('\n')
      while (newlineIndex >= 0) {
        const line = buffered.slice(0, newlineIndex).replace(/\r$/, '')
        buffered = buffered.slice(newlineIndex + 1)
        this.#appendLog(streamName, line)
        newlineIndex = buffered.indexOf('\n')
      }
      if (buffered.length > MAX_LOG_LINE_CHARACTERS) {
        this.#appendLog(
          streamName,
          `${buffered.slice(0, MAX_LOG_LINE_CHARACTERS)} [truncated]`,
        )
        buffered = ''
      }
    }
    stream.on('data', chunk => consume(decoder.write(chunk)))
    stream.once?.('end', () => {
      consume(decoder.end())
      if (buffered) this.#appendLog(streamName, buffered)
      buffered = ''
    })
  }

  #appendLog(stream, line) {
    if (!line) return
    this.logs.push({
      stream,
      message: String(redactDesktopHostValue(line)),
    })
    if (this.logs.length > MAX_LOG_LINES) {
      this.logs.splice(0, this.logs.length - MAX_LOG_LINES)
    }
  }

  #clearRecoveryTimer() {
    if (!this.recoveryTimer) return
    this.timers.clearTimeout(this.recoveryTimer)
    this.recoveryTimer = null
  }

  #setStatus(state, {
    origin = this.origin,
    retry = this.recoveryAttempt,
    delayMs = null,
    reason = null,
  } = {}) {
    this.status = {
      state,
      origin: origin || null,
      retry,
      delayMs,
      reason: reason ? errorMessage(reason) : null,
    }
    this.emit('status', { ...this.status })
  }
}
