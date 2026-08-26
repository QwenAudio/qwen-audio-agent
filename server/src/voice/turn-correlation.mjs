export class TurnCorrelation {
  constructor({ maxItems = 100 } = {}) {
    this.maxItems = maxItems
    this.turns = new Map()
    this.invalidItems = new Set()
    this.completedItems = new Set()
  }

  remember(itemId, context, { replace = false } = {}) {
    if (!itemId) return context
    const existing = this.turns.get(itemId)
    if (existing && !replace) return existing
    if (replace) {
      this.invalidItems.delete(itemId)
      this.completedItems.delete(itemId)
    }
    this.turns.set(itemId, context)
    while (this.turns.size > this.maxItems) {
      const oldest = this.turns.keys().next().value
      this.turns.delete(oldest)
      this.invalidItems.delete(oldest)
      this.completedItems.delete(oldest)
    }
    return context
  }

  resolve(itemId, fallback) {
    return this.turns.get(itemId) || fallback
  }

  invalidate(itemId) {
    if (itemId) this.invalidItems.add(itemId)
  }

  invalidateBeforeGeneration(generation) {
    for (const [itemId, context] of this.turns) {
      if (
        Number.isInteger(context?.turnGeneration)
        && context.turnGeneration < generation
      ) {
        this.invalidItems.add(itemId)
      }
    }
  }

  isInvalid(itemId) {
    return this.invalidItems.has(itemId)
  }

  isComplete(itemId) {
    return this.completedItems.has(itemId)
  }

  complete(itemId, fallback) {
    const context = this.resolve(itemId, fallback)
    // Keep the bounded mapping so late events still resolve to their original
    // turn. completedItems separately prevents duplicate finals and lets a
    // later speech-start reuse of the provider id open a new Gateway turn.
    const invalid = this.invalidItems.has(itemId)
    const duplicate = this.completedItems.has(itemId)
    if (itemId) this.completedItems.add(itemId)
    return {
      context,
      invalid,
      ...(duplicate ? { duplicate: true } : {}),
    }
  }

  clear() {
    this.turns.clear()
    this.invalidItems.clear()
    this.completedItems.clear()
  }
}
