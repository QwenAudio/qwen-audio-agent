// Example-local short-term task history, not the frontend's conversation memory.
// Keep only completed request/reply pairs; tool traces and approval capabilities
// belong to the active task and must not be replayed into an unrelated task.
export class AgentHistory {
  constructor({ maxTurns = 50, maxContexts = 100 } = {}) {
    if (![maxTurns, maxContexts].every(value => Number.isSafeInteger(value) && value > 0)) {
      throw new TypeError('History limits must be positive integers')
    }
    this.maxTurns = maxTurns
    this.maxContexts = maxContexts
    this.contexts = new Map()
  }

  messages(contextId) {
    return this.recent(contextId).flatMap(turn => structuredClone(turn.messages))
  }

  metadata(contextId) {
    return this.recent(contextId).map(turn => structuredClone(turn.metadata))
  }

  recent(contextId) {
    const turns = this.contexts.get(contextId) || []
    // Reserve one turn for the current request, keeping model input <= 50 turns.
    return this.maxTurns > 1 ? turns.slice(-(this.maxTurns - 1)) : []
  }

  append(contextId, request, reply, metadata = {}) {
    if (!contextId) return
    const turns = this.contexts.get(contextId) || []
    turns.push({
      messages: [
        { role: 'user', content: String(request) },
        { role: 'assistant', content: String(reply) },
      ],
      metadata: structuredClone(metadata),
    })
    this.contexts.delete(contextId)
    this.contexts.set(contextId, turns.slice(-this.maxTurns))
    // Bound inactive conversations as well as the size of each conversation.
    while (this.contexts.size > this.maxContexts) {
      this.contexts.delete(this.contexts.keys().next().value)
    }
  }
}
