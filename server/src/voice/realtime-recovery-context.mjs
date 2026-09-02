function taskIds(value = {}) {
  return new Set([
    value.taskId,
    ...(Array.isArray(value.taskIds) ? value.taskIds : []),
  ].filter(Boolean))
}

/**
 * Keeps visible conversation history independent from the subset that is safe
 * to replay into a replacement Realtime Session.
 */
export class RealtimeRecoveryContext {
  constructor() {
    this.excludedTurnIds = new Set()
    this.excludedMessageIds = new Set()
    this.excludedTaskIds = new Set()
  }

  project(messages = []) {
    return messages.filter(message => {
      if (this.excludedMessageIds.has(message.id)) return false
      if (message.turnId && this.excludedTurnIds.has(message.turnId)) return false
      for (const taskId of taskIds(message)) {
        if (this.excludedTaskIds.has(taskId)) return false
      }
      return true
    })
  }

  excludeFailure(context = {}, messages = []) {
    let scoped = false
    if (context.turnId) {
      this.excludedTurnIds.add(context.turnId)
      scoped = true
    }
    for (const taskId of taskIds(context)) {
      this.excludedTaskIds.add(taskId)
      scoped = true
    }
    if (scoped) return

    // A provider can reject before emitting response.created, leaving no
    // response context to correlate. Exclude only the latest user message as a
    // conservative fallback instead of discarding the whole recent history.
    const latestUser = [...messages].reverse().find(message => message.role === 'user')
    if (latestUser?.id) this.excludedMessageIds.add(latestUser.id)
  }
}
