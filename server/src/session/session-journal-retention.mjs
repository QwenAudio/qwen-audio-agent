// Retention operates on durable event facts, not live TaskManager/ACP objects.
export const DEFAULT_JOURNAL_RETENTION = Object.freeze({
  maxEvents: 2000,
  maxBytes: 8 * 1024 * 1024,
  maxMessages: 200,
  maxTerminalTasks: 100,
})

export function journalRetention(options = {}) {
  const policy = { ...DEFAULT_JOURNAL_RETENTION, ...options }
  for (const [key, value] of Object.entries(policy)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`invalid journal retention ${key}`)
  }
  return policy
}

export const recordBytes = event => Buffer.byteLength(JSON.stringify(event)) + 1

export function latestJournalTasks(events) {
  const tasks = new Map()
  for (const event of events) {
    const task = event.type === 'qwaudio/task/event' && event.payload?.task
    if (task?.id) tasks.set(task.id, event)
  }
  return [...tasks.values()]
}

export function needsJournalRecovery(event) {
  const task = event.payload?.task
  return task && (
    !['completed', 'failed', 'cancelled'].includes(task.status)
    || ['pending', 'delivering'].includes(task.notificationStatus)
  )
}

/** Compact snapshots, retaining recovery facts before optional history. */
export function compactJournalEvents(events, policy, headerBytes = 0) {
  const selected = new Set()
  let bytes = headerBytes
  const add = (event, required = false) => {
    if (!event || selected.has(event)) return
    const size = recordBytes(event)
    if (selected.size >= policy.maxEvents || bytes + size > policy.maxBytes) {
      if (required) throw Object.assign(new Error('Session journal recovery state exceeds its retention budget'), {
        code: 'SESSION_JOURNAL_CAPACITY',
      })
      return
    }
    selected.add(event)
    bytes += size
  }
  const tasks = latestJournalTasks(events)
  // Never lose sequence progress, active/scheduled work, or undelivered results.
  add(events.at(-1), true)
  for (const event of tasks.filter(needsJournalRecovery)) add(event, true)
  const messages = new Map()
  for (const event of events) {
    if (['user/message', 'assistant/message'].includes(event.type)) {
      const key = event.payload?.messageId || event.seq
      messages.delete(key)
      messages.set(key, event)
    }
  }
  for (const event of [...messages.values()].reverse().slice(0, policy.maxMessages)) add(event)
  for (const event of tasks.filter(event => !needsJournalRecovery(event)).reverse().slice(0, policy.maxTerminalTasks)) add(event)
  // Leave headroom so a long-running session does not rewrite on every event.
  const targetEvents = Math.floor(policy.maxEvents * 0.75)
  const targetBytes = Math.floor(policy.maxBytes * 0.75)
  for (let i = events.length - 1; i >= 0 && selected.size < targetEvents && bytes < targetBytes; i--) {
    const event = events[i]
    // Older snapshots of a task/message are not needed to reconstruct state.
    if (event.type === 'qwaudio/task/event' && event.payload?.task?.id) continue
    if (['user/message', 'assistant/message'].includes(event.type)) continue
    add(event)
  }
  return [...selected].sort((a, b) => a.seq - b.seq)
}

export function retainedJournalHeader(header, removed) {
  if (!removed) return header
  return {
    ...header,
    retention: {
      policy: 'bounded',
      discardedEvents: (header.retention?.discardedEvents || 0) + removed,
    },
  }
}
