import { randomUUID } from 'node:crypto'
import { AgentError } from './backend-adapter.mjs'
import { BackendEventType, backendEvent } from '../core/backend-events.mjs'
import {
  InputRequestStatus,
  normalizeInputRequest,
  resolveInputRequest,
} from '../core/work-input-request.mjs'

function clean(value) {
  return String(value || '').trim()
}

function deferred() {
  let resolvePromise
  const promise = new Promise(resolve => { resolvePromise = resolve })
  return { promise, resolve: resolvePromise }
}

function responseContent(record, response = {}) {
  if (response.values && typeof response.values === 'object') {
    return Object.fromEntries(Object.entries(response.values)
      .slice(0, 64)
      .flatMap(([key, value]) => {
        if (['string', 'number', 'boolean'].includes(typeof value)) {
          return [[clean(key).slice(0, 160), value]]
        }
        if (Array.isArray(value) && value.every(item => typeof item === 'string')) {
          return [[clean(key).slice(0, 160), value.slice(0, 64)]]
        }
        return []
      })
      .filter(([key]) => key))
  }
  const text = clean(response.text)
  if (!text) return {}
  const properties = Object.keys(record.params?.requestedSchema?.properties || {})
  return properties.length === 1 ? { [properties[0]]: text } : { response: text }
}

/** Bridges ACP elicitation onto BackendPort's protocol-neutral input API. */
export class InputBroker {
  constructor({ protocol, resolvedLimit = 200 }) {
    this.protocol = protocol
    this.resolvedLimit = resolvedLimit
    this.pending = new Map()
    this.resolved = new Map()
  }

  async request(params, { signal, session } = {}) {
    const id = `input_${randomUUID().replaceAll('-', '')}`
    const pending = deferred()
    const mode = params?.mode === 'url'
      ? 'url'
      : params?.mode === 'form' ? 'form' : 'text'
    const input = normalizeInputRequest({
      id,
      taskId: session?.coordinationRunId || null,
      status: InputRequestStatus.PENDING,
      kind: 'input',
      mode,
      prompt: params?.message,
      ...(mode === 'form' && params?.requestedSchema
        ? { schema: params.requestedSchema }
        : {}),
      ...(mode === 'url' && params?.url ? { url: params.url } : {}),
    })
    if (!input) return { action: 'cancel' }
    const record = {
      ...input,
      ownerId: clean(session?.ownerId),
      permissionScopeId: clean(session?.permissionScopeId),
      params,
      pending,
      onEvent: session?.onEvent,
    }
    this.pending.set(id, record)
    record.onEvent?.(backendEvent(BackendEventType.INPUT_REQUESTED, { input }))
    signal?.addEventListener('abort', () => this.cancel(record), { once: true })
    return pending.promise
  }

  cancel(record) {
    if (!record || !this.pending.delete(record.id)) return false
    record.pending.resolve({ action: 'cancel' })
    record.onEvent?.(backendEvent(BackendEventType.INPUT_RESOLVED, {
      input: resolveInputRequest(record, InputRequestStatus.CANCELLED),
    }))
    return true
  }

  respond(id, response = {}, { ownerId } = {}) {
    const key = clean(id)
    const record = this.pending.get(key)
    if (!record) {
      const resolved = this.resolved.get(key)
      if (resolved?.ownerId === clean(ownerId)) return resolved.input
    }
    if (!record || record.ownerId !== clean(ownerId)) {
      throw new AgentError('输入请求不存在、已经失效或不属于当前用户', {
        protocol: this.protocol,
      })
    }
    const action = ['accept', 'decline', 'cancel'].includes(response.action)
      ? response.action
      : 'accept'
    const status = action === 'accept'
      ? InputRequestStatus.ACCEPTED
      : action === 'decline'
        ? InputRequestStatus.DECLINED
        : InputRequestStatus.CANCELLED
    this.pending.delete(key)
    record.pending.resolve(action === 'accept'
      ? { action, content: responseContent(record, response) }
      : { action })
    const input = resolveInputRequest(record, status)
    record.onEvent?.(backendEvent(BackendEventType.INPUT_RESOLVED, { input }))
    this.resolved.set(key, { ownerId: record.ownerId, input })
    while (this.resolved.size > this.resolvedLimit) {
      this.resolved.delete(this.resolved.keys().next().value)
    }
    return input
  }

  cancelScope(permissionScopeId) {
    const scope = clean(permissionScopeId)
    for (const record of this.pending.values()) {
      if (scope && record.permissionScopeId === scope) this.cancel(record)
    }
  }

  cancelAll() {
    for (const record of [...this.pending.values()]) this.cancel(record)
  }
}
