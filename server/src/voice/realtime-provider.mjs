import WebSocket from 'ws'
import { randomUUID } from 'crypto'
import {
  resolveRealtimeProvider,
  validateRealtimeProvider,
} from './providers/registry.mjs'

// Re-export provider-agnostic tools and instructions so existing callers
// (tests, tool-call-handler, bootstrap) continue to work without changes.
export {
  SPAWN_THINKING_TOOL_NAME,
  DELEGATE_TOOL_NAME,
  CANCEL_AGENT_TASK_TOOL_NAME,
  GET_AGENT_TASK_STATUS_TOOL_NAME,
  GET_CURRENT_TIME_TOOL_NAME,
  USER_MEMORY_TOOL_NAME,
  RESPOND_AGENT_PERMISSION_TOOL_NAME,
  TOOLS,
  buildFrontendInstructions,
} from './frontend-tools.mjs'

// Re-export registry symbols for backward compatibility.
export {
  REALTIME_PROVIDERS,
  resolveRealtimeProvider,
  describeActiveRealtime,
} from './providers/registry.mjs'

function responseId(event) {
  return event.response_id || event.response?.id || ''
}

function normalizedEvents(value) {
  if (!value) return []
  return Array.isArray(value) ? value.filter(Boolean) : [value]
}

export class RealtimeFrontend {
  constructor({
    provider = resolveRealtimeProvider(),
    onEvent,
    onError,
    onClose,
    agentContext = {},
    responseStartTimeoutMs = 30000,
    responseCompletionTimeoutMs = 120000,
  } = {}) {
    this.provider = validateRealtimeProvider(provider)
    this.protocol = provider.protocol
    if (!this.protocol) {
      throw new Error(`Realtime Provider ${provider.key || provider.label} 缺少 protocol`)
    }
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
    this.responseCompletionTimeoutMs = responseCompletionTimeoutMs
  }

  connect() {
    const apiKey = this.provider.apiKey()
    if (!apiKey) return Promise.reject(new Error(this.provider.missingKeyMessage))
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.provider.url(), {
        headers: this.provider.headers(apiKey),
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
      if (event.type === 'session.created') this.updateSession()
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
    const id = item.id || `item_${randomUUID().replaceAll('-', '')}`
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
    if (event.type === 'response.created') {
      const id = responseId(event)
      const pending = this.pendingResponses.shift()
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
      let id = responseId(event)
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
      this.ws.send(JSON.stringify(this.protocol.encodeOutgoing(payload)))
    }
  }
}

export function createRealtimeFrontend(options = {}) {
  return new RealtimeFrontend({ ...options, provider: resolveRealtimeProvider() })
}
