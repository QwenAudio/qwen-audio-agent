import { randomUUID } from 'node:crypto'
import { redactLogValue } from '../../../shared/logger.mjs'
import { AgentError } from './backend-adapter.mjs'
import { ACP_SESSION_TOOL_NAMES } from './acp-session-tools.mjs'
import {
  AuthorizationStatus,
  normalizeAuthorization,
  resolveAuthorization,
} from '../core/work-authorization.mjs'
import { BackendEventType, backendEvent } from '../core/backend-events.mjs'

function clean(value) {
  return String(value || '').trim()
}

function bounded(value, max = 300) {
  return clean(value).replace(/\s+/g, ' ').slice(0, max)
}

function safeField(value, key, max) {
  if (value === null || value === undefined) return ''
  const redacted = redactLogValue({ [key]: value })?.[key]
  if (Array.isArray(redacted)) return bounded(redacted.join(' '), max)
  if (typeof redacted === 'object') return ''
  return bounded(redacted, max)
}

function permissionOperation(toolCall = {}) {
  const rawInput = toolCall.rawInput && typeof toolCall.rawInput === 'object'
    ? toolCall.rawInput
    : {}
  const title = safeField(
    toolCall.title || toolCall.name || '后台操作',
    'title',
    160,
  )
  const description = safeField(
    rawInput.description || rawInput.query,
    'description',
    600,
  )
  const command = safeField(rawInput.command, 'command', 1200)
  const path = safeField(
    rawInput.path || rawInput.filePath || rawInput.file_path,
    'path',
    600,
  )
  const locations = (Array.isArray(toolCall.locations) ? toolCall.locations : [])
    .map(location => {
      const locationPath = safeField(location?.path, 'path', 600)
      if (!locationPath) return null
      return {
        path: locationPath,
        ...(Number.isInteger(location?.line) && location.line > 0
          ? { line: location.line }
          : {}),
      }
    })
    .filter(Boolean)
    .slice(0, 16)
  return {
    title,
    kind: safeField(toolCall.kind || toolCall.name, 'kind', 80) || 'unknown',
    ...(description ? { description } : {}),
    ...(command ? { command } : {}),
    ...(path ? { path } : {}),
    ...(locations.length ? { locations } : {}),
  }
}

function permissionSummary(operation) {
  const detail = operation.description
    || operation.command
    || operation.path
    || operation.locations?.[0]?.path
    || ''
  return [operation.title, detail]
    .filter((value, index, values) => value && values.indexOf(value) === index)
    .join('：') || '后台操作'
}

function deferred() {
  let resolvePromise
  const promise = new Promise(resolve => { resolvePromise = resolve })
  return { promise, resolve: resolvePromise }
}

function optionFor(params, decision) {
  const options = Array.isArray(params?.options) ? params.options : []
  // Product decisions are stable across BackendPort implementations. ACP
  // option ids remain opaque and are selected by their standard kind here.
  // Public `always` is scoped to the current frontend session, so prefer an
  // ACP one-shot option and let the Gateway approve subsequent requests.
  const kinds = decision === 'once'
    ? ['allow_once']
    : decision === 'always'
      ? ['allow_once', 'allow_always']
      : ['reject_once']
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
    const operation = permissionOperation(params?.toolCall)
    const permission = normalizeAuthorization({
      id,
      taskId: session?.coordinationRunId || null,
      status: AuthorizationStatus.PENDING,
      category: operation.kind || bounded(name, 80) || 'unknown',
      summary: permissionSummary(operation),
      patterns: [],
      approvalScope: 'session',
      operation,
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
    record.onEvent?.(backendEvent(
      BackendEventType.AUTHORIZATION_REQUESTED,
      { permission },
    ))
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
    record.onEvent?.(backendEvent(
      BackendEventType.AUTHORIZATION_RESOLVED,
      { permission },
    ))
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
    const approved = decision === 'once' || decision === 'always'
    const option = optionFor(
      record.params,
      decision,
    )
    if (approved && !option) {
      throw new AgentError('后台未提供所请求的允许方式', {
        protocol: this.protocol,
      })
    }
    this.pending.delete(record.id)
    record.pending.resolve(option
      ? { outcome: { outcome: 'selected', optionId: option.optionId } }
      : { outcome: { outcome: 'cancelled' } })
    const permission = resolveAuthorization(
      record,
      approved ? AuthorizationStatus.APPROVED : AuthorizationStatus.DENIED,
    )
    record.onEvent?.(backendEvent(
      BackendEventType.AUTHORIZATION_RESOLVED,
      { permission },
    ))
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
