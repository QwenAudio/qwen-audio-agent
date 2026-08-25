export const AuthorizationStatus = Object.freeze({
  PENDING: 'pending',
  APPROVED: 'approved',
  DENIED: 'denied',
  CANCELLED: 'cancelled',
})

const KNOWN_STATUSES = new Set(Object.values(AuthorizationStatus))

function clean(value, max = 300) {
  return String(value || '').replaceAll('\u0000', '').replace(/\s+/g, ' ')
    .trim().slice(0, max)
}

export function normalizeAuthorization(value, {
  workId = '',
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
  return {
    id,
    workId: clean(workId || value.workId, 160) || null,
    status,
    category: clean(value.category, 80) || 'unknown',
    summary,
    patterns: (Array.isArray(value.patterns) ? value.patterns : [])
      .map(pattern => clean(pattern, 300))
      .filter(Boolean)
      .slice(0, 32),
    createdAt,
    resolvedAt,
  }
}

export function resolveAuthorization(value, status, {
  workId = '',
  now = Date.now(),
} = {}) {
  if (!KNOWN_STATUSES.has(status) || status === AuthorizationStatus.PENDING) {
    return null
  }
  const authorization = normalizeAuthorization(value, { workId, now })
  if (!authorization) return null
  return {
    ...authorization,
    status,
    resolvedAt: now,
  }
}

export function publicAuthorization(value, { workId = '' } = {}) {
  const authorization = normalizeAuthorization(value, {
    workId,
    now: Number(value?.createdAt) || Date.now(),
  })
  return authorization ? { ...authorization } : null
}
