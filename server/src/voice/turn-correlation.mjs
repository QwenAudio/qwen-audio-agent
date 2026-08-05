export class TurnCorrelation {
  constructor({ maxItems = 100 } = {}) {
    this.maxItems = maxItems
    this.turns = new Map()
    this.invalidItems = new Set()
  }

  remember(itemId, context) {
    if (!itemId) return context
    const existing = this.turns.get(itemId)
    if (existing) return existing
    this.turns.set(itemId, context)
    while (this.turns.size > this.maxItems) {
      const oldest = this.turns.keys().next().value
      this.turns.delete(oldest)
      this.invalidItems.delete(oldest)
    }
    return context
  }

  resolve(itemId, fallback) {
    return this.turns.get(itemId) || fallback
  }

  invalidate(itemId) {
    if (itemId) this.invalidItems.add(itemId)
  }

  isInvalid(itemId) {
    return this.invalidItems.has(itemId)
  }

  complete(itemId, fallback) {
    const context = this.resolve(itemId, fallback)
    // An OpenAI Realtime item id identifies one conversation item for the
    // lifetime of the session. Keep the bounded correlation after completion
    // so duplicate events or a provider reopening that item still update the
    // same frontend turn instead of creating a second message.
    const invalid = this.invalidItems.has(itemId)
    return { context, invalid }
  }

  clear() {
    this.turns.clear()
    this.invalidItems.clear()
  }
}
