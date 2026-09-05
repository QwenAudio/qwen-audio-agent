const MCP_TOOL_NAME = /^mcp__[^_]+__(.+)$/u

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.keys(value).sort().map(key => [key, stableValue(value[key])]),
  )
}

export function displayToolName(name) {
  return clean(name).replace(MCP_TOOL_NAME, '$1')
}

export function toolCallKey(call) {
  const callId = clean(call?.callId || call?.id)
  if (callId) return callId
  return [
    clean(call?.surface) || 'frontend',
    clean(call?.name),
    JSON.stringify(stableValue(call?.arguments || {})),
  ].join('\u0000')
}

export function mergeToolCallDebug(existing = [], incoming) {
  if (!incoming?.name) return existing
  const key = toolCallKey(incoming)
  const index = existing.findIndex(call => toolCallKey(call) === key)
  if (index < 0) return [...existing, incoming]
  const next = [...existing]
  next[index] = { ...next[index], ...incoming }
  return next
}

export function shouldRefreshMemoryForToolCall(call) {
  return displayToolName(call?.name) === 'memory'
    && clean(call?.status).toLowerCase() === 'completed'
}

export function toolCallFromGatewayEvent(event) {
  if (event?.type !== 'tool.call') return null
  const name = clean(event.name)
  const surface = event.surface === 'backend' ? 'backend' : 'frontend'
  if (!name) return null
  return {
    callId: clean(event.callId),
    surface,
    name,
    arguments: event.arguments && typeof event.arguments === 'object'
      ? event.arguments
      : {},
    status: clean(event.status) || 'received',
    result: clean(event.result),
    duration_ms: Number.isFinite(event.durationMs) ? event.durationMs : null,
    responseId: clean(event.responseId),
    turnId: clean(event.turnId),
    taskId: clean(event.taskId),
  }
}

export function toolCallFromTaskEvent(event) {
  if (!clean(event?.type).startsWith('task.')) return null
  const task = event.task || {}
  const activity = Array.isArray(task.activity) ? task.activity.at(-1) : null
  if (activity?.kind !== 'tool') return null
  const name = clean(activity.tool || activity.label || 'tool')
  if (!name) return null
  const taskId = clean(task.id)
  const callId = clean(activity.id)
    ? `backend:${taskId}:${activity.id}`
    : `backend:${taskId}:${name}:${clean(activity.detail)}`
  return {
    callId,
    surface: 'backend',
    name,
    arguments: activity.detail ? { detail: clean(activity.detail) } : {},
    status: clean(activity.status) || clean(task.status) || 'running',
    result: clean(activity.status || task.status),
    duration_ms: null,
    turnId: clean(task.turnId || event.turnId),
    taskId,
  }
}
