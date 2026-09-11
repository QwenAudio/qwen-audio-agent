// Host-owned observers receive lifecycle facts; transport knows neither their
// storage nor learning policy. Async hooks never block live conversation.
export class SessionObservers {
  constructor(observers = []) {
    this.observers = observers
    this.pending = new Set()
  }

  emit(method, context) {
    for (const observer of this.observers) {
      const failed = error => context.logger?.warn('session_observer.failed', {
        hook: method,
        error: String(error?.message || error),
      })
      try {
        const result = observer[method]?.(context)
        if (!result?.then) continue
        const pending = Promise.resolve(result).catch(failed)
        this.pending.add(pending)
        void pending.finally(() => this.pending.delete(pending))
      } catch (error) {
        failed(error)
      }
    }
  }

  async drain() {
    while (this.pending.size) await Promise.allSettled([...this.pending])
  }
}
