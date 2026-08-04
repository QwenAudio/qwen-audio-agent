import { EventEmitter } from 'node:events'
import {
  createDesktopHostJsonLineDecoder,
  DesktopHostEventSchema,
  DesktopHostResponseSchema,
  encodeDesktopHostMessage,
  MAX_DESKTOP_HOST_LINE_BYTES,
  redactDesktopHostValue,
} from '../../shared/desktop-host-protocol.mjs'

const SESSION_TOKEN_PATTERN = /^[a-f\d]{64}$/i

export class DesktopHostClientError extends Error {
  constructor(code, message, options) {
    super(message, options)
    this.name = 'DesktopHostClientError'
    this.code = code
  }
}

export class DesktopHostRemoteError extends DesktopHostClientError {
  constructor(remoteError) {
    super(
      remoteError.code,
      String(redactDesktopHostValue(remoteError.message)),
    )
    this.name = 'DesktopHostRemoteError'
    if (remoteError.details !== undefined) {
      this.details = redactDesktopHostValue(remoteError.details)
    }
  }
}

function deferred() {
  let resolvePromise
  let rejectPromise
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  return { promise, resolve: resolvePromise, reject: rejectPromise }
}

function writeStream(stream, value) {
  return new Promise((resolvePromise, rejectPromise) => {
    stream.write(value, error => {
      if (error) rejectPromise(error)
      else resolvePromise()
    })
  })
}

function endStream(stream) {
  if (!stream || stream.destroyed || stream.writableEnded) return
  stream.end()
}

function safeExitDescription(code, signal) {
  if (signal) return `signal ${String(signal).slice(0, 32)}`
  return `code ${Number.isInteger(code) ? code : 'unknown'}`
}

export class DesktopHostClient extends EventEmitter {
  constructor({
    child,
    sessionToken = '',
    helloTimeoutMs = 15_000,
    requestTimeoutMs = 15_000,
    maxLineBytes = MAX_DESKTOP_HOST_LINE_BYTES,
    maxDiagnosticLines = 200,
    maxDiagnosticLineBytes = 4_096,
  } = {}) {
    super()
    if (!child?.stdin || !child?.stdout || !child?.stderr) {
      throw new TypeError('DesktopHostClient requires piped stdin, stdout, and stderr')
    }
    if (sessionToken && !SESSION_TOKEN_PATTERN.test(sessionToken)) {
      throw new Error('Desktop host session token must be 32 hexadecimal bytes')
    }
    if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1) {
      throw new RangeError('requestTimeoutMs must be a positive integer')
    }
    if (!Number.isSafeInteger(helloTimeoutMs) || helloTimeoutMs < 1) {
      throw new RangeError('helloTimeoutMs must be a positive integer')
    }
    if (!Number.isSafeInteger(maxDiagnosticLines) || maxDiagnosticLines < 1) {
      throw new RangeError('maxDiagnosticLines must be a positive integer')
    }
    if (
      !Number.isSafeInteger(maxDiagnosticLineBytes)
      || maxDiagnosticLineBytes < 1
    ) {
      throw new RangeError('maxDiagnosticLineBytes must be a positive integer')
    }

    this.child = child
    this.sessionToken = sessionToken
    this.requestTimeoutMs = requestTimeoutMs
    this.maxDiagnosticLines = maxDiagnosticLines
    this.maxDiagnosticLineBytes = maxDiagnosticLineBytes
    this.closed = false
    this.shuttingDown = false
    this.nextId = 1
    this.pending = new Map()
    this.completedIds = new Set()
    this.diagnostics = []
    this.stderrBuffer = ''
    this.helloData = null
    this.helloDeferred = deferred()
    this.exitDeferred = deferred()
    this.shutdownPromise = null
    // Consumers may choose to observe errors; an absent listener must not turn a
    // child protocol failure into an uncaught EventEmitter exception.
    this.on('error', () => {})

    this.decoder = createDesktopHostJsonLineDecoder({
      maxLineBytes,
      onMessage: message => this.#onMessage(message),
      onError: () => this.#failProtocol('Desktop host emitted invalid output'),
    })
    this.onStdoutData = chunk => {
      try {
        this.decoder.push(chunk)
      } catch {
        this.#failProtocol('Desktop host output decoder failed')
      }
    }
    this.onStdoutEnd = () => {
      try {
        this.decoder.end()
      } catch {
        this.#failProtocol('Desktop host output ended unexpectedly')
      }
    }
    this.onStderrData = chunk => this.#appendDiagnostics(chunk)
    this.onExit = (code, signal) => this.#handleExit(code, signal)
    this.onChildError = () => this.#close(new DesktopHostClientError(
      'host_spawn_error',
      'Desktop host process failed to start',
    ))

    child.stdout.on('data', this.onStdoutData)
    child.stdout.once('end', this.onStdoutEnd)
    child.stderr.on('data', this.onStderrData)
    child.once('exit', this.onExit)
    child.once('error', this.onChildError)

    this.helloTimer = setTimeout(() => {
      this.#terminate(new DesktopHostClientError(
        'hello_timeout',
        'Desktop host did not complete its handshake in time',
      ))
    }, helloTimeoutMs)
  }

  waitForHello() {
    return this.helloData
      ? Promise.resolve(this.helloData)
      : this.helloDeferred.promise
  }

  async request(method, params = {}, { timeoutMs = this.requestTimeoutMs } = {}) {
    if (this.closed) {
      throw new DesktopHostClientError('host_closed', 'Desktop host is closed')
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      throw new RangeError('timeoutMs must be a positive integer')
    }
    const id = String(this.nextId++)
    const line = encodeDesktopHostMessage({ id, method, params })
    const operation = deferred()
    const timer = setTimeout(() => {
      if (!this.pending.delete(id)) return
      this.#rememberCompletedId(id)
      operation.reject(new DesktopHostClientError(
        'request_timeout',
        `Desktop host request timed out: ${method}`,
      ))
    }, timeoutMs)
    this.pending.set(id, {
      method,
      timer,
      resolve: operation.resolve,
      reject: operation.reject,
    })
    try {
      await writeStream(this.child.stdin, line)
    } catch {
      clearTimeout(timer)
      this.pending.delete(id)
      const error = new DesktopHostClientError(
        'host_write_failed',
        'Could not write to the desktop host',
      )
      operation.reject(error)
      this.#terminate(error)
    }
    return operation.promise
  }

  shutdown({ timeoutMs = 3_000 } = {}) {
    if (this.shutdownPromise) return this.shutdownPromise
    if (this.closed) return Promise.resolve()
    this.shuttingDown = true
    this.shutdownPromise = (async () => {
      let timer
      try {
        await this.request('host.shutdown', {
          sessionToken: this.sessionToken,
        }, { timeoutMs })
        endStream(this.child.stdin)
        await Promise.race([
          this.exitDeferred.promise,
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new DesktopHostClientError(
              'shutdown_timeout',
              'Desktop host did not exit after shutdown',
            )), timeoutMs)
          }),
        ])
      } catch (error) {
        if (!this.closed) this.#terminate(error)
        throw error
      } finally {
        clearTimeout(timer)
      }
    })()
    return this.shutdownPromise
  }

  tailDiagnostics({ limit = this.maxDiagnosticLines } = {}) {
    const safeLimit = Number.isSafeInteger(limit) && limit > 0
      ? Math.min(limit, this.maxDiagnosticLines)
      : this.maxDiagnosticLines
    return this.diagnostics.slice(-safeLimit)
  }

  #onMessage(message) {
    if (this.closed) return
    const event = DesktopHostEventSchema.safeParse(message)
    if (event.success) {
      this.#onEvent(event.data)
      return
    }
    const response = DesktopHostResponseSchema.safeParse(message)
    if (!response.success) {
      this.#failProtocol('Desktop host emitted a message in the wrong direction')
      return
    }
    this.#onResponse(response.data)
  }

  #onEvent(message) {
    if (message.event === 'hello') {
      if (this.helloData) {
        this.#failProtocol('Desktop host emitted more than one hello event')
        return
      }
      this.helloData = message.data
      clearTimeout(this.helloTimer)
      this.helloDeferred.resolve(message.data)
    }
    this.emit('event', message)
    this.emit(message.event, message.data)
    if (message.event === 'gateway.status') this.emit('status', message.data)
  }

  #onResponse(message) {
    const operation = this.pending.get(message.id)
    if (!operation) {
      this.#terminate(new DesktopHostClientError(
        'unexpected_response_id',
        'Desktop host emitted an unknown or duplicate response id',
      ))
      return
    }
    this.pending.delete(message.id)
    this.#rememberCompletedId(message.id)
    clearTimeout(operation.timer)
    if (message.ok) operation.resolve(message.result)
    else operation.reject(new DesktopHostRemoteError(message.error))
  }

  #rememberCompletedId(id) {
    this.completedIds.add(id)
    if (this.completedIds.size > 1_024) {
      this.completedIds.delete(this.completedIds.values().next().value)
    }
  }

  #appendDiagnostics(chunk) {
    const text = this.stderrBuffer + Buffer.from(chunk).toString('utf8')
    const lines = text.split(/\r?\n/)
    this.stderrBuffer = lines.pop().slice(-this.maxDiagnosticLineBytes)
    for (const line of lines) {
      if (!line) continue
      const bytes = Buffer.from(line)
      const bounded = bytes.length > this.maxDiagnosticLineBytes
        ? bytes.subarray(0, this.maxDiagnosticLineBytes).toString('utf8')
        : line
      this.diagnostics.push(String(redactDesktopHostValue(bounded)))
    }
    if (this.diagnostics.length > this.maxDiagnosticLines) {
      this.diagnostics.splice(
        0,
        this.diagnostics.length - this.maxDiagnosticLines,
      )
    }
  }

  #failProtocol(message) {
    this.#terminate(new DesktopHostClientError('protocol_error', message))
  }

  #terminate(error) {
    if (this.closed) return
    this.#close(error)
    try {
      this.child.kill()
    } catch {
      // The close state is already final even when the OS process has exited.
    }
  }

  #handleExit(code, signal) {
    const error = new DesktopHostClientError(
      'host_exit',
      `Desktop host exited with ${safeExitDescription(code, signal)}`,
    )
    this.#close(error)
    this.exitDeferred.resolve({ code, signal })
  }

  #close(error) {
    if (this.closed) return
    this.closed = true
    clearTimeout(this.helloTimer)
    this.child.stdout.off('data', this.onStdoutData)
    this.child.stderr.off('data', this.onStderrData)
    this.child.off('error', this.onChildError)
    if (!this.helloData) this.helloDeferred.reject(error)
    for (const operation of this.pending.values()) {
      clearTimeout(operation.timer)
      operation.reject(error)
    }
    this.pending.clear()
    this.emit('error', error)
    this.emit('closed', error)
  }
}
