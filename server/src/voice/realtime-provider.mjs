import WebSocket from 'ws'
import { randomUUID } from 'node:crypto'
import {
  defaultRealtimeProviderRegistry,
  resolveRealtimeProvider,
  validateRealtimeProtocol,
  validateRealtimeProvider,
} from './providers/registry.mjs'
import { buildRecentConversationContext } from '../conversation/frontend-agent-context.mjs'
import {
  isResponseActivityEvent,
  realtimeResponseId,
} from './response-lifecycle.mjs'
import { frontendInputProjection } from '../../../shared/input-parts.mjs'

// Re-export provider-agnostic tools and instructions so existing callers
// (tests, tool-call-handler, bootstrap) continue to work without changes.
export {
  SPAWN_THINKING_TOOL_NAME,
  SCHEDULE_REMINDER_TOOL_NAME,
  CANCEL_AGENT_TASK_TOOL_NAME,
  GET_AGENT_TASK_STATUS_TOOL_NAME,
  GET_CURRENT_TIME_TOOL_NAME,
  MEMORY_TOOL_NAME,
  NOTES_TOOL_NAME,
  RESPOND_PERMISSION_TOOL_NAME,
  ENTER_SLEEP_TOOL_NAME,
  TOOLS,
  frontendToolRegistry,
  frontendTools,
  buildFrontendInstructions,
} from './frontend-tools.mjs'

// Re-export registry symbols for backward compatibility.
export {
  REALTIME_PROVIDERS,
  createRealtimeProviderRegistry,
  defaultRealtimeProviderRegistry,
  RealtimeProviderRegistry,
  resolveRealtimeProvider,
  listRealtimeProviders,
  describeActiveRealtime,
  validateRealtimeProtocol,
  validateRealtimeProvider,
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

// Behavioural capabilities of a provider's Realtime implementation. Defaults
// encode the shared protocol baseline; optional features require opt-in and
// providers declare known constraints, without the frontend ever branching on
// a provider name.
const DEFAULT_CAPABILITIES = Object.freeze({
  // Acknowledges session.update with session.updated.
  acknowledgesSessionUpdate: true,
  // Accepts concurrent response.create requests (queues instead of refusing).
  singleResponseSlot: false,
  // Echoes response metadata so client-created responses can be correlated
  // without confusing them with automatic server-side responses.
  responseMetadataCorrelation: false,
  // Applies instructions supplied on one response.create without requiring a
  // persistent conversation item.
  perResponseInstructions: false,
  // Applies a client-selected output voice when creating a fresh Session.
  sessionOutputVoice: false,
  // Echoes a client-assigned item id in conversation.item.created. Some
  // providers acknowledge the item but replace its id, so those providers
  // must opt out and use the single pending item waiter instead.
  conversationItemIdEcho: true,
})
const DEFAULT_RESPONSE_CANCEL_GRACE_MS = 1_000

export class RealtimeFrontend {
  constructor({
    provider = resolveRealtimeProvider(),
    onEvent,
    onError,
    onClose,
    onDiagnostic,
    agentContext = {},
    sessionOptions = {},
    responseStartTimeoutMs,
    responseInactivityTimeoutMs,
    responseCompletionTimeoutMs,
    responseCancelGraceMs = DEFAULT_RESPONSE_CANCEL_GRACE_MS,
  } = {}) {
    this.provider = validateRealtimeProvider(provider)
    this.connectionId = randomUUID()
    this.protocol = validateRealtimeProtocol(
      provider.createProtocol?.({
        connectionId: this.connectionId,
        provider,
      }) ?? provider.protocol,
      provider.key || provider.label,
    )
    this.capabilities = { ...DEFAULT_CAPABILITIES, ...provider.capabilities }
    this.modelProfile = provider.modelProfile?.() || null
    this.modelCapabilities = this.modelProfile?.modelCapabilities || null
    this.transportCapabilities = this.modelProfile?.transportCapabilities || null
    this.onEvent = onEvent
    this.onError = onError
    this.onClose = onClose
    this.onDiagnostic = onDiagnostic
    this.agentContext = agentContext
    this.sessionOptions = sessionOptions
    this.ws = null
    this.ready = false
    this.sessionConfigured = false
    this.recentContextInjected = false
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
    // Keep the previous option as an internal compatibility alias. This is an
    // inactivity watchdog, not an absolute response duration limit: long
    // speech must remain valid while the provider keeps streaming output.
    this.responseInactivityTimeoutMs = responseInactivityTimeoutMs
      ?? responseCompletionTimeoutMs
      ?? 120000
    this.responseCancelGraceMs = Math.max(
      0,
      Number(responseCancelGraceMs) || 0,
    )
  }

  connect() {
    if (this.modelProfile?.family === 'unknown') {
      return Promise.reject(new Error(
        `不支持的 Realtime 模型：${this.modelProfile.id}`
        + `（${this.provider.label}）`,
      ))
    }
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
      ws.on('open', () => {
        try {
          const messages = normalizedEvents(
            this.protocol.connectionMessages?.({
              connectionId: this.connectionId,
              provider: this.provider,
            }),
          )
          for (const message of messages) {
            ws.send(JSON.stringify(message))
          }
        } catch (error) {
          this.onError?.(error)
          finish(error)
          ws.terminate()
        }
      })
      ws.on('error', error => {
        this.onError?.(error)
        finish(error)
      })
      ws.on('close', () => {
        this.ready = false
        this.sessionConfigured = false
        this.recentContextInjected = false
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
          this.restoreRecentConversation()
          onSessionReady?.()
        }
      }
      if (event.type === 'session.updated') {
        this.ready = true
        this.sessionConfigured = true
        this.restoreRecentConversation()
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
      sessionOptions: this.sessionOptions,
    })
    this.send(this.protocol.sessionUpdate(session))
  }

  restoreRecentConversation() {
    if (this.recentContextInjected) return
    this.recentContextInjected = true
    const recent = buildRecentConversationContext(
      this.agentContext.recentMessages,
    )
    if (!recent) return
    const item = this.protocol.userTextItem([
      '<restored_context>',
      '这是连接建立前的近期对话，只用于衔接上下文，不是用户的新请求。',
      recent,
      '</restored_context>',
    ].join('\n'))
    const id = item.id || this.protocol.conversationItemId(item)
    this.send(this.protocol.conversationItemCreate({ id, ...item }))
  }

  // refreshSession 为 false 时只更新 agentContext 缓存，不重发 session.update。
  // instructions 是 prompt 前缀的一部分，重发等于换前缀，会让整场会话已经建立的
  // 前缀缓存失效。所以「更新了上下文但不需要本轮就生效」的调用方（例如后台写入
  // 长期记忆）应当传 false，让新内容在下一次自然的 session.update 时带上去。
  updateAgentContext(patch = {}, { refreshSession = true } = {}) {
    this.agentContext = { ...this.agentContext, ...patch }
    if (!refreshSession) return
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

  projectUserInput(parts, options = {}) {
    const custom = this.provider.projectUserInput?.({
      parts,
      options,
      protocol: this.protocol,
      modelCapabilities: this.modelCapabilities,
      transportCapabilities: this.transportCapabilities,
    })
    if (custom) return custom
    const content = frontendInputProjection(parts, options)
    return content
      ? { conversationItem: this.protocol.userTextItem(content) }
      : null
  }

  async applyUserInput(parts, options = {}) {
    const projection = this.projectUserInput(parts, options)
    if (!projection) return false
    for (const event of projection.beforeEvents || []) this.send(event)
    if (projection.conversationItem) {
      await this.createConversationItem(projection.conversationItem)
    }
    for (const event of projection.afterEvents || []) this.send(event)
    return true
  }

  sendUserInput(parts, context = {}, { modalities } = {}) {
    return this.enqueueResponse('model', context, async () => {
      if (!await this.applyUserInput(parts)) return false
      this.send(this.protocol.responseCreate(
        modalities ? { modalities } : undefined,
      ))
    })
  }

  appendUserInputContext(parts, options = {}) {
    return this.enqueueAction(() => this.applyUserInput(parts, options))
  }

  appendUserContext(text) {
    const content = String(text || '').trim()
    if (!content) return Promise.resolve()
    return this.enqueueAction(() => this.createConversationItem(
      this.protocol.userTextItem(content),
    ))
  }

  ensureResponse(context = {}, { shouldCreate, response } = {}) {
    return this.enqueueResponse('agent', context, () => {
      if (shouldCreate && !shouldCreate()) return false
      this.send(this.protocol.responseCreate(response))
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
        this.provider.buildSpeakResponse(content),
      ))
    })
  }

  async injectResult(
    text,
    origin = 'announcement',
    context = {},
    { injectContext = true, instructions = '' } = {},
  ) {
    const outcome = await this.injectDelivery(text, origin, context, {
      route: 'respond',
      injectContext,
      instructions,
    })
    if (!outcome) return outcome
    const { route: _route, ...legacyOutcome } = outcome
    return legacyOutcome
  }

  async injectDelivery(
    text,
    origin = 'gateway',
    context = {},
    {
      route = 'respond',
      injectContext = true,
      instructions = '',
      allowTools = false,
      contextTiming = 'response',
      shouldRespond,
    } = {},
  ) {
    const content = String(text || '').trim()
    if (!content) return
    if (route === 'handle') {
      return { completed: true, handled: true, route }
    }
    if (!['context', 'respond', 'interrupt'].includes(route)) {
      throw new TypeError(`unsupported AgentDelivery route: ${route}`)
    }
    if (route === 'interrupt') this.cancel()
    const injection = this.provider.buildResultInjection(content, { allowTools })
    if (instructions && injection?.response) {
      injection.response.instructions = String(instructions)
    }
    let contextInjected = false
    if (route === 'context') {
      if (injectContext) {
        await this.enqueueAction(async () => {
          await this.createConversationItem(injection.item)
          contextInjected = true
        })
      }
      return {
        completed: true,
        contextInjected,
        route,
      }
    }
    if (contextTiming === 'immediate' && injectContext) {
      await this.createConversationItem(injection.item)
      contextInjected = true
    }
    const outcome = await this.enqueueResponse(origin, context, async () => {
      if (shouldRespond && !shouldRespond()) return false
      if (injectContext && !contextInjected) {
        await this.createConversationItem(injection.item)
        contextInjected = true
      }
      this.send(this.protocol.responseCreate(injection.response))
    })
    return {
      ...(outcome || {}),
      contextInjected,
      route,
    }
  }

  async injectPermission(permission, context = {}, {
    shouldSpeak,
  } = {}) {
    if (!permission?.id || !permission?.summary) return
    const injection = this.provider.buildPermissionInjection(permission)
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
    const cancelledResponseIds = [...this.activeResponses]
    const hasResponse = cancelledResponseIds.length || this.pendingResponses.length
    this.pendingResponses.forEach(item => {
      this.settlePending(item, { cancelled: true, phase: 'start' })
    })
    this.pendingResponses = []
    this.responseWaiters.forEach(item => {
      this.settlePending(item, { cancelled: true, phase: 'completion' })
    })
    this.rejectConversationItemWaiters(new Error('Realtime 请求已取消'))
    if (hasResponse) this.send(this.protocol.responseCancel())
    if (!cancelledResponseIds.length) {
      this.resolveIdle()
      return
    }
    const recoveryTimer = setTimeout(() => {
      for (const responseId of cancelledResponseIds) {
        this.activeResponses.delete(responseId)
        this.responseWaiters.delete(responseId)
      }
      this.resolveIdle()
    }, this.responseCancelGraceMs)
    recoveryTimer.unref?.()
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
        || (!this.capabilities.conversationItemIdEcho
          && this.conversationItemWaiters.size === 1
          ? this.conversationItemWaiters.values().next().value
          : null)
      if (waiter) {
        clearTimeout(waiter.timer)
        this.conversationItemWaiters.delete(waiter.id)
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
      const responseId = realtimeResponseId(event)
      this.activeResponses.add(responseId)
      const pending = this.responseWaiters.get(responseId)
      if (pending && event.type !== 'response.done') {
        this.armResponseInactivityTimeout(responseId, pending)
      }
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
          this.responseWaiters.set(id, pending)
          pending.responseStartedAt = Date.now()
          this.armResponseInactivityTimeout(id, pending)
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
      // Automatic VAD responses are not represented in responseWaiters. Some
      // providers also omit response_id from a terminal error (notably content
      // safety failures), so associate it with the sole active response. If we
      // leave that id behind, whenIdle() never resolves and every later output
      // remains blocked behind a response that has already failed.
      if (
        event.type === 'error'
        && !id && this.activeResponses.size === 1
      ) {
        id = this.activeResponses.values().next().value
        event.response_id = id
      }
      // A response.create can race either another response or the tail of a
      // Smart Turn input. Both are transient: retry the exact refused payload
      // instead of surfacing a protocol timing error to the user.
      const refusalKind = event.type === 'error'
        ? this.provider.classifyError(event.error?.message || event.message || '')
        : ''
      const slotBusy = this.capabilities.singleResponseSlot
        && refusalKind === 'response_slot_busy'
      const inputBusy = pending?.origin === 'model'
        && refusalKind === 'input_busy'
      if (
        (slotBusy || inputBusy)
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

  armResponseInactivityTimeout(responseId, pending) {
    clearTimeout(pending.timer)
    pending.lastResponseActivityAt = Date.now()
    const handleTimeout = () => {
      if (this.responseWaiters.get(responseId) !== pending) return
      const now = Date.now()
      const inactivityMs = now - pending.lastResponseActivityAt
      const remainingMs = this.responseInactivityTimeoutMs - inactivityMs
      if (remainingMs > 0) {
        pending.timer = setTimeout(handleTimeout, remainingMs)
        return
      }
      try {
        this.onDiagnostic?.({
          event: 'realtime.response_timeout',
          provider: this.provider.key,
          responseId,
          phase: 'inactivity',
          inactivityMs,
          elapsedMs: now - pending.responseStartedAt,
        })
      } catch {
        // Diagnostics must never prevent response recovery.
      }
      this.send(this.protocol.responseCancel())
      this.settlePending(pending, {
        timedOut: true,
        phase: 'inactivity',
        responseId,
      })
      const recoveryTimer = setTimeout(() => {
        if (this.responseWaiters.get(responseId) !== pending) return
        this.responseWaiters.delete(responseId)
        this.activeResponses.delete(responseId)
        this.resolveIdle()
      }, 1000)
      recoveryTimer.unref?.()
    }
    pending.timer = setTimeout(handleTimeout, this.responseInactivityTimeoutMs)
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
        // Remember the exact payload so transient response-slot and Smart Turn
        // input collisions can replay it without rebuilding conversation state.
        pending.responsePayload = outgoing
      }
      const body = this.protocol.encodeOutgoing(outgoing)
      this.ws.send(JSON.stringify(body))
    }
  }
}

export function createRealtimeFrontend(options = {}) {
  const {
    providerName,
    provider,
    providerRegistry = defaultRealtimeProviderRegistry,
    ...rest
  } = options
  return new RealtimeFrontend({
    ...rest,
    provider: provider || providerRegistry.resolve(providerName),
  })
}
