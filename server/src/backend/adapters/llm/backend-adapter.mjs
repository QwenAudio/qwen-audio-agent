import { defineBackendAdapter } from '../../backend-adapter-sdk.mjs'
import { backendInstructionFromWork } from '../../backend-work-input.mjs'
import { AgentError } from '../../agent-error.mjs'
import { BackendEventType, backendEvent } from '../../../core/backend-events.mjs'

const MAX_ERROR_BODY_CHARS = 4_000
const MAX_RESULT_CHARS = 1_000_000

function clean(value) {
  return String(value || '').trim()
}

function endpointFor(baseUrl) {
  const value = clean(baseUrl).replace(/\/+$/, '')
  if (!value) return ''
  let url
  try {
    url = new URL(value)
  } catch {
    throw new AgentError('LLM backend base URL must be an absolute URL', {
      status: 400,
      protocol: 'llm',
    })
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new AgentError('LLM backend base URL must use HTTP or HTTPS', {
      status: 400,
      protocol: 'llm',
    })
  }
  if (url.username || url.password) {
    throw new AgentError('LLM backend base URL must not contain credentials', {
      status: 400,
      protocol: 'llm',
    })
  }
  if (url.search || url.hash) {
    throw new AgentError('LLM backend base URL must not contain a query or fragment', {
      status: 400,
      protocol: 'llm',
    })
  }
  return `${value}/chat/completions`
}

function cancellationError(taskId, cause) {
  const error = new AgentError(`LLM backend Task ${taskId} was cancelled`, {
    status: 499,
    protocol: 'llm',
  })
  error.code = 'WORK_CANCELLED'
  if (cause !== undefined) error.cause = cause
  return error
}

function responseText(payload) {
  const content = payload?.choices?.[0]?.message?.content
  if (typeof content === 'string') return clean(content).slice(0, MAX_RESULT_CHARS)
  if (Array.isArray(content)) {
    return content
      .map(part => typeof part === 'string' ? part : part?.text)
      .map(clean)
      .filter(Boolean)
      .join('\n')
      .slice(0, MAX_RESULT_CHARS)
  }
  return clean(payload?.output_text).slice(0, MAX_RESULT_CHARS)
}

async function errorBody(response) {
  try {
    return clean(await response.text()).slice(0, MAX_ERROR_BODY_CHARS)
  } catch {
    return ''
  }
}

export class LlmBackendAdapter {
  constructor({
    apiKey = '',
    baseUrl = '',
    model = '',
    systemPrompt = '',
    timeoutMs = 300_000,
    fetchImpl = globalThis.fetch,
  } = {}) {
    this.protocol = 'llm'
    this.label = 'LLM'
    this.apiKey = clean(apiKey)
    this.baseUrl = clean(baseUrl).replace(/\/+$/, '')
    this.model = clean(model)
    this.systemPrompt = clean(systemPrompt)
    this.timeoutMs = Number.isFinite(Number(timeoutMs))
      ? Math.max(0, Number(timeoutMs))
      : 300_000
    this.fetchImpl = fetchImpl
    this.ready = false
    this.closed = false
    this.failure = null
    this.endpoint = ''
    this.active = new Map()
    this.listeners = new Set()
  }

  describe() {
    return {
      configured: Boolean(this.apiKey && this.baseUrl && this.model),
      enabled: true,
      protocol: this.protocol,
      kind: this.protocol,
      label: this.label,
      transport: 'openai-compatible-chat-completions',
      model: this.model || null,
      capabilities: {
        cancel: true,
        authorization: false,
        inputRequests: false,
        taskUpdates: 'activity',
        nativeSessionHistory: false,
        backendUi: false,
        delegation: false,
        sessionMcp: false,
      },
    }
  }

  runtimeStatus() {
    return {
      ok: this.ready && !this.closed,
      status: this.ready && !this.closed
        ? 'ready'
        : this.closed ? 'stopped' : this.failure ? 'failed' : 'not_started',
      protocol: this.protocol,
      ...(this.failure ? { error: clean(this.failure.message || this.failure) } : {}),
    }
  }

  async start() {
    if (this.closed) {
      throw new AgentError('LLM backend adapter is closed', {
        status: 503,
        protocol: this.protocol,
      })
    }
    if (this.ready) return this.runtimeStatus()
    try {
      if (!this.apiKey) {
        throw new AgentError('LLM backend API key is not configured', {
          status: 503,
          protocol: this.protocol,
        })
      }
      if (!this.model) {
        throw new AgentError('LLM backend model is not configured', {
          status: 503,
          protocol: this.protocol,
        })
      }
      if (typeof this.fetchImpl !== 'function') {
        throw new AgentError('LLM backend requires a Fetch API implementation', {
          status: 503,
          protocol: this.protocol,
        })
      }
      this.endpoint = endpointFor(this.baseUrl)
      if (!this.endpoint) {
        throw new AgentError('LLM backend base URL is not configured', {
          status: 503,
          protocol: this.protocol,
        })
      }
      this.ready = true
      this.failure = null
      return this.runtimeStatus()
    } catch (error) {
      this.ready = false
      this.failure = error
      throw error
    }
  }

  async health() {
    if (!this.ready && !this.closed) {
      try {
        await this.start()
      } catch {
        return this.runtimeStatus()
      }
    }
    return this.runtimeStatus()
  }

  publish(event, task) {
    try {
      task?.onEvent?.(event)
    } catch {
      // A per-Task observer must not interrupt model execution.
    }
    const published = {
      ...event,
      taskId: task?.taskId || null,
      ownerId: task?.ownerId || null,
    }
    for (const listener of this.listeners) {
      try {
        listener(published)
      } catch {
        // Subscribers are isolated from the adapter and one another.
      }
    }
  }

  subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('Backend listener must be a function')
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async submit(work, { signal, onEvent } = {}) {
    const taskId = clean(work?.id)
    const ownerId = clean(work?.ownerId)
    const instruction = backendInstructionFromWork(work)
    if (!taskId || !ownerId || !instruction) {
      throw new AgentError('Backend submit requires task id, owner and input', {
        status: 400,
        protocol: this.protocol,
      })
    }
    if (this.active.has(taskId)) {
      throw new AgentError(`Task ${taskId} is already active`, {
        status: 409,
        protocol: this.protocol,
      })
    }
    if (signal?.aborted) throw cancellationError(taskId, signal.reason)
    const controller = new AbortController()
    const timeoutSignal = this.timeoutMs > 0
      ? AbortSignal.timeout(this.timeoutMs)
      : null
    const workSignal = AbortSignal.any(
      [signal, controller.signal, timeoutSignal].filter(Boolean),
    )
    const task = {
      taskId,
      ownerId,
      onEvent,
      controller,
      signal: workSignal,
      activity: {
        id: 'llm-status',
        kind: 'status',
        status: 'running',
        label: 'LLM request started',
      },
    }
    this.active.set(taskId, task)
    try {
      await this.start()
      workSignal.throwIfAborted()
      this.publish(backendEvent(BackendEventType.ACTIVITY, {
        activity: task.activity,
      }), task)
      const response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            ...(this.systemPrompt ? [{ role: 'system', content: this.systemPrompt }] : []),
            { role: 'user', content: instruction },
          ],
          stream: false,
        }),
        signal: workSignal,
      })
      workSignal.throwIfAborted()
      if (!response?.ok) {
        const body = await errorBody(response)
        throw new AgentError(
          `LLM backend request failed with HTTP ${response?.status || 0}`,
          {
            status: response?.status || 502,
            body,
            protocol: this.protocol,
          },
        )
      }
      let payload
      try {
        payload = await response.json()
      } catch (cause) {
        throw new AgentError('LLM backend returned invalid JSON', {
          status: 502,
          body: clean(cause?.message),
          protocol: this.protocol,
        })
      }
      const content = responseText(payload)
      if (!content) {
        throw new AgentError('LLM backend returned an empty response', {
          status: 502,
          protocol: this.protocol,
        })
      }
      task.activity = { ...task.activity, status: 'completed', label: 'LLM request completed' }
      this.publish(backendEvent(BackendEventType.ACTIVITY, {
        activity: task.activity,
      }), task)
      return { content, artifacts: [] }
    } catch (error) {
      if (workSignal.aborted) {
        if (timeoutSignal?.aborted && !controller.signal.aborted && !signal?.aborted) {
          throw new AgentError('LLM backend request timed out', {
            status: 504,
            protocol: this.protocol,
          })
        }
        throw cancellationError(taskId, error)
      }
      if (error instanceof AgentError) throw error
      throw new AgentError(
        `LLM backend request failed: ${clean(error?.message || error) || 'unknown network error'}`,
        {
          status: 502,
          body: clean(error?.message || error).slice(0, MAX_ERROR_BODY_CHARS),
          protocol: this.protocol,
        },
      )
    } finally {
      if (this.active.get(taskId) === task) this.active.delete(taskId)
    }
  }

  status(taskId, { ownerId } = {}) {
    const id = clean(taskId)
    if (!id) return this.runtimeStatus()
    const task = this.active.get(id)
    if (!task || (ownerId && clean(ownerId) !== task.ownerId)) {
      return { taskId: id, state: 'not_found', activity: [] }
    }
    return { taskId: id, state: 'working', activity: [task.activity] }
  }

  async cancel(taskId, { ownerId } = {}) {
    const id = clean(taskId)
    const task = this.active.get(id)
    if (!task) return { taskId: id, state: 'not_found' }
    if (ownerId && clean(ownerId) !== task.ownerId) {
      throw new AgentError('Cannot cancel LLM work owned by another user', {
        status: 404,
        protocol: this.protocol,
      })
    }
    task.controller.abort(cancellationError(id))
    return { taskId: id, state: 'cancelled' }
  }

  async respondAuthorization() {
    throw new AgentError('LLM backend does not support authorization requests', {
      status: 501,
      protocol: this.protocol,
    })
  }

  async respondInput() {
    throw new AgentError('LLM backend does not support input requests', {
      status: 501,
      protocol: this.protocol,
    })
  }

  async close() {
    if (this.closed) return
    this.closed = true
    for (const task of this.active.values()) {
      task.controller.abort(cancellationError(task.taskId))
    }
    this.active.clear()
    this.listeners.clear()
    this.ready = false
  }
}

export function createLlmBackendAdapter(options) {
  return defineBackendAdapter(new LlmBackendAdapter(options), {
    name: 'LLM backend adapter',
  })
}

export const LLM_BACKEND_ADAPTER_VERSION = '1.0.0'
