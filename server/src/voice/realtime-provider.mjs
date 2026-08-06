import WebSocket from 'ws'
import { randomUUID } from 'node:crypto'
import {
  resolveRealtimeProvider,
  validateRealtimeProvider,
} from './providers/registry.mjs'
import {
  isResponseActivityEvent,
  realtimeResponseId,
} from './response-lifecycle.mjs'

// Re-export provider-agnostic tools and instructions so existing callers
// (tests, tool-call-handler, bootstrap) continue to work without changes.
export {
  SPAWN_THINKING_TOOL_NAME,
  SCHEDULE_REMINDER_TOOL_NAME,
  DELEGATE_TOOL_NAME,
  CANCEL_AGENT_TASK_TOOL_NAME,
  GET_AGENT_TASK_STATUS_TOOL_NAME,
  GET_CURRENT_TIME_TOOL_NAME,
  MEMORY_TOOL_NAME,
  NOTES_TOOL_NAME,
  RESPOND_AGENT_PERMISSION_TOOL_NAME,
  ENTER_SLEEP_TOOL_NAME,
  TOOLS,
  frontendTools,
  buildFrontendInstructions,
} from './frontend-tools.mjs'

// Re-export registry symbols for backward compatibility.
export {
  REALTIME_PROVIDERS,
  resolveRealtimeProvider,
  listRealtimeProviders,
  describeActiveRealtime,
} from './providers/registry.mjs'

function normalizedEvents(value) {
  if (!value) return []
  return Array.isArray(value) ? value.filter(Boolean) : [value]
}

export function realtimeEventErrorMessage(event, fallback = '实时语音服务错误') {
  const details = [
    event?.error?.code,
    event?.error?.type,
    event?.error?.message,
    event?.message,
  ].map(value => String(value || '').trim()).filter(Boolean)
  return [...new Set(details)].join(': ') || fallback
}

// Behavioural capabilities of a provider's Realtime implementation. Every
// default describes the fully specification-compliant behaviour, so providers
// only declare the guarantees they do NOT uphold and the frontend compensates
// without ever branching on a provider name.
const DEFAULT_CAPABILITIES = Object.freeze({
  // Acknowledges session.update with session.updated.
  acknowledgesSessionUpdate: true,
  // Accepts concurrent response.create requests (queues instead of refusing).
  singleResponseSlot: false,
  // Echoes response metadata so client-created responses can be correlated
  // without confusing them with automatic server-side responses.
  responseMetadataCorrelation: false,
})

export class RealtimeFrontend {
  constructor({
    provider = resolveRealtimeProvider(),
    onEvent,
    onError,
    onClose,
    agentContext = {},
    responseStartTimeoutMs,
    responseCompletionTimeoutMs = 120000,
  } = {}) {
    this.provider = validateRealtimeProvider(provider)
    this.protocol = provider.protocol
    if (!this.protocol) {
      throw new Error(`Realtime Provider ${provider.key || provider.label} 缺少 protocol`)
    }
    this.capabilities = { ...DEFAULT_CAPABILITIES, ...provider.capabilities }
    this.onEvent = onEvent
    this.onError = onError
    this.onClose = onClose
    this.agentContext = agentContext
    this.ws = null
    this.ready = false
    this.sessionConfigured = false
    this.activeResponses = new Set()
    this.pendingResponses = []
    this.responseWaiters = new Map()
    this.conversationItemWaiters = new Map()
    this.idleWaiters = []
    this.outputQueue = Promise.resolve()
    this.responseQueueGeneration = 0
    this.responseStartTimeoutMs = responseStartTimeoutMs
      ?? this.provider.responseStartTimeoutMs
      ?? 30000
    this.responseCompletionTimeoutMs = responseCompletionTimeoutMs
  }

  connect() {
    if (!this.provider.isConfigured()) {
      return Promise.reject(new Error(this.provider.missingConfigurationMessage))
    }
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.provider.url(), {
        headers: this.provider.headers(),
      })
      this.ws = ws
      let settled = false
      const timeout = setTimeout(() => {
        const error = new Error(this.provider.connectTimeoutMessage)
        finish(error)
        ws.terminate()
      }, 25000)
      const finish = error => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        if (error) reject(error)
        else resolve()
      }
      ws.on('error', error => {
        this.onError?.(error)
        finish(error)
      })
      ws.on('close', () => {
        this.ready = false
        this.sessionConfigured = false
        this.resetResponses()
        finish(new Error(`${this.provider.label} 连接已关闭`))
        this.onClose?.()
      })
      ws.on('message', raw => {
        let providerEvent
        try {
          providerEvent = JSON.parse(raw.toString())
        } catch {
          return
        }
        try {
          this.handleProviderEvent(providerEvent, {
            onSessionReady: () => finish(),
          })
        } catch (error) {
          this.onError?.(error)
          finish(error)
          ws.terminate()
        }
      })
    })
  }

  handleProviderEvent(providerEvent, { onSessionReady } = {}) {
    const events = normalizedEvents(
      this.protocol.normalizeIncoming(providerEvent),
    )
    for (const event of events) {
      if (event.type === 'error' && !this.ready) {
        const error = new Error(realtimeEventErrorMessage(event))
        error.realtimeEvent = true
        throw error
      }
      if (event.type === 'session.created') {
        this.updateSession()
        if (!this.capabilities.acknowledgesSessionUpdate) {
          this.ready = true
          this.sessionConfigured = true
          onSessionReady?.()
        }
      }
      if (event.type === 'session.updated') {
        this.ready = true
        this.sessionConfigured = true
        onSessionReady?.()
      }
      this.handleLifecycle(event)
      this.onEvent?.(event)
    }
    return events
  }

  updateSession() {
    const session = this.provider.buildSession({
      configured: this.sessionConfigured,
      agentContext: this.agentContext,
    })
    this.send(this.protocol.sessionUpdate(session))
  }

  updateAgentContext(patch = {}) {
    this.agentContext = { ...this.agentContext, ...patch }
    if (!this.ready) return
    const refresh = async () => {
      await this.whenIdle()
      if (this.ready) this.updateSession()
    }
    this.outputQueue = this.outputQueue.then(refresh, refresh)
  }

  appendAudio(audio) {
    this.send(this.protocol.audioAppend(audio))
  }

  sendUserText(text, context = {}, { modalities } = {}) {
    const content = String(text || '').trim()
    if (!content) return Promise.resolve()
    return this.enqueueResponse('model', context, async () => {
      await this.createConversationItem(this.protocol.userTextItem(content))
      this.send(this.protocol.responseCreate(
        modalities ? { modalities } : undefined,
      ))
    })
  }

  ensureResponse(context = {}, { shouldCreate } = {}) {
    return this.enqueueResponse('agent', context, () => {
      if (shouldCreate && !shouldCreate()) return false
      this.send(this.protocol.responseCreate())
    })
  }

  sendFunctionOutput(callId, output, context = {}, {
    createResponse = true,
    response,
  } = {}) {
    const sendOutput = () => this.createConversationItem(
      this.protocol.functionOutputItem(callId, output),
    )
    if (!createResponse) return this.enqueueAction(sendOutput)
    return this.enqueueResponse('agent', context, async () => {
      await sendOutput()
      this.send(this.protocol.responseCreate(response))
    })
  }

  createConversationItem(item) {
    // Id namespaces are dialect-specific (the GA dialect derives them from the
    // item type), so the protocol adapter mints the id.
    const id = item.id || this.protocol.conversationItemId(item)
    return new Promise((resolve, reject) => {
      const waiter = {
        id,
        resolve,
        reject,
        timer: setTimeout(() => {
          if (this.conversationItemWaiters.get(id) !== waiter) return
          this.conversationItemWaiters.delete(id)
          reject(new Error(`${this.provider.label} 未确认对话项 ${id}`))
        }, this.responseStartTimeoutMs),
      }
      this.conversationItemWaiters.set(id, waiter)
      this.send(this.protocol.conversationItemCreate({ id, ...item }))
    })
  }

  speak(text, origin = 'agent', context = {}, {
    shouldSpeak,
  } = {}) {
    const content = String(text || '').trim()
    if (!content) return Promise.resolve()
    return this.enqueueResponse(origin, context, () => {
      if (shouldSpeak && !shouldSpeak()) return false
      this.send(this.protocol.responseCreate(
        this.provider.buildSpeakResponse(content, {
          textOnly: this.agentContext.textOnly === true,
        }),
      ))
    })
  }

  async injectResult(
    text,
    origin = 'announcement',
    context = {},
    { injectContext = true } = {},
  ) {
    const content = String(text || '').trim()
    if (!content) return
    const injection = this.provider.buildResultInjection(content, {
      textOnly: this.agentContext.textOnly === true,
    })
    let contextInjected = false
    const outcome = await this.enqueueResponse(origin, context, async () => {
      if (injectContext) {
        await this.createConversationItem(injection.item)
        contextInjected = true
      }
      this.send(this.protocol.responseCreate(injection.response))
    })
    return {
      ...(outcome || {}),
      contextInjected,
    }
  }

  async injectPermission(permission, context = {}, {
    shouldSpeak,
  } = {}) {
    if (!permission?.id || !permission?.summary) return
    const injection = this.provider.buildPermissionInjection(permission, {
      textOnly: this.agentContext.textOnly === true,
    })
    // Make the permission identity available to the model immediately. The
    // spoken question may wait behind an active response, while the user can
    // already see the actionable permission event in TUI/WebUI and answer it.
    await this.createConversationItem(injection.item)
    return this.enqueueResponse('permission', context, pending => {
      if (pending.settled || (shouldSpeak && !shouldSpeak())) return false
      this.send(this.protocol.responseCreate(injection.response))
    })
  }

  cancel() {
    this.responseQueueGeneration += 1
    const hasResponse = this.activeResponses.size || this.pendingResponses.length
    this.pendingResponses.forEach(item => {
      this.settlePending(item, { cancelled: true, phase: 'start' })
    })
    this.pendingResponses = []
    this.rejectConversationItemWaiters(new Error('Realtime 请求已取消'))
    if (hasResponse) this.send(this.protocol.responseCancel())
  }

  cancelResponses(predicate) {
    const matches = pending => {
      try {
        return predicate?.(pending.context, pending.origin) === true
      } catch {
        return false
      }
    }
    const retained = []
    for (const pending of this.pendingResponses) {
      if (!matches(pending)) {
        retained.push(pending)
        continue
      }
      this.settlePending(pending, { cancelled: true, phase: 'start' })
    }
    this.pendingResponses = retained
    let cancelledActive = false
    for (const pending of this.responseWaiters.values()) {
      if (!matches(pending)) continue
      cancelledActive = true
      this.settlePending(pending, {
        cancelled: true,
        phase: 'completion',
      })
    }
    if (cancelledActive) this.send(this.protocol.responseCancel())
    return cancelledActive
  }

  enqueueAction(action) {
    const generation = this.responseQueueGeneration
    const run = async () => {
      await this.whenIdle()
      if (!this.ready || generation !== this.responseQueueGeneration) return
      await action()
    }
    this.outputQueue = this.outputQueue.then(run, run)
    return this.outputQueue
  }

  enqueueResponse(origin, context, create) {
    const generation = this.responseQueueGeneration
    const run = async () => {
      await this.whenIdle()
      if (!this.ready || generation !== this.responseQueueGeneration) return
      let resolveOutcome
      const outcome = new Promise(resolve => {
        resolveOutcome = resolve
      })
      const pending = {
        origin,
        context,
        requestId: randomUUID(),
        resolve: resolveOutcome,
        settled: false,
        timer: null,
      }
      if (this.pendingResponses.length) {
        const error = new Error(
          'Realtime 响应关联冲突：已有响应正在等待 response.created',
        )
        this.settlePending(pending, {
          failed: true,
          phase: 'correlation',
          error: error.message,
        })
        this.onError?.(error)
        return outcome
      }
      this.pendingResponses.push(pending)
      try {
        const created = await create(pending)
        if (created === false) {
          const index = this.pendingResponses.indexOf(pending)
          if (index >= 0) this.pendingResponses.splice(index, 1)
          this.settlePending(pending, {
            skipped: true,
            phase: 'deduplicated',
          })
          return outcome
        }
      } catch (error) {
        const index = this.pendingResponses.indexOf(pending)
        if (index >= 0) this.pendingResponses.splice(index, 1)
        this.settlePending(pending, {
          failed: true,
          phase: 'input',
          error: error.message,
        })
        if (!error.realtimeEvent) this.onError?.(error)
        return outcome
      }
      if (!pending.settled) {
        pending.timer = setTimeout(() => {
          const index = this.pendingResponses.indexOf(pending)
          if (index >= 0) this.pendingResponses.splice(index, 1)
          this.settlePending(pending, { timedOut: true, phase: 'start' })
        }, this.responseStartTimeoutMs)
      }
      return outcome
    }
    this.outputQueue = this.outputQueue.then(run, run)
    return this.outputQueue
  }

  handleLifecycle(event) {
    if (event.type === 'conversation.item.created') {
      const id = event.item?.id
      const waiter = this.conversationItemWaiters.get(id)
      if (waiter) {
        clearTimeout(waiter.timer)
        this.conversationItemWaiters.delete(id)
        waiter.resolve(event.item)
      }
    }
    if (event.type === 'error' && this.conversationItemWaiters.size) {
      const waiter = this.conversationItemWaiters.values().next().value
      clearTimeout(waiter.timer)
      this.conversationItemWaiters.delete(waiter.id)
      const error = new Error(
        event.error?.message || `${this.provider.label} 创建对话项失败`,
      )
      error.realtimeEvent = true
      waiter.reject(error)
      return
    }
    if (isResponseActivityEvent(event)) {
      this.activeResponses.add(realtimeResponseId(event))
    }
    if (event.type === 'response.created') {
      const id = realtimeResponseId(event)
      let pending
      if (this.capabilities.responseMetadataCorrelation) {
        const requestId = this.protocol.responseCorrelationId(event)
        const index = requestId
          ? this.pendingResponses.findIndex(item => item.requestId === requestId)
          : -1
        if (index >= 0) {
          pending = this.pendingResponses.splice(index, 1)[0]
        }
      } else {
        pending = this.pendingResponses.shift()
      }
      clearTimeout(pending?.timer)
      event.__voiceOrigin = pending?.origin || 'model'
      event.__voiceContext = pending?.context || {}
      if (id) {
        this.activeResponses.add(id)
        if (pending) {
          pending.timer = setTimeout(() => {
            if (this.responseWaiters.get(id) !== pending) return
            this.send(this.protocol.responseCancel())
            this.settlePending(pending, {
              timedOut: true,
              phase: 'completion',
              responseId: id,
            })
            const recoveryTimer = setTimeout(() => {
              if (this.responseWaiters.get(id) !== pending) return
              this.responseWaiters.delete(id)
              this.activeResponses.delete(id)
              this.resolveIdle()
            }, 1000)
            recoveryTimer.unref?.()
          }, this.responseCompletionTimeoutMs)
          this.responseWaiters.set(id, pending)
        }
      }
    }
    if (
      event.type === 'response.done'
      || event.type === 'error'
    ) {
      let id = realtimeResponseId(event)
      let pending = this.responseWaiters.get(id)
      if (
        event.type === 'error'
        && !pending && !id && this.pendingResponses.length
      ) {
        pending = this.pendingResponses.shift()
      }
      if (
        event.type === 'error'
        && !pending && this.responseWaiters.size === 1
      ) {
        const first = this.responseWaiters.entries().next().value
        id = first[0]
        pending = first[1]
      }
      // A single-slot provider refuses a response.create that races a
      // server-side turn. Retry the refused payload once the slot frees up
      // instead of dropping the injection on the floor.
      const slotBusy = event.type === 'error'
        && this.capabilities.singleResponseSlot
        && this.provider.classifyError(
          event.error?.message || event.message || '',
        ) === 'response_slot_busy'
      if (
        slotBusy
        && pending
        && pending.responsePayload
        && (pending.busyRetries || 0) < 3
      ) {
        pending.busyRetries = (pending.busyRetries || 0) + 1
        // Marks the event as internally handled: the gateway must not surface
        // a transparently retried refusal to the user.
        event.__voiceRetried = true
        clearTimeout(pending.timer)
        // The correlated id belongs to the server's own response (the refusal
        // proves ours never started), so unbind the mismatched mapping. The
        // real response still retires the id through activeResponses.
        if (id && this.responseWaiters.get(id) === pending) {
          this.responseWaiters.delete(id)
        }
        this.retryRefusedResponse(pending)
        return
      }
      event.__voiceOrigin = pending?.origin || event.__voiceOrigin
      event.__voiceContext = pending?.context || event.__voiceContext || {}
      if (id) {
        this.activeResponses.delete(id)
        this.responseWaiters.delete(id)
      }
      const status = event.response?.status
      const completed = event.type === 'response.done'
        && !['failed', 'cancelled', 'incomplete'].includes(status)
      this.settlePending(pending, completed
        ? { completed: true, responseId: id }
        : { failed: true, responseId: id, status })
      this.resolveIdle()
    }
  }

  settlePending(pending, outcome) {
    if (!pending || pending.settled) return
    pending.settled = true
    clearTimeout(pending.timer)
    pending.resolve(outcome)
  }

  // Re-issues a response.create refused by an occupied single response slot.
  // Two constraints shape this implementation:
  // 1. It must NOT be scheduled through outputQueue: the refused response's
  //    outcome promise is what the queue tail awaits, so queueing the retry
  //    behind it deadlocks the whole pipeline.
  // 2. A known active response provides the real release signal. A bounded
  //    delay is used only when the busy error arrives before response.created,
  //    so the server-side response is not visible yet.
  retryRefusedResponse(pending) {
    const generation = this.responseQueueGeneration
    const delays = [1200, 2600, 5000]
    const delay = delays[Math.min(pending.busyRetries - 1, delays.length - 1)]
    const attempt = async () => {
      if (this.activeResponses.size) {
        await this.whenIdle()
      } else {
        await new Promise(resolve => setTimeout(resolve, delay))
        await this.whenIdle()
      }
      if (!this.ready || generation !== this.responseQueueGeneration) {
        this.settlePending(pending, { cancelled: true, phase: 'start' })
        return
      }
      if (this.pendingResponses.length) {
        this.settlePending(pending, { failed: true, phase: 'correlation' })
        return
      }
      this.pendingResponses.push(pending)
      this.send(pending.responsePayload)
      if (!pending.settled) {
        pending.timer = setTimeout(() => {
          const index = this.pendingResponses.indexOf(pending)
          if (index >= 0) this.pendingResponses.splice(index, 1)
          this.settlePending(pending, { timedOut: true, phase: 'start' })
        }, this.responseStartTimeoutMs)
      }
    }
    attempt().catch(() => {
      this.settlePending(pending, { failed: true, phase: 'start' })
    })
  }

  whenIdle() {
    if (!this.activeResponses.size) return Promise.resolve()
    return new Promise(resolve => this.idleWaiters.push(resolve))
  }

  resolveIdle() {
    if (this.activeResponses.size) return
    while (this.idleWaiters.length) this.idleWaiters.shift()?.()
  }

  resetResponses() {
    this.responseQueueGeneration += 1
    this.activeResponses.clear()
    this.rejectConversationItemWaiters(new Error('Realtime 会话已重置'))
    this.pendingResponses.forEach(item => this.settlePending(item, { cancelled: true }))
    this.responseWaiters.forEach(item => this.settlePending(item, { cancelled: true }))
    this.pendingResponses = []
    this.responseWaiters.clear()
    this.resolveIdle()
  }

  rejectConversationItemWaiters(error) {
    this.conversationItemWaiters.forEach(waiter => {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    })
    this.conversationItemWaiters.clear()
  }

  close() {
    this.ws?.close()
    this.ws = null
    this.ready = false
    this.resetResponses()
  }

  send(payload) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      let outgoing = payload
      if (payload.type === 'response.create' && this.pendingResponses.length) {
        const pending = this.pendingResponses[this.pendingResponses.length - 1]
        outgoing = this.protocol.correlateResponseCreate(
          payload,
          pending.requestId,
        )
        if (this.capabilities.singleResponseSlot) {
          // Remember the exact payload on the pending marker so a refused
          // response can be replayed after the occupied slot becomes idle.
          pending.responsePayload = outgoing
        }
      }
      const body = this.protocol.encodeOutgoing(outgoing)
      this.ws.send(JSON.stringify(body))
    }
  }
}

export function createRealtimeFrontend(options = {}) {
  const { providerName, ...rest } = options
  return new RealtimeFrontend({
    ...rest,
    provider: resolveRealtimeProvider(providerName),
  })
}
