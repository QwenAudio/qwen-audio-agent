export const AuthorizationStatus = Object.freeze({
  PENDING: 'pending',
  APPROVED: 'approved',
  DENIED: 'denied',
  CANCELLED: 'cancelled',
})

const KNOWN_STATUSES = new Set(Object.values(AuthorizationStatus))
const KNOWN_APPROVAL_SCOPES = new Set(['once', 'session', 'persistent'])

function clean(value, max = 300) {
  return String(value || '').replaceAll('\u0000', '').replace(/\s+/g, ' ')
    .trim().slice(0, max)
}

export function normalizeAuthorizationOperation(value) {
  if (!value || typeof value !== 'object') return null
  const title = clean(value.title, 160)
  const kind = clean(value.kind, 80)
  const description = clean(value.description, 600)
  const command = clean(value.command, 1200)
  const path = clean(value.path, 600)
  const locations = (Array.isArray(value.locations) ? value.locations : [])
    .map(location => {
      const locationPath = clean(location?.path, 600)
      if (!locationPath) return null
      const line = Number.isInteger(location?.line) && location.line > 0
        ? location.line
        : null
      return {
        path: locationPath,
        ...(line ? { line } : {}),
      }
    })
    .filter(Boolean)
    .slice(0, 16)
  if (!title && !kind && !description && !command && !path && !locations.length) {
    return null
  }
  return {
    title: title || '后台操作',
    kind: kind || 'unknown',
    ...(description ? { description } : {}),
    ...(command ? { command } : {}),
    ...(path ? { path } : {}),
    ...(locations.length ? { locations } : {}),
  }
}

export function normalizeAuthorization(value, {
  taskId = '',
  defaultStatus = AuthorizationStatus.PENDING,
  now = Date.now(),
} = {}) {
  if (!value || typeof value !== 'object') return null
  const id = clean(value.id, 160)
  const summary = clean(value.summary, 600)
  if (!id || !summary) return null
  const status = KNOWN_STATUSES.has(value.status)
    ? value.status
    : defaultStatus
  const createdAt = Number(value.createdAt) || now
  const resolvedAt = status === AuthorizationStatus.PENDING
    ? null
    : Number(value.resolvedAt) || now
  const approvalScope = KNOWN_APPROVAL_SCOPES.has(value.approvalScope)
    ? value.approvalScope
    : 'session'
  return {
    id,
    taskId: clean(taskId || value.taskId, 160) || null,
    status,
    category: clean(value.category, 80) || 'unknown',
    summary,
    patterns: (Array.isArray(value.patterns) ? value.patterns : [])
      .map(pattern => clean(pattern, 300))
      .filter(Boolean)
      .slice(0, 32),
    approvalScope,
    operation: normalizeAuthorizationOperation(value.operation),
    createdAt,
    resolvedAt,
  }
}

export function resolveAuthorization(value, status, {
  taskId = '',
  now = Date.now(),
} = {}) {
  if (!KNOWN_STATUSES.has(status) || status === AuthorizationStatus.PENDING) {
    return null
  }
  const authorization = normalizeAuthorization(value, { taskId, now })
  if (!authorization) return null
  return {
    ...authorization,
    status,
    resolvedAt: now,
  }
}

export function publicAuthorization(value, { taskId = '' } = {}) {
  const authorization = normalizeAuthorization(value, {
    taskId,
    now: Number(value?.createdAt) || Date.now(),
  })
  return authorization ? { ...authorization } : null
}
