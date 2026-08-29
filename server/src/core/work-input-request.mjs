export const InputRequestStatus = Object.freeze({
  PENDING: 'pending',
  ACCEPTED: 'accepted',
  DECLINED: 'declined',
  CANCELLED: 'cancelled',
})

const KNOWN_STATUSES = new Set(Object.values(InputRequestStatus))
const KNOWN_MODES = new Set(['text', 'form', 'url'])
const KNOWN_KINDS = new Set(['input', 'authorization'])

function clean(value, max = 1_000) {
  return String(value || '').replaceAll('\u0000', '').trim().slice(0, max)
}

function boundedObject(value, maxBytes = 64 * 1024) {
  if (!value || typeof value !== 'object') return null
  try {
    const json = JSON.stringify(value)
    return Buffer.byteLength(json, 'utf8') <= maxBytes
      ? JSON.parse(json)
      : null
  } catch {
    return null
  }
}

function publicUrl(value) {
  try {
    const url = new URL(clean(value, 2_048))
    return ['http:', 'https:'].includes(url.protocol)
      && !url.username
      && !url.password
      ? url.toString()
      : ''
  } catch {
    return ''
  }
}

export function normalizeInputRequest(value, {
  taskId = '',
  defaultStatus = InputRequestStatus.PENDING,
  now = Date.now(),
} = {}) {
  if (!value || typeof value !== 'object') return null
  const id = clean(value.id, 160)
  const prompt = clean(value.prompt || value.message, 4_000)
  if (!id || !prompt) return null
  const status = KNOWN_STATUSES.has(value.status)
    ? value.status
    : defaultStatus
  const mode = KNOWN_MODES.has(value.mode) ? value.mode : 'text'
  const kind = KNOWN_KINDS.has(value.kind) ? value.kind : 'input'
  const schema = boundedObject(value.schema)
  const url = mode === 'url' ? publicUrl(value.url) : ''
  return {
    id,
    taskId: clean(taskId || value.taskId, 160) || null,
    status,
    kind,
    mode,
    prompt,
    ...(schema ? { schema } : {}),
    ...(url ? { url } : {}),
    createdAt: Number(value.createdAt) || now,
    resolvedAt: status === InputRequestStatus.PENDING
      ? null
      : Number(value.resolvedAt) || now,
  }
}

export function resolveInputRequest(value, status, {
  taskId = '',
  now = Date.now(),
} = {}) {
  if (!KNOWN_STATUSES.has(status) || status === InputRequestStatus.PENDING) {
    return null
  }
  const request = normalizeInputRequest(value, { taskId, now })
  return request ? { ...request, status, resolvedAt: now } : null
}

export function publicInputRequest(value, { taskId = '' } = {}) {
  const request = normalizeInputRequest(value, {
    taskId,
    now: Number(value?.createdAt) || Date.now(),
  })
  return request ? { ...request } : null
}
