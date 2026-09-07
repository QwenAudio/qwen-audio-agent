export class KeyedSerialExecutor {
  constructor() {
    this.queues = new Map()
  }

  run(key, operation) {
    const previous = this.queues.get(key) || Promise.resolve()
    const current = previous.catch(() => {}).then(operation)
    this.queues.set(key, current)
    return current.finally(() => {
      if (this.queues.get(key) === current) this.queues.delete(key)
    })
  }

  get size() {
    return this.queues.size
  }
}
