import { createRealtimeFrontend } from './realtime-provider.mjs'
import { ReconnectBackoff } from './reconnect-backoff.mjs'
import { realtimeConnectionStatus } from './realtime-connection-status.mjs'

/**
 * Owns one provider-facing realtime Session lifecycle.
 *
 * The Gateway decides whether the client should be active, sleeping or waking;
 * this runtime performs provider selection, connection/reconnection, bounded
 * audio buffering and fatal-error blocking without knowing UI policy.
 */
export class RealtimeProviderSession {
  constructor({
    providerRegistry,
    defaultProvider,
    getAgentContext,
    getSessionOptions = () => ({}),
    shouldReconnect,
    onEvent,
    onDiagnostic,
    onConnected,
    onReady,
    onDisconnected,
    onReconnected,
    onConnectionState,
    onError,
    onReconnectError,
    logger,
    maxPendingAudioChunks = 30,
    stableConnectionMs = 10_000,
    createFrontend = createRealtimeFrontend,
    reconnectBackoff = new ReconnectBackoff(),
  }) {
    this.providerRegistry = providerRegistry
    this.providerKey = providerRegistry.resolve(defaultProvider).key
    this.getAgentContext = getAgentContext
    this.getSessionOptions = getSessionOptions
    this.shouldReconnect = shouldReconnect
    this.onEvent = onEvent
    this.onDiagnostic = onDiagnostic
    this.onConnected = onConnected
    this.onReady = onReady
    this.onDisconnected = onDisconnected
    this.onReconnected = onReconnected
    this.onConnectionState = onConnectionState
    this.onError = onError
    this.onReconnectError = onReconnectError
    this.logger = logger
    this.maxPendingAudioChunks = maxPendingAudioChunks
    this.stableConnectionMs = stableConnectionMs
    this.createFrontend = createFrontend
    this.reconnectBackoff = reconnectBackoff
    this.frontend = null
    this.connectPromise = null
    this.pendingAudio = []
    this.scheduledReconnect = null
    this.connectedAt = 0
    this.blockedError = ''
  }

  get ready() {
    return this.frontend?.ready === true
  }

  get connecting() {
    return Boolean(this.connectPromise)
  }

  get reconnectScheduled() {
    return Boolean(this.scheduledReconnect)
  }

  status({ sleeping = false, waking = false } = {}) {
    return realtimeConnectionStatus({
      provider: this.providerKey,
      blockedError: this.blockedError,
      sleeping,
      waking,
      ready: this.ready,
      connecting: this.connecting,
    })
  }

  provider() {
    return this.frontend?.provider
      ?? this.providerRegistry.resolve(this.providerKey)
  }

  classifyError(message) {
    return this.provider().classifyError?.(message) ?? 'other'
  }

  switchProvider(providerName) {
    const requested = this.providerRegistry.resolve(providerName)
    if (requested.key === this.providerKey) return false
    this.providerKey = requested.key
    this.blockedError = ''
    this.detach({ clearAudio: false })
    return true
  }

  reportError(error) {
    if (error?.realtimeConnectionReported) return
    if (error) error.realtimeConnectionReported = true
    this.onError(error)
  }

  block(errorMessage) {
    this.blockedError = String(errorMessage || '')
    this.clearPendingAudio()
    this.detach()
  }

  clearPendingAudio() {
    this.pendingAudio = []
  }

  cancelResponse() {
    this.frontend?.cancel()
  }

  // options 必须一并转发：底层靠 { refreshSession: false } 决定是否重发
  // session.update。这一层若吞掉第二个参数，调用方的意图会被静默丢弃 ——
  // 不报错、测试也照样绿，只是前缀缓存白白失效。
  updateAgentContext(context, options) {
    return this.frontend?.updateAgentContext(context, options)
  }

  appendAudio(audio) {
    if (this.ready) {
      this.frontend.appendAudio(audio)
      return
    }
    this.pendingAudio.push(audio)
    if (this.pendingAudio.length > this.maxPendingAudioChunks) {
      this.pendingAudio.splice(
        0,
        this.pendingAudio.length - this.maxPendingAudioChunks,
      )
    }
    if (!this.connectPromise && !this.scheduledReconnect) {
      this.ensure().catch(error => this.reportError(error))
    }
  }

  ensure() {
    if (this.blockedError) return Promise.reject(new Error(this.blockedError))
    if (this.ready) return Promise.resolve()
    if (this.connectPromise) return this.connectPromise
    if (this.scheduledReconnect) return this.scheduledReconnect.promise
    return this.connectNow()
  }

  connectNow() {
    if (this.ready) return Promise.resolve()
    if (this.connectPromise) return this.connectPromise
    this.onConnectionState({
      state: 'connecting',
      provider: this.providerKey,
    })
    const connectStartedAt = Date.now()
    this.logger.info('realtime.connecting', { provider: this.providerKey })
    let createdFrontend
    createdFrontend = this.createFrontend({
      providerName: this.providerKey,
      providerRegistry: this.providerRegistry,
      agentContext: this.getAgentContext(),
      sessionOptions: this.getSessionOptions(),
      onEvent: this.onEvent,
      onDiagnostic: this.onDiagnostic,
      onError: error => this.#handleProviderError(createdFrontend, error),
      onClose: () => this.#handleClose(createdFrontend),
    })
    this.frontend = createdFrontend
    let createdConnectPromise
    createdConnectPromise = createdFrontend.connect()
      .then(() => {
        if (this.frontend !== createdFrontend) return
        this.blockedError = ''
        this.connectedAt = Date.now()
        this.logger.info('realtime.connected', {
          provider: createdFrontend.provider.key,
          durationMs: this.connectedAt - connectStartedAt,
        })
        this.onConnectionState({
          state: 'connected',
          provider: createdFrontend.provider.key,
        })
        this.onConnected(createdFrontend)
        this.pendingAudio.forEach(audio => createdFrontend.appendAudio(audio))
        this.pendingAudio = []
        this.onReady(createdFrontend)
      })
      .catch(error => {
        if (this.frontend !== createdFrontend) return
        this.logger.error('realtime.connect_failed', {
          provider: createdFrontend.provider.key,
          durationMs: Date.now() - connectStartedAt,
          error,
        })
        const classification = createdFrontend.provider.classifyError(error.message)
        if (classification === 'fatal') {
          this.blockedError = error.message
          this.clearPendingAudio()
        }
        if (classification !== 'capacity_busy') {
          this.onConnectionState({
            state: 'unavailable',
            provider: createdFrontend.provider.key,
            message: error.message,
          })
        }
        throw error
      })
      .finally(() => {
        if (this.connectPromise === createdConnectPromise) {
          this.connectPromise = null
        }
      })
    this.connectPromise = createdConnectPromise
    return createdConnectPromise
  }

  #handleProviderError(createdFrontend, error) {
    if (this.frontend !== createdFrontend) return
    const classification = createdFrontend.provider.classifyError(error.message)
    if (classification !== 'inactivity') {
      this.logger.warn('realtime.provider_error', {
        provider: createdFrontend.provider.key,
        classification,
        error,
      })
    }
    if (classification === 'fatal') {
      this.blockedError = error.message
      this.clearPendingAudio()
      error.realtimeConnectionReported = true
    }
    if (classification !== 'inactivity' && classification !== 'capacity_busy') {
      this.reportError(error)
    }
  }

  #handleClose(createdFrontend) {
    if (this.frontend !== createdFrontend) return
    const connectedMs = this.connectedAt ? Date.now() - this.connectedAt : 0
    this.logger.warn('realtime.closed', {
      provider: createdFrontend.provider.key,
      connectedMs,
      blocked: Boolean(this.blockedError),
    })
    this.frontend = null
    this.onDisconnected()
    if (!this.shouldReconnect()) return
    this.onConnectionState({
      state: 'unavailable',
      provider: this.providerKey,
      ...(this.blockedError ? { message: this.blockedError } : {}),
    })
    if (this.blockedError) return
    if (connectedMs >= this.stableConnectionMs) this.reconnectBackoff.reset()
    this.connectedAt = 0
    this.scheduleReconnect()
      .then(() => this.onReconnected())
      .catch(error => this.onReconnectError(error))
  }

  scheduleReconnect() {
    if (this.blockedError || this.ready) return Promise.resolve()
    if (this.scheduledReconnect) return this.scheduledReconnect.promise
    let resolveScheduled
    let rejectScheduled
    const promise = new Promise((resolve, reject) => {
      resolveScheduled = resolve
      rejectScheduled = reject
    })
    const scheduled = {
      promise,
      resolve: resolveScheduled,
      reject: rejectScheduled,
      timer: null,
    }
    scheduled.timer = setTimeout(() => {
      if (this.scheduledReconnect !== scheduled) {
        scheduled.resolve()
        return
      }
      this.scheduledReconnect = null
      this.connectNow().then(scheduled.resolve, scheduled.reject)
    }, this.reconnectBackoff.next())
    scheduled.timer.unref?.()
    this.scheduledReconnect = scheduled
    return promise
  }

  cancelReconnect() {
    const scheduled = this.scheduledReconnect
    if (!scheduled) return
    this.scheduledReconnect = null
    clearTimeout(scheduled.timer)
    scheduled.resolve()
  }

  detach({ clearAudio = true, notifyDisconnected = false } = {}) {
    if (clearAudio) this.clearPendingAudio()
    this.cancelReconnect()
    const staleFrontend = this.frontend
    this.frontend = null
    this.connectPromise = null
    if (staleFrontend && notifyDisconnected) this.onDisconnected()
    staleFrontend?.close()
  }

  reconnect() {
    this.detach({ clearAudio: false })
    return this.scheduleReconnect()
  }

  close(options) {
    this.detach(options)
  }
}
