import { randomUUID } from 'node:crypto'
import { AgentError } from './backend-adapter.mjs'
import { ACP_SESSION_TOOL_NAMES } from './acp-session-tools.mjs'
import {
  AuthorizationStatus,
  normalizeAuthorization,
  resolveAuthorization,
} from '../core/work-authorization.mjs'

function clean(value) {
  return String(value || '').trim()
}

function bounded(value, max = 300) {
  return clean(value).replace(/\s+/g, ' ').slice(0, max)
}

function deferred() {
  let resolvePromise
  const promise = new Promise(resolve => { resolvePromise = resolve })
  return { promise, resolve: resolvePromise }
}

function optionFor(params, decision) {
  const options = Array.isArray(params?.options) ? params.options : []
  const kinds = decision === 'always'
    ? ['allow_once', 'allow_always']
    : ['reject_always', 'reject_once']
  return kinds
    .map(kind => options.find(candidate => candidate.kind === kind))
    .find(Boolean) || null
}

export class PermissionBroker {
  constructor({ protocol, permissionMode, resolvedLimit = 200 }) {
    this.protocol = protocol
    this.permissionMode = permissionMode
    this.resolvedLimit = resolvedLimit
    this.pending = new Map()
    this.resolved = new Map()
  }

  async request(params, { signal, session } = {}) {
    const name = clean(params?.toolCall?.name || params?.toolCall?.title)
    const internal = ACP_SESSION_TOOL_NAMES.some(toolName => (
      name === toolName
      || name.endsWith(`__${toolName}`)
      || name.startsWith(`${toolName} (`)
    ))
    if (this.permissionMode === 'full' || internal) {
      const option = optionFor(params, 'always')
      return option
        ? { outcome: { outcome: 'selected', optionId: option.optionId } }
        : { outcome: { outcome: 'cancelled' } }
    }
    const id = `auth_${randomUUID().replaceAll('-', '')}`
    const pending = deferred()
    const permission = normalizeAuthorization({
      id,
      workId: session?.coordinationRunId || null,
      status: AuthorizationStatus.PENDING,
      category: bounded(name, 80) || 'unknown',
      summary: [
        bounded(name, 80),
        bounded(
          params?.toolCall?.rawInput?.description
          || params?.toolCall?.rawInput?.command
          || params?.toolCall?.rawInput?.path
          || '',
        ),
      ].filter(Boolean).join('：') || '后台操作',
      patterns: [],
    })
    const record = {
      ...permission,
      ownerId: clean(session?.ownerId),
      sessionId: clean(session?.sessionId),
      permissionScopeId: clean(session?.permissionScopeId),
      params,
      pending,
      onEvent: session?.onEvent,
    }
    this.pending.set(id, record)
    record.onEvent?.({ type: 'backend.permission.requested', permission })
    signal?.addEventListener('abort', () => this.cancel(record), { once: true })
    return pending.promise
  }

  cancel(record) {
    if (!record || !this.pending.delete(record.id)) return false
    record.pending.resolve({ outcome: { outcome: 'cancelled' } })
    const permission = resolveAuthorization(
      record,
      AuthorizationStatus.CANCELLED,
    )
    record.onEvent?.({
      type: 'backend.permission.resolved',
      permission,
    })
    return true
  }

  respond(id, decision, { ownerId } = {}) {
    const key = String(id)
    const record = this.pending.get(key)
    if (!record) {
      const resolved = this.resolved.get(key)
      if (resolved?.ownerId === clean(ownerId)) return resolved.permission
    }
    if (!record || record.ownerId !== clean(ownerId)) {
      throw new AgentError('权限请求不存在、已经失效或不属于当前用户', {
        protocol: this.protocol,
      })
    }
    this.pending.delete(record.id)
    const approved = decision === 'always'
    const option = optionFor(
      record.params,
      approved ? 'always' : 'reject',
    )
    record.pending.resolve(option
      ? { outcome: { outcome: 'selected', optionId: option.optionId } }
      : { outcome: { outcome: 'cancelled' } })
    const permission = resolveAuthorization(
      record,
      approved ? AuthorizationStatus.APPROVED : AuthorizationStatus.DENIED,
    )
    record.onEvent?.({ type: 'backend.permission.resolved', permission })
    this.resolved.set(permission.id, { ownerId: record.ownerId, permission })
    while (this.resolved.size > this.resolvedLimit) {
      this.resolved.delete(this.resolved.keys().next().value)
    }
    return permission
  }

  cancelScope(permissionScopeId) {
    const scope = clean(permissionScopeId)
    if (!scope) return
    for (const record of this.pending.values()) {
      if (record.permissionScopeId === scope) this.cancel(record)
    }
  }

  cancelAll() {
    for (const record of [...this.pending.values()]) this.cancel(record)
  }
}
