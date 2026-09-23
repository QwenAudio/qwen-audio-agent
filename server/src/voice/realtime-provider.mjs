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
import { RealtimeConfigurationError } from './realtime-errors.mjs'
import { RealtimeResponseSlot } from './realtime-response-slot.mjs'

// Re-export provider-agnostic tools and instructions so existing callers
// (tests, tool-call-handler, bootstrap) continue to work without changes.
export {
  SPAWN_THINKING_TOOL_NAME,
  SCHEDULE_REMINDER_TOOL_NAME,
  CANCEL_AGENT_TASK_TOOL_NAME,
  GET_AGENT_TASK_STATUS_TOOL_NAME,
  GET_CURRENT_TIME_TOOL_NAME,
  NOTES_TOOL_NAME,
  RESPOND_PERMISSION_TOOL_NAME,
  TOOLS,
  frontendToolRegistry,
  frontendTools,
  buildFrontendInstructions,
} from '../frontend/frontend-tools.mjs'

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

function matchesConversationItem(expected, received) {
  if (!received || expected.type !== received.type) return false
  if (expected.type === 'function_call_output') return expected.call_id === received.call_id
  if (expected.type !== 'message' || expected.role !== received.role) return false
  // Ignore automatically created microphone/assistant items on the same socket.
  const text = item => (item.content || []).map(part => part.text || '').join('')
  return text(expected) !== '' && text(expected) === text(received)
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
  // Refuses concurrent response.create requests instead of queueing them.
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
  // Acknowledges conversation.item.create with conversation.item.created.
  acknowledgesConversationItems: true,
  // Allows the Gateway to inject pre-connection context as a conversation item.
  restoreConversationContext: true,
  // Accepts conversation.item.create and acknowledges created items.
  conversationItems: true,
  // Accepts response.create and response.cancel initiated by the client.
  clientResponses: true,
  // Allows session instructions to be refreshed after initial setup.
  mutableSession: true,
  // Requires an audio timeline before accepting the first visual frame.
  imageRequiresAudioStart: false,
})
const DEFAULT_RESPONSE_CANCEL_GRACE_MS = 1_000

export class RealtimeFrontend {
  constructor({
    provider = resolveRealtimeProvider(),
    onEvent,
    onError,
    onClose,
    onDiagnostic,
    onResponseSettled,
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
    this.onResponseSettled = onResponseSettled
    this.agentContext = agentContext
    this.sessionOptions = sessionOptions
    this.ws = null
    this.ready = false
    this.sessionConfigured = false
    this.recentContextInjected = false
    this.restoringContext = false
    this.audioInputStarted = false
    this.activeResponses = new Set()
    this.pendingResponses = []
    this.retryingResponses = new Set()
    this.responseWaiters = new Map()
    this.conversationItemWaiters = new Map()
    this.conversationItemQueue = Promise.resolve()
    this.conversationItemGeneration = 0
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
    this.responseSlot = new RealtimeResponseSlot({
      waitMs: this.responseStartTimeoutMs,
      cancelMs: this.responseCancelGraceMs,
      cancel: () => this.send(this.protocol.responseCancel()),
      disconnect: () => {
        // Closing uses the existing session reconnect/context restoration path.
        this.ready = false
        this.resetResponses()
        this.ws?.terminate?.()
      },
      diagnostic: phase => this.diagnose({
        event: 'realtime.response_slot_recovery', provider: this.provider.key, phase,
      }),
    })
  }

  diagnose(event) {
    try { this.onDiagnostic?.(event) } catch { /* Logging is not control flow. */ }
  }

  connect() {
    if (this.modelProfile?.family === 'unknown') {
      return Promise.reject(new RealtimeConfigurationError(
        `不支持的 Realtime 模型：${this.modelProfile.id}`
        + `（${this.provider.label}）`,
      ))
    }
    if (!this.provider.isConfigured()) {
      return Promise.reject(new RealtimeConfigurationError(this.provider.missingConfigurationMessage))
    }
    try {
      this.provider.validateSessionOptions?.({ sessionOptions: this.sessionOptions })
    } catch (error) {
      return Promise.reject(error)
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
      }, this.provider.connectTimeoutMs ?? 25000)
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
              agentContext: this.agentContext,
              sessionOptions: this.sessionOptions,
              session: this.provider.buildSession({
                configured: false,
                agentContext: this.agentContext,
                sessionOptions: this.sessionOptions,
              }),
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
            onSessionError: error => {
              if (!error.realtimeEvent) this.onError?.(error)
              finish(error)
              ws.terminate()
            },
          })
        } catch (error) {
          this.onError?.(error)
          finish(error)
          ws.terminate()
        }
      })
    })
  }

  handleProviderEvent(providerEvent, { onSessionReady, onSessionError } = {}) {
    const events = normalizedEvents(
      this.protocol.normalizeIncoming(providerEvent),
    )
    for (const event of events) {
      if (event.type === 'error' && this.restoringContext) {
        event.__voiceOrigin = 'restore'
      }
      if (event.type === 'error' && !this.sessionConfigured) {
        const error = new Error(realtimeEventErrorMessage(event))
        error.realtimeEvent = true
        throw error
      }
      if (event.type === 'session.created') {
        this.updateSession()
        if (!this.capabilities.acknowledgesSessionUpdate) {
          this.completeSessionSetup(onSessionReady, onSessionError)
        }
      }
      if (event.type === 'session.updated') {
        this.completeSessionSetup(onSessionReady, onSessionError)
      }
      this.handleLifecycle(event)
      this.onEvent?.(event)
    }
    return events
  }

  completeSessionSetup(onReady, onError) {
    if (this.sessionConfigured) return
    this.sessionConfigured = true
    const ready = () => {
      if (!this.sessionConfigured) return // Closed during context restoration.
      this.ready = true
      onReady?.()
    }
    const restoration = this.restoreRecentConversation()
    if (restoration) restoration.then(ready, error => onError?.(error))
    else ready()
  }

  updateSession() {
    if (this.sessionConfigured && !this.capabilities.mutableSession) return
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
    if (!this.capabilities.conversationItems) return
    if (!this.capabilities.restoreConversationContext) return
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
    this.restoringContext = true
    return this.createConversationItem(item).finally(() => {
      this.restoringContext = false
    })
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
    this.audioInputStarted = true
  }

  appendImage(image) {
    if (this.transportCapabilities?.imageBufferInput !== true) {
      return false
    }
    if (this.capabilities.imageRequiresAudioStart && !this.audioInputStarted) {
      // Establish the provider timeline with 20 ms of PCM16 silence. Video
      // must not require opening a muted microphone or wait for user speech.
      const samples = Math.ceil(this.provider.inputSampleRate * 0.02)
      this.appendAudio(Buffer.alloc(samples * 2).toString('base64'))
    }
    this.send(this.protocol.imageAppend(image))
    return true
  }

  clearPendingImage() {
    this.protocol.clearImageBuffer?.()
  }

  setInputMuted(muted) {
    if (!this.ready) return
    this.send(muted
      ? this.protocol.inputMute?.()
      : this.protocol.inputUnmute?.())
  }

  sendUserText(text, context = {}, { modalities } = {}) {
    const content = String(text || '').trim()
    if (!content) return Promise.resolve()
    if (!this.capabilities.conversationItems || !this.capabilities.clientResponses) {
      return Promise.reject(new Error(
        `${this.provider.label} 不支持文本输入`,
      ))
    }
    return this.enqueueResponse('model', context, async () => {
      await this.createConversationItem(this.protocol.userTextItem(content), { contextOnly: false })
      return this.sendResponse(
        modalities ? { modalities } : undefined,
      )
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
      await this.createConversationItem(projection.conversationItem, {
        contextOnly: options.contextOnly !== false,
      })
    }
    for (const event of projection.afterEvents || []) this.send(event)
    return true
  }

  sendUserInput(parts, context = {}, { modalities } = {}) {
    if (!this.capabilities.conversationItems || !this.capabilities.clientResponses) {
      return Promise.reject(new Error(
        `${this.provider.label} 不支持离散文本或文件输入`,
      ))
    }
    return this.enqueueResponse('model', context, async () => {
      if (!await this.applyUserInput(parts, { contextOnly: false })) return false
      return this.sendResponse(
        modalities ? { modalities } : undefined,
      )
    })
  }

  appendUserInputContext(parts, options = {}) {
    if (!this.capabilities.conversationItems) return Promise.resolve(false)
    return this.enqueueAction(() => this.applyUserInput(parts, options))
  }

  appendUserContext(text) {
    const content = String(text || '').trim()
    if (!content) return Promise.resolve()
    if (!this.capabilities.conversationItems) return Promise.resolve(false)
    return this.enqueueAction(() => this.createConversationItem(
      this.protocol.userTextItem(content),
    ))
  }

  ensureResponse(context = {}, { shouldCreate, response } = {}) {
    if (!this.capabilities.clientResponses) {
      return Promise.resolve({ skipped: true, unsupported: true })
    }
    return this.enqueueResponse('agent', context, pending => {
      pending.isCurrent = shouldCreate
      if (shouldCreate && !shouldCreate()) return false
      return this.sendResponse(response)
    })
  }

  sendFunctionOutput(callId, output, context = {}, {
    createResponse = true,
    response,
    shouldRespond,
  } = {}) {
    if (!this.capabilities.conversationItems) {
      return Promise.reject(new Error(
        `${this.provider.label} 不支持 Function Call 结果回注`,
      ))
    }
    const sendOutput = () => this.createConversationItem(
      this.protocol.functionOutputItem(callId, output),
    )
    if (!createResponse) return this.enqueueAction(sendOutput)
    return this.enqueueResponse('agent', context, async pending => {
      pending.isCurrent = shouldRespond
      await sendOutput()
      return this.sendResponse(response)
    })
  }

  createConversationItem(item, { contextOnly = true } = {}) {
    if (!this.capabilities.conversationItems) {
      return Promise.reject(new Error(
        `${this.provider.label} 不支持创建对话项`,
      ))
    }
    if (this.capabilities.conversationItemIdEcho) return this.sendConversationItem(item, { contextOnly })
    // Without echoed IDs, only one client-created item may await a receipt.
    // This queue is independent of responses: permissions/environment context
    // can still arrive while speech is being generated.
    const generation = this.conversationItemGeneration
    const send = () => {
      if (generation !== this.conversationItemGeneration) {
        throw new Error('Realtime 会话已重置')
      }
      return this.sendConversationItem(item, { contextOnly })
    }
    const result = this.conversationItemQueue.then(send, send)
    this.conversationItemQueue = result.catch(() => {})
    return result
  }

  sendConversationItem(item, { contextOnly = true } = {}) {
    // Id namespaces are dialect-specific (the GA dialect derives them from the
    // item type), so the protocol adapter mints the id.
    const id = item.id || this.protocol.conversationItemId(item)
    return new Promise((resolve, reject) => {
      const waiter = {
        id,
        item,
        resolve,
        reject,
        timer: setTimeout(() => {
          if (this.conversationItemWaiters.get(id) !== waiter) return
          this.conversationItemWaiters.delete(id)
          reject(new Error(`${this.provider.label} 未确认对话项 ${id}`))
          if (!this.capabilities.conversationItemIdEcho) {
            // A late anonymous receipt must not acknowledge the next item.
            this.ready = false
            this.resetResponses()
            this.ws?.terminate?.()
          }
        }, this.responseStartTimeoutMs),
      }
      this.conversationItemWaiters.set(id, waiter)
      waiter.eventId = this.send(this.protocol.conversationItemCreate({ id, ...item }, { contextOnly }))?.event_id
      if (!this.capabilities.acknowledgesConversationItems) {
        clearTimeout(waiter.timer)
        this.conversationItemWaiters.delete(id)
        resolve({ id, ...item })
      }
    })
  }

  speak(text, origin = 'agent', context = {}, {
    shouldSpeak,
  } = {}) {
    const content = String(text || '').trim()
    if (!content) return Promise.resolve()
    if (!this.capabilities.clientResponses) {
      return Promise.resolve({ skipped: true, unsupported: true })
    }
    return this.enqueueResponse(origin, context, pending => {
      pending.isCurrent = shouldSpeak
      if (shouldSpeak && !shouldSpeak()) return false
      return this.sendResponse(
        this.provider.buildSpeakResponse(content),
      )
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
    if (!this.capabilities.conversationItems || !this.capabilities.clientResponses) {
      return {
        completed: false,
        skipped: true,
        unsupported: true,
        contextInjected: false,
        route,
      }
    }
    if (route === 'handle') {
      return { completed: true, handled: true, route }
    }
    if (!['context', 'respond', 'interrupt'].includes(route)) {
      throw new TypeError(`unsupported AgentDelivery route: ${route}`)
    }
    if (route === 'interrupt') this.cancel()
    const injection = this.provider.buildResultInjection(content, { allowTools })
    const generation = this.responseQueueGeneration
    if (instructions && injection?.response) {
      injection.response.instructions = String(instructions)
    }
    let contextInjected = false
    if (contextTiming === 'immediate' && injectContext) {
      await this.createConversationItem(injection.item)
      contextInjected = true
    }
    if (route === 'context') {
      if (injectContext && !contextInjected) {
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
    if (generation !== this.responseQueueGeneration) {
      return { cancelled: true, contextInjected, route }
    }
    const outcome = await this.enqueueResponse(origin, context, async pending => {
      pending.isCurrent = shouldRespond
      if (shouldRespond && !shouldRespond()) return false
      if (injectContext && !contextInjected) {
        await this.createConversationItem(injection.item)
        contextInjected = true
      }
      return this.sendResponse(injection.response)
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
    if (!this.capabilities.conversationItems || !this.capabilities.clientResponses) {
      return { skipped: true, unsupported: true }
    }
    const injection = this.provider.buildPermissionInjection(permission)
    const generation = this.responseQueueGeneration
    // Make the permission identity available to the model immediately. The
    // spoken question may wait behind an active response, while the user can
    // already see the actionable permission event in TUI/WebUI and answer it.
    await this.createConversationItem(injection.item)
    if (generation !== this.responseQueueGeneration) return { cancelled: true }
    return this.enqueueResponse('permission', context, pending => {
      pending.isCurrent = shouldSpeak
      if (pending.settled || (shouldSpeak && !shouldSpeak())) return false
      return this.sendResponse(injection.response)
    })
  }

  async sendResponse(response) {
    const pending = this.pendingResponses.at(-1)
    if (!pending || pending.settled) return false
    // A dialect may need a conversation item instead of transient response
    // instructions. Wait for its acknowledgement before triggering inference.
    const item = this.protocol.responseInstructionsItem?.(response)
    if (item) await this.createConversationItem(item)
    // An automatic response may have started while the input/context receipt
    // was in flight. Recheck immediately before sending, not just on enqueue.
    await this.whenIdle()
    if (!this.ready || pending.settled || pending.isCurrent?.() === false) return false
    pending.responseRequested = true
    this.send(this.protocol.responseCreate(response))
  }

  cancel() {
    this.responseQueueGeneration += 1
    const cancelledResponseIds = [...this.activeResponses]
    const hasResponse = cancelledResponseIds.length
      || this.pendingResponses.some(pending => pending.responseRequested)
      || this.responseSlot.blocked
    this.pendingResponses.forEach(item => {
      this.settlePending(item, { cancelled: true, phase: 'start' })
    })
    this.pendingResponses = []
    for (const pending of this.retryingResponses) {
      this.settlePending(pending, { cancelled: true, phase: 'start' })
    }
    this.responseWaiters.forEach(item => {
      this.settlePending(item, { cancelled: true, phase: 'completion' })
    })
    // response.cancel does not cancel conversation.item.create. Keep its
    // receipt pending so late acknowledgements cannot consume a newer item.
    if (hasResponse && this.capabilities.clientResponses) {
      if (this.capabilities.singleResponseSlot) this.responseSlot.recover()
      else this.send(this.protocol.responseCancel())
    }
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
    let cancelledRequested = false
    for (const pending of this.pendingResponses) {
      if (!matches(pending)) {
        retained.push(pending)
        continue
      }
      cancelledRequested ||= pending.responseRequested
      this.settlePending(pending, { cancelled: true, phase: 'start' })
    }
    this.pendingResponses = retained
    for (const pending of this.retryingResponses) {
      if (matches(pending)) this.settlePending(pending, { cancelled: true, phase: 'start' })
    }
    let cancelledActive = false
    for (const pending of this.responseWaiters.values()) {
      if (!matches(pending)) continue
      cancelledActive = true
      this.settlePending(pending, {
        cancelled: true,
        phase: 'completion',
      })
    }
    if ((cancelledActive || cancelledRequested) && this.capabilities.clientResponses) {
      if (this.capabilities.singleResponseSlot) this.responseSlot.recover()
      else this.send(this.protocol.responseCancel())
    }
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
        responseRequested: false,
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
      if (!pending.settled && this.pendingResponses.includes(pending)) {
        this.armResponseStartTimeout(pending)
      }
      return outcome
    }
    this.outputQueue = this.outputQueue.then(run, run)
    return this.outputQueue
  }

  handleLifecycle(event) {
    if (event.type === 'error'
      && this.provider.classifyError(realtimeEventErrorMessage(event)) === 'no_active_response') {
      // This acknowledges cancellation; it must not reject an unrelated item.
      if (this.responseSlot.phase === 'cancelling') {
        this.activeResponses.clear()
        this.responseWaiters.clear()
        this.responseSlot.release()
        this.resolveIdle()
      }
      return
    }
    // A rejected response.create is not a failed conversation item or a
    // terminal event for the response already occupying the slot.
    if (event.type === 'error' && this.handleResponseRefusal(event)) return
    if (event.type === 'conversation.item.created') {
      const id = event.item?.id
      const candidate = this.conversationItemWaiters.values().next().value
      const waiter = this.conversationItemWaiters.get(id)
        || (!this.capabilities.conversationItemIdEcho
          && this.conversationItemWaiters.size === 1
          && matchesConversationItem(candidate.item, event.item)
          ? candidate
          : null)
      if (waiter) {
        clearTimeout(waiter.timer)
        this.conversationItemWaiters.delete(waiter.id)
        waiter.resolve(event.item)
      }
    }
    if (event.type === 'error' && this.conversationItemWaiters.size) {
      const requestId = event.error?.event_id
      const waiter = requestId
        ? [...this.conversationItemWaiters.values()].find(item => item.eventId === requestId)
        : this.conversationItemWaiters.size === 1 && !this.activeResponses.size
          && !this.pendingResponses.some(pending => pending.responseRequested)
          ? this.conversationItemWaiters.values().next().value : null
      if (waiter) {
        clearTimeout(waiter.timer)
        this.conversationItemWaiters.delete(waiter.id)
        const error = new Error(
          realtimeEventErrorMessage(event, `${this.provider.label} 创建对话项失败`),
        )
        error.realtimeEvent = true
        waiter.reject(error)
        return
      }
    }
    if (isResponseActivityEvent(event)) {
      const responseId = realtimeResponseId(event)
      if (this.responseSlot.phase === 'cancelling') {
        event.__voiceContext = { suppressed: true }
      } else if (event.type !== 'response.done') {
        // The previously invisible server response now has an ID. Its actual
        // lifecycle, not the pending-start timeout, owns the slot from here.
        this.responseSlot.release()
      }
      this.activeResponses.add(responseId)
      const pending = this.responseWaiters.get(responseId)
      if (pending && event.type !== 'response.done') {
        if (!pending.outputStarted && pending.isCurrent?.() === false) {
          event.__voiceContext = { ...pending.context, suppressed: true }
        } else if (['response.audio.delta', 'response.output_audio.delta',
          'response.text.delta', 'response.output_text.delta'].includes(event.type)) {
          // Do not truncate speech already delivered just because the task
          // finishes mid-sentence. Only a not-yet-presented receipt expires.
          pending.outputStarted = true
        }
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
        const index = this.pendingResponses.findIndex(item => item.responseRequested)
        if (index >= 0) pending = this.pendingResponses.splice(index, 1)[0]
      }
      clearTimeout(pending?.timer)
      event.__voiceOrigin = pending?.origin || 'model'
      event.__voiceContext = { ...(pending?.context || {}), ...event.__voiceContext }
      if (pending?.isCurrent?.() === false) event.__voiceContext = { ...pending.context, suppressed: true }
      if (id) {
        this.activeResponses.add(id)
        if (pending) {
          this.responseWaiters.set(id, pending)
          pending.responseStartedAt = Date.now()
          this.armResponseInactivityTimeout(id, pending)
        }
      }
      this.diagnose({
        event: 'realtime.response_started', provider: this.provider.key,
        responseId: id, origin: event.__voiceOrigin, requestId: pending?.requestId,
        ...(pending?.requestedAt ? { waitMs: Date.now() - pending.requestedAt } : {}),
      })
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
      event.__voiceOrigin = pending?.origin || event.__voiceOrigin
      event.__voiceContext = { ...(pending?.context || {}), ...event.__voiceContext }
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
      if (event.type === 'response.done') this.responseSlot.release()
      this.resolveIdle()
    }
  }

  handleResponseRefusal(event) {
    const kind = this.provider.classifyError(realtimeEventErrorMessage(event))
    if (kind !== 'response_slot_busy' && kind !== 'input_busy') return false
    if (kind === 'response_slot_busy' && this.capabilities.singleResponseSlot && !this.activeResponses.size) {
      this.responseSlot.occupy()
    }
    let pending = this.pendingResponses.find(item => item.responseRequested)
    // Metadata-free providers can announce an automatic response before
    // refusing ours. Undo that FIFO association, but keep the response alive.
    if (!pending && !this.capabilities.responseMetadataCorrelation && this.responseWaiters.size === 1) {
      pending = this.responseWaiters.values().next().value
    }
    if (pending) {
      this.pendingResponses = this.pendingResponses.filter(item => item !== pending)
      for (const [id, item] of this.responseWaiters) {
        if (item === pending) this.responseWaiters.delete(id)
      }
      clearTimeout(pending.timer)
      event.__voiceOrigin = pending.origin
      event.__voiceContext = pending.context
    }
    const retry = Boolean(pending && !pending.settled && pending.responsePayload
      && (pending.busyRetries || 0) < 3
      && (kind === 'response_slot_busy' ? this.capabilities.singleResponseSlot : pending.origin === 'model'))
    try {
      this.onDiagnostic?.({
        event: 'realtime.response_refused', provider: this.provider.key,
        classification: kind, origin: pending?.origin || '',
        retry, attempt: (pending?.busyRetries || 0) + 1,
        activeResponses: this.activeResponses.size,
      })
    } catch { /* Diagnostics must not affect response scheduling. */ }
    if (retry) {
      pending.busyRetries = (pending.busyRetries || 0) + 1
      event.__voiceRetried = true
      this.retryRefusedResponse(pending, kind)
    } else {
      this.settlePending(pending, { failed: true, phase: 'start' })
    }
    return true
  }

  armResponseStartTimeout(pending) {
    pending.timer = setTimeout(() => {
      const index = this.pendingResponses.indexOf(pending)
      if (index < 0) return
      this.pendingResponses.splice(index, 1)
      this.diagnose({
        event: 'realtime.response_timeout', provider: this.provider.key,
        requestId: pending.requestId, origin: pending.origin, phase: 'start',
      })
      if (this.capabilities.singleResponseSlot) this.responseSlot.recover()
      this.settlePending(pending, { timedOut: true, phase: 'start' })
    }, this.responseStartTimeoutMs)
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
      if (this.capabilities.singleResponseSlot) this.responseSlot.recover()
      else this.send(this.protocol.responseCancel())
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
    pending.cancelRetryDelay?.()
    this.retryingResponses.delete(pending)
    pending.resolve(outcome)
    try {
      this.onResponseSettled?.({ origin: pending.origin, context: pending.context, outcome })
    } catch { /* Observer failures must not stall the queue. */ }
  }

  // Re-issues a response.create refused by an occupied single response slot.
  // Two constraints shape this implementation:
  // 1. It must NOT be scheduled through outputQueue: the refused response's
  //    outcome promise is what the queue tail awaits, so queueing the retry
  //    behind it deadlocks the whole pipeline.
  // 2. Occupied slots wait for a terminal event (or cancellation recovery),
  //    even before response.created. Only input-busy uses bounded backoff.
  retryRefusedResponse(pending, kind) {
    const generation = this.responseQueueGeneration
    this.retryingResponses.add(pending)
    const delays = [1200, 2600, 5000]
    const delay = delays[Math.min(pending.busyRetries - 1, delays.length - 1)]
    const attempt = async () => {
      if (kind === 'response_slot_busy' || this.activeResponses.size) {
        await this.whenIdle()
      } else {
        await new Promise(resolve => {
          const timer = setTimeout(resolve, delay)
          pending.cancelRetryDelay = () => { clearTimeout(timer); resolve() }
        })
        pending.cancelRetryDelay = null
        await this.whenIdle()
      }
      if (pending.settled || !this.ready || generation !== this.responseQueueGeneration) {
        this.settlePending(pending, { cancelled: true, phase: 'start' })
        return
      }
      if (pending.isCurrent?.() === false) {
        this.settlePending(pending, { skipped: true, phase: 'superseded' })
        return
      }
      if (this.pendingResponses.length) {
        this.settlePending(pending, { failed: true, phase: 'correlation' })
        return
      }
      this.retryingResponses.delete(pending)
      this.pendingResponses.push(pending)
      pending.responseRequested = true
      this.send(pending.responsePayload)
      if (!pending.settled && this.pendingResponses.includes(pending)) {
        this.armResponseStartTimeout(pending)
      }
    }
    attempt().catch(() => {
      this.settlePending(pending, { failed: true, phase: 'start' })
    })
  }

  async whenIdle() {
    while (this.responseSlot.blocked || this.activeResponses.size) {
      if (this.responseSlot.blocked) await this.responseSlot.wait()
      else await new Promise(resolve => this.idleWaiters.push(resolve))
    }
  }

  resolveIdle() {
    if (this.activeResponses.size) return
    while (this.idleWaiters.length) this.idleWaiters.shift()?.()
  }

  resetResponses() {
    this.responseQueueGeneration += 1
    this.activeResponses.clear()
    this.responseSlot.release()
    this.rejectConversationItemWaiters(new Error('Realtime 会话已重置'))
    this.pendingResponses.forEach(item => this.settlePending(item, { cancelled: true }))
    for (const pending of this.retryingResponses) this.settlePending(pending, { cancelled: true })
    this.responseWaiters.forEach(item => this.settlePending(item, { cancelled: true }))
    this.pendingResponses = []
    this.responseWaiters.clear()
    this.resolveIdle()
  }

  rejectConversationItemWaiters(error) {
    this.conversationItemGeneration += 1
    this.conversationItemWaiters.forEach(waiter => {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    })
    this.conversationItemWaiters.clear()
  }

  close() {
    if (this.ws?.readyState === WebSocket.OPEN && this.protocol.sessionClose) {
      this.send(this.protocol.sessionClose('client_closed'))
    }
    this.ws?.close()
    this.ws = null
    this.ready = false
    this.sessionConfigured = false
    this.audioInputStarted = false
    this.resetResponses()
  }

  send(payload) {
    if (!payload) return
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
        pending.requestedAt = Date.now()
        this.diagnose({
          event: 'realtime.response_requested', provider: this.provider.key,
          requestId: pending.requestId, origin: pending.origin,
          turnId: pending.context?.turnId, taskId: pending.context?.taskId,
          attempt: (pending.busyRetries || 0) + 1,
        })
      }
      const body = this.protocol.encodeOutgoing(outgoing)
      if (body == null) return
      this.ws.send(JSON.stringify(body))
      return body
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
