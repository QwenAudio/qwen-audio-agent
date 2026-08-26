import { validateSessionLog } from '../../../shared/session-events.mjs'

/**
 * Builds a stable, read-only inspection view from a Session Journal. This is
 * deliberately side-effect free: replay never calls a model or re-executes a
 * tool.
 */
export function replaySession(records, { sessionId } = {}) {
  const { header, events } = validateSessionLog(records, { sessionId })
  const messages = []
  const tasks = new Map()
  const deliveries = []
  for (const event of events) {
    if (event.type === 'user/message' || event.type === 'assistant/message') {
      messages.push({
        role: event.type === 'user/message' ? 'user' : 'assistant',
        ...(event.turnId ? { turnId: event.turnId } : {}),
        ...(event.taskId ? { taskId: event.taskId } : {}),
        ...(event.payload || {}),
        seq: event.seq,
        time: event.time,
      })
    }
    if (event.type === 'qwaudio/task/event' && event.taskId && event.payload?.task) {
      tasks.set(event.taskId, {
        ...event.payload.task,
        journalSeq: event.seq,
        domainType: event.payload.domainType || null,
      })
    }
    if (event.type === 'qwaudio/delivery/event') deliveries.push({ ...event })
  }
  return {
    header: { ...header },
    lastSeq: events.at(-1)?.seq || 0,
    messages,
    tasks: [...tasks.values()],
    deliveries,
  }
}
