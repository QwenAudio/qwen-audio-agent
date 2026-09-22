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
    this.attempts = 0
  }

  beginRecovery(context, messages) {
    // Do not reset on a successful handshake or the recovery announcement:
    // neither proves that a new user turn can actually complete.
    this.attempts += 1
    if (this.attempts > 2) return false
    this.excludeFailure(this.attempts === 1 ? context : {}, messages)
    return true
  }

  recordSuccessfulTurn() {
    this.attempts = 0
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

    // A restored history is a single provider input. Without correlation we
    // cannot identify the offending line. Quarantine that snapshot, not just
    // its last user message; visible/durable history and future turns survive.
    for (const message of messages) {
      if (message.id) this.excludedMessageIds.add(message.id)
    }
  }
}
