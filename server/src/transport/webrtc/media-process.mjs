import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { rtcError } from './config.mjs'

const WORKER = new URL('./media-worker.mjs', import.meta.url)
const MAX_IPC_BYTES = 8 * 1024 * 1024

// A native crash must never take down the Gateway or its WSS clients. One
// disposable Node process owns one peer, and receives no provider credentials.
export class ProcessWebRtcMedia {
  constructor({ iceServers = [], iceTransportPolicy = 'all', video = false, inputSampleRate = 16000,
    forkProcess = fork, shutdownTimeoutMs = 2000, onDiagnostic = () => {} } = {}) {
    this.closed = false
    this.exited = false
    this.opened = false
    this.online = false
    this.acknowledged = false
    this.forced = false
    this.pendingBytes = 0
    this.sequence = 0
    this.pending = new Map()
    this.shutdownTimeoutMs = shutdownTimeoutMs
    this.onDiagnostic = onDiagnostic
    this._inputSampleRate = inputSampleRate
    this.initialized = new Promise((resolve, reject) => { this.resolveInit = resolve; this.rejectInit = reject })
    this.initialized.catch(() => {})
    this.finished = new Promise(resolve => { this.resolveExit = resolve })
    const env = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'LANG']
      .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]))
    // Also works when an Electron host uses its own executable to fork Node.
    env.ELECTRON_RUN_AS_NODE = '1'
    try {
      this.child = forkProcess(WORKER, [], {
        cwd: fileURLToPath(new URL('.', WORKER)), env, execArgv: [],
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'advanced',
      })
    } catch {
      throw rtcError(503, 'media_worker_start_failed', 'Could not start WebRTC media process')
    }
    this.child.on('message', message => this.receive(message))
    this.child.on('error', () => this.fail(rtcError(503, 'media_worker_error', 'WebRTC media process failed')))
    this.child.once('close', (code, signal) => this.finishExit(code, signal))
    this.startupTimer = setTimeout(() => this.fail(rtcError(504, 'media_worker_timeout', 'WebRTC media process startup timed out')), 10000)
    this.post({ type: 'init', options: { iceServers, iceTransportPolicy, video, inputSampleRate } })
  }

  get inputSampleRate() { return this._inputSampleRate }
  set inputSampleRate(value) {
    this._inputSampleRate = value
    this.post({ type: 'rate', value })
  }

  post(message, closing = false) {
    if (this.exited || (this.closed && !closing)) return false
    if (!this.child.connected) {
      if (!closing) this.fail(rtcError(503, 'media_worker_disconnected', 'WebRTC media process disconnected'))
      return false
    }
    const bytes = Buffer.byteLength(JSON.stringify(message))
    if (!closing && this.pendingBytes + bytes > MAX_IPC_BYTES) {
      this.fail(rtcError(503, 'media_worker_backpressure', 'WebRTC media process is not consuming data'))
      return false
    }
    this.pendingBytes += bytes
    try {
      this.child.send(message, error => {
        this.pendingBytes -= bytes
        if (error && !closing) this.fail(rtcError(503, 'media_worker_send_failed', 'WebRTC media process send failed'))
      })
      return true
    } catch {
      this.pendingBytes -= bytes
      if (!closing) this.fail(rtcError(503, 'media_worker_send_failed', 'WebRTC media process send failed'))
      return false
    }
  }

  receive(message) {
    if (message?.type === 'closed') { this.acknowledged = true; return }
    if (this.closed || !message) return
    if (message.type === 'ready') {
      clearTimeout(this.startupTimer)
      this.resolveInit()
    } else if (message.type === 'answer' || message.type === 'answer.error') {
      const request = this.pending.get(message.id)
      if (!request) return
      this.pending.delete(message.id)
      clearTimeout(request.timer)
      if (message.type === 'answer') request.resolve(message.sdp)
      else request.reject(rtcError(message.error.status, message.error.code, message.error.message))
    } else if (message.type === 'failure') {
      const error = message.error || {}
      this.fail(rtcError(error.status || 503, error.code || 'media_worker_failed', error.message || 'WebRTC media process failed'))
    } else if (message.type === 'open') {
      this.online = true
      if (!this.opened) { this.opened = true; this.onOpen?.() }
    } else if (message.type === 'state') {
      this.online = message.connected === true
    } else if (message.type === 'event') this.onEvent?.(message.data)
    else if (message.type === 'audio') this.onAudio?.(message.data)
    else if (message.type === 'image') this.onImage?.(message.data)
    else if (message.type === 'peer.closed') this.fail(rtcError(503, 'media_peer_closed', 'WebRTC peer closed'))
  }

  async answer(sdp) {
    await this.initialized
    if (this.closed) throw this.failure || rtcError(503, 'media_worker_closed', 'WebRTC media process closed')
    return new Promise((resolve, reject) => {
      const id = ++this.sequence
      const timer = setTimeout(() => this.fail(rtcError(504, 'media_answer_timeout', 'WebRTC negotiation timed out')), 15000)
      this.pending.set(id, { resolve, reject, timer })
      this.post({ type: 'answer', id, sdp })
    })
  }

  send(event) { this.post({ type: 'send', event }) }
  begin(responseId) { this.post({ type: 'begin', responseId }) }
  append(event) { this.post({ type: 'append', event }) }
  finish(responseId) { this.post({ type: 'finish', responseId }) }
  clear() { this.post({ type: 'clear' }) }
  connected() { return !this.closed && this.online }
  whenClosed() { return this.finished }

  rejectPending(error) {
    this.rejectInit(error)
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error) }
    this.pending.clear()
  }

  fail(error) {
    if (this.closed) return
    this.failure = error
    this.rejectPending(error)
    try { this.onClose?.() } finally { this.close() }
  }

  close() {
    if (this.closed) return this.finished
    this.closed = true
    this.online = false
    clearTimeout(this.startupTimer)
    this.rejectPending(this.failure || rtcError(503, 'media_worker_closed', 'WebRTC media process closed'))
    if (!this.exited) {
      this.shutdownTimer = setTimeout(() => {
        this.forced = true
        this.child.kill('SIGKILL')
      }, this.shutdownTimeoutMs)
      this.post({ type: 'close' }, true)
    }
    return this.finished
  }

  finishExit(code, signal) {
    if (this.exited) return
    this.exited = true
    clearTimeout(this.startupTimer)
    clearTimeout(this.shutdownTimer)
    const graceful = this.closed && this.acknowledged && code === 0 && !signal && !this.forced
    if (!this.closed) this.fail(rtcError(503, 'media_worker_exited', 'WebRTC media process exited unexpectedly'))
    const result = { code, signal, graceful, acknowledged: this.acknowledged, forced: this.forced }
    if (!graceful) this.onDiagnostic({ ...result, errorCode: this.failure?.code || 'media_worker_shutdown_failed' })
    this.resolveExit(result)
  }
}
