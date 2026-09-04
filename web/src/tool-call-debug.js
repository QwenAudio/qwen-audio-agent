import { GatewayServerEvent } from '../../shared/realtime-events.mjs'

export const MAX_TOOL_CALLS = 64

const MCP_TOOL_NAME = /^mcp__[^_]+__(.+)$/u
const STATUS_ALIASES = Object.freeze({
  received: 'received',
  running: 'running',
  executing: 'running',
  completed: 'completed',
  succeeded: 'completed',
  failed: 'failed',
  error: 'failed',
  cancelled: 'cancelled',
  canceled: 'cancelled',
})
const STATUS_RANK = Object.freeze({
  received: 0,
  running: 1,
  completed: 2,
  failed: 2,
  cancelled: 2,
})

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function normalizedStatus(value) {
  const status = clean(value).toLowerCase()
  return STATUS_ALIASES[status] || 'running'
}

function isFiniteTimestamp(value) {
  return Number.isFinite(value) && value > 0
}

function mergeOptionalText(current, incoming) {
  return clean(incoming) || clean(current) || ''
}

export function displayToolName(name) {
  const value = clean(name)
  const shortName = value.replace(MCP_TOOL_NAME, '$1')
  return shortName.replaceAll('_', ' ')
}

// Tool-call arguments and results can contain user text, URLs, or credentials.
// The presentation model intentionally keeps only bounded, non-content metadata.
export function toolCallFromGatewayEvent(event, fallbackTurnId = '') {
  if (event?.type !== GatewayServerEvent.TOOL_CALL) return null
  const callId = clean(event.callId)
  const name = clean(event.name)
  if (!callId || !name) return null
  if (!['frontend', 'backend'].includes(event.surface)) return null

  const durationMs = Number(event.durationMs)
  const createdAt = Number(event.createdAt)
  const responseId = clean(event.responseId)
  const turnId = clean(event.turnId) || clean(fallbackTurnId)
  const taskId = clean(event.taskId)
  return {
    callId,
    name,
    surface: event.surface,
    status: normalizedStatus(event.status),
    ...(isFiniteTimestamp(createdAt) ? { createdAt } : {}),
    ...(Number.isFinite(durationMs) && durationMs >= 0 ? { durationMs } : {}),
    ...(responseId ? { responseId } : {}),
    ...(turnId ? { turnId } : {}),
    ...(taskId ? { taskId } : {}),
  }
}

export function mergeToolCallDebug(
  existing = [],
  incoming,
  { max = MAX_TOOL_CALLS } = {},
) {
  if (!incoming?.callId || !incoming.name) return existing
  const limit = Number.isInteger(max) && max > 0 ? max : MAX_TOOL_CALLS
  const index = existing.findIndex(call => call.callId === incoming.callId)
  if (index < 0) {
    const next = [...existing, {
      ...incoming,
      status: normalizedStatus(incoming.status),
    }]
    return next.length > limit ? next.slice(-limit) : next
  }

  const current = existing[index]
  const currentStatus = normalizedStatus(current.status)
  const nextStatus = normalizedStatus(incoming.status)
  const currentRank = STATUS_RANK[currentStatus]
  const nextRank = STATUS_RANK[nextStatus]
  const status = nextRank < currentRank ? currentStatus : nextStatus
  const next = [...existing]
  next[index] = {
    ...current,
    ...incoming,
    status,
    // A terminal event can arrive after a duplicate/late received event. Keep
    // the first observation time so the item does not move in the timeline.
    ...(isFiniteTimestamp(current.createdAt)
      ? { createdAt: current.createdAt }
      : isFiniteTimestamp(incoming.createdAt)
        ? { createdAt: incoming.createdAt }
        : {}),
    turnId: mergeOptionalText(current.turnId, incoming.turnId),
    taskId: mergeOptionalText(current.taskId, incoming.taskId),
    responseId: mergeOptionalText(current.responseId, incoming.responseId),
    ...(Number.isFinite(incoming.durationMs) && incoming.durationMs >= 0
      ? { durationMs: incoming.durationMs }
      : Number.isFinite(current.durationMs) && current.durationMs >= 0
        ? { durationMs: current.durationMs }
        : {}),
  }
  return next.length > limit ? next.slice(-limit) : next
}

export function cancelToolCallsForResponse(toolCalls = [], responseId) {
  const id = clean(responseId)
  if (!id) return toolCalls
  let changed = false
  const next = toolCalls.map(call => {
    if (
      call.responseId !== id
      || ['completed', 'failed', 'cancelled'].includes(normalizedStatus(call.status))
    ) return call
    changed = true
    return { ...call, status: 'cancelled' }
  })
  return changed ? next : toolCalls
}
