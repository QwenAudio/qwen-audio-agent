import {
  GATEWAY_CLIENT_PROTOCOL_VERSION,
  GatewayClientCapability,
  GatewayClientProtocolEvent,
  createGatewayClientProtocolMessage,
  createGatewaySessionHello,
  parseGatewayServerProtocolMessage,
} from './gateway-client-protocol.mjs'

const RESULT_TYPES = new Set([
  GatewayClientProtocolEvent.CLIENT_EVENT_PUBLISH_RESULT,
  GatewayClientProtocolEvent.SESSION_OUTPUT_VOICE_UPDATED,
  GatewayClientProtocolEvent.TASK_CREATE_RESULT,
  GatewayClientProtocolEvent.TASK_GET_RESULT,
  GatewayClientProtocolEvent.TASK_LIST_RESULT,
  GatewayClientProtocolEvent.TASK_CANCEL_RESULT,
  GatewayClientProtocolEvent.PERMISSION_RESPOND_RESULT,
  GatewayClientProtocolEvent.CONVERSATION_HISTORY_RESULT,
  GatewayClientProtocolEvent.SESSION_REPLAY_RESULT,
  'error',
])

function addSocketListener(socket, type, listener) {
  if (typeof socket.addEventListener === 'function') {
    socket.addEventListener(type, listener)
    return
  }
  socket.on(type, listener)
}

function socketPayload(value) {
  return value?.data === undefined ? value : value.data
}

function socketOpen(socket) {
  return socket?.readyState === 1
}

function decodeMessage(raw) {
  const value = socketPayload(raw)
  return JSON.parse(typeof value === 'string' ? value : value.toString())
}

function connectionConfiguration(value = {}) {
  if (!value || typeof value !== 'object') return undefined
  return {
    ...(value.voiceEnabled === undefined ? {} : { voice_enabled: value.voiceEnabled === true }),
    ...(value.inputEnabled === undefined ? {} : { input_enabled: value.inputEnabled === true }),
    ...(value.outputEnabled === undefined ? {} : { output_enabled: value.outputEnabled === true }),
    ...(value.textOnly === undefined ? {} : { text_only: value.textOnly === true }),
    ...(value.wakeWordOnly === undefined ? {} : { wake_word_only: value.wakeWordOnly === true }),
    ...(value.provider ? { provider: String(value.provider) } : {}),
    ...(value.outputVoice ? { output_voice: String(value.outputVoice) } : {}),
    ...(value.workingDirectory ? { working_directory: String(value.workingDirectory) } : {}),
    ...(Array.isArray(value.clientStates) ? { client_states: value.clientStates } : {}),
  }
}

export class GatewayClient {
  constructor({
    url,
    createSocket,
    clientType = 'web',
    clientVersion,
    clientInstanceId,
    clientLabel,
    capabilities = [],
    locale,
    timeZone,
    configure,
    reconnect = true,
    reconnectMinMs = 500,
    reconnectMaxMs = 5_000,
    requestTimeoutMs = 10_000,
    onEvent,
    onStatus,
    onAction,
    onRecovery,
  } = {}) {
    if (!url) throw new TypeError('url is required')
    if (typeof createSocket !== 'function') throw new TypeError('createSocket is required')
    this.url = String(url)
    this.createSocket = createSocket
    this.client = {
      type: clientType,
      version: clientVersion,
      instanceId: clientInstanceId,
      label: clientLabel,
    }
    this.requestedCapabilities = [...new Set(capabilities)]
    this.locale = locale
    this.timeZone = timeZone
    this.configure = configure
    this.reconnect = reconnect !== false
    this.reconnectMinMs = Math.max(50, Number(reconnectMinMs) || 500)
    this.reconnectMaxMs = Math.max(this.reconnectMinMs, Number(reconnectMaxMs) || 5_000)
    this.requestTimeoutMs = Math.max(100, Number(requestTimeoutMs) || 10_000)
    this.onEvent = onEvent
    this.onStatus = onStatus
    this.onAction = onAction
    this.onRecovery = onRecovery
    this.socket = null
    this.stopped = true
    this.ready = false
    this.negotiatedCapabilities = []
    this.reconnectDelay = this.reconnectMinMs
    this.reconnectTimer = null
    this.pending = new Map()
    this.lastSequence = 0
  }

  start() {
    if (!this.stopped) return this
    this.stopped = false
    this.#connect()
    return this
  }

  stop() {
    this.stopped = true
    this.ready = false
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.#rejectPending('client_stopped', 'Gateway Client stopped')
    const socket = this.socket
    this.socket = null
    socket?.close?.()
  }

  supports(capability) {
    return this.negotiatedCapabilities.includes(capability)
  }

  get readyState() {
    return this.socket?.readyState ?? 3
  }

  close() {
    this.stop()
  }

  send(event) {
    if (!socketOpen(this.socket)) return false
    try {
      const message = (
        event
        && typeof event === 'object'
        && typeof event.type === 'string'
        && !event.event_id
      )
        ? createGatewayClientProtocolMessage(event.type, Object.fromEntries(
          Object.entries(event).filter(([key]) => key !== 'type'),
        ))
        : event
      this.socket.send(typeof message === 'string' ? message : JSON.stringify(message))
      return true
    } catch {
      return false
    }
  }

  request(type, payload = {}, { timeoutMs = this.requestTimeoutMs } = {}) {
    if (!this.ready) {
      return Promise.reject(Object.assign(new Error('Gateway Client is not ready'), {
        code: 'client_not_ready',
      }))
    }
    const message = createGatewayClientProtocolMessage(type, payload)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(message.event_id)
        reject(Object.assign(new Error(`${type} timed out`), {
          code: 'request_timeout',
        }))
      }, Math.max(100, Number(timeoutMs) || this.requestTimeoutMs))
      timer.unref?.()
      this.pending.set(message.event_id, { resolve, reject, timer, type })
      if (!this.send(message)) {
        clearTimeout(timer)
        this.pending.delete(message.event_id)
        reject(Object.assign(new Error('Gateway connection is unavailable'), {
          code: 'connection_unavailable',
        }))
      }
    })
  }

  updateOutputVoice(voice, options) {
    if (!this.supports(GatewayClientCapability.SESSION_OUTPUT_VOICE)) {
      return Promise.reject(Object.assign(
        new Error('session.output_voice was not negotiated'),
        { code: 'capability_not_negotiated' },
      ))
    }
    return this.request(
      GatewayClientProtocolEvent.SESSION_OUTPUT_VOICE_UPDATE,
      { voice: String(voice || '').trim() },
      options,
    )
  }

  async recover() {
    const recovered = { events: [], tasks: [], messages: [] }
    if (this.supports(GatewayClientCapability.SESSION_REPLAY) && this.lastSequence > 0) {
      try {
        let cursor = this.lastSequence
        let hasMore = true
        while (hasMore) {
          const page = await this.request(GatewayClientProtocolEvent.SESSION_REPLAY, {
            after_sequence: cursor,
            limit: 200,
          })
          for (const event of page.events || []) this.#dispatch(event, { replayed: true })
          recovered.events.push(...(page.events || []))
          cursor = page.next_sequence
          hasMore = page.has_more === true
        }
      } catch (error) {
        if (!['sequence_expired', 'session_expired'].includes(error.code)) {
          throw error
        }
        this.lastSequence = 0
      }
    }
    if (this.supports(GatewayClientCapability.TASK_COMMANDS)) {
      const result = await this.request(GatewayClientProtocolEvent.TASK_LIST, { limit: 100 })
      recovered.tasks = result.tasks || []
    }
    if (this.supports(GatewayClientCapability.CONVERSATION_HISTORY)) {
      const result = await this.request(GatewayClientProtocolEvent.CONVERSATION_HISTORY)
      recovered.messages = result.messages || []
    }
    this.onRecovery?.(recovered)
    return recovered
  }

  #connect() {
    if (this.stopped) return
    this.onStatus?.({ state: 'connecting' })
    const socket = this.createSocket(this.url)
    this.socket = socket
    addSocketListener(socket, 'open', () => {
      if (this.socket !== socket || this.stopped) return
      this.reconnectDelay = this.reconnectMinMs
      this.onStatus?.({ state: 'connected' })
      const configured = typeof this.configure === 'function'
        ? this.configure()
        : this.configure
      this.send(createGatewaySessionHello({
        protocolMin: GATEWAY_CLIENT_PROTOCOL_VERSION,
        protocolMax: GATEWAY_CLIENT_PROTOCOL_VERSION,
        clientType: this.client.type,
        clientVersion: this.client.version,
        clientInstanceId: this.client.instanceId,
        clientLabel: this.client.label,
        capabilities: this.requestedCapabilities,
        locale: this.locale,
        timeZone: this.timeZone,
        connection: connectionConfiguration(configured),
      }))
    })
    addSocketListener(socket, 'message', raw => {
      if (this.socket !== socket || this.stopped) return
      let event
      try {
        event = parseGatewayServerProtocolMessage(decodeMessage(raw))
      } catch {
        return
      }
      this.#receive(event)
    })
    addSocketListener(socket, 'error', error => {
      if (this.socket !== socket || this.stopped) return
      this.onStatus?.({ state: 'unavailable', error })
    })
    addSocketListener(socket, 'close', () => {
      if (this.socket !== socket) return
      this.socket = null
      this.ready = false
      this.negotiatedCapabilities = []
      this.#rejectPending('connection_closed', 'Gateway connection closed')
      if (this.stopped) return
      this.onStatus?.({ state: 'disconnected' })
      if (!this.reconnect) return
      this.reconnectTimer = setTimeout(() => this.#connect(), this.reconnectDelay)
      this.reconnectDelay = Math.min(this.reconnectMaxMs, this.reconnectDelay * 2)
    })
  }

  #receive(event) {
    if (event.type === GatewayClientProtocolEvent.SESSION_READY) {
      this.ready = true
      this.negotiatedCapabilities = [...event.capabilities]
      this.onStatus?.({ state: 'ready', event })
      this.recover().catch(error => this.onStatus?.({ state: 'recovery_failed', error }))
      return
    }
    if (event.type === GatewayClientProtocolEvent.CLIENT_ACTION_REQUEST) {
      this.#handleAction(event)
      return
    }
    const pending = event.request_event_id
      ? this.pending.get(event.request_event_id)
      : null
    if (pending && RESULT_TYPES.has(event.type)) {
      clearTimeout(pending.timer)
      this.pending.delete(event.request_event_id)
      if (event.type === 'error') {
        pending.reject(Object.assign(new Error(event.error.message), {
          code: event.error.code,
        }))
      } else pending.resolve(event)
      return
    }
    this.#dispatch(
      event.type === 'error' && event.error && !event.message
        ? { ...event, message: event.error.message }
        : event,
    )
  }

  #dispatch(event, metadata = {}) {
    if (Number.isInteger(event.sequence)) {
      if (event.sequence <= this.lastSequence) return
      this.lastSequence = Math.max(this.lastSequence, event.sequence)
    }
    this.onEvent?.(event, metadata)
  }

  async #handleAction(event) {
    let result
    try {
      result = await this.onAction?.(event)
    } catch (error) {
      result = {
        status: 'failed',
        error: { code: 'client_action_failed', message: String(error?.message || error) },
      }
    }
    const normalized = result?.status ? result : {
      status: 'unsupported',
      error: {
        code: 'client_action_unsupported',
        message: `Unsupported Client Action: ${String(event.name || '')}`,
      },
    }
    this.send(createGatewayClientProtocolMessage(
      GatewayClientProtocolEvent.CLIENT_ACTION_RESULT,
      {
        request_event_id: event.event_id,
        status: normalized.status,
        ...(normalized.output === undefined ? {} : { output: normalized.output }),
        ...(normalized.error ? { error: normalized.error } : {}),
      },
    ))
  }

  #rejectPending(code, message) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(Object.assign(new Error(message), { code }))
    }
    this.pending.clear()
  }
}
