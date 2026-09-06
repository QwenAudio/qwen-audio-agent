export class KeyedSerialExecutor {
  constructor() {
    this.queues = new Map()
    this.sequence = 0
  }

  run(key, operation, { priority = 0, signal } = {}) {
    const queueKey = String(key)
    if (signal?.aborted) {
      return Promise.reject(signal.reason || new Error('任务已取消'))
    }
    const queue = this.queues.get(queueKey) || {
      active: false,
      pending: [],
    }
    this.queues.set(queueKey, queue)
    return new Promise((resolve, reject) => {
      const entry = {
        operation,
        priority: Number.isFinite(Number(priority)) ? Number(priority) : 0,
        sequence: this.sequence++,
        resolve,
        reject,
        signal,
        started: false,
      }
      const abort = () => {
        if (entry.started) return
        const index = queue.pending.indexOf(entry)
        if (index < 0) return
        queue.pending.splice(index, 1)
        reject(signal.reason || new Error('任务已取消'))
        this.#drain(queueKey, queue)
      }
      entry.abort = abort
      signal?.addEventListener('abort', abort, { once: true })
      queue.pending.push(entry)
      queue.pending.sort((left, right) => (
        right.priority - left.priority || left.sequence - right.sequence
      ))
      this.#drain(queueKey, queue)
    })
  }

  #drain(key, queue) {
    if (queue.active) return
    const entry = queue.pending.shift()
    if (!entry) {
      if (this.queues.get(key) === queue) this.queues.delete(key)
      return
    }
    if (entry.signal?.aborted) {
      entry.reject(entry.signal.reason || new Error('任务已取消'))
      this.#drain(key, queue)
      return
    }
    entry.started = true
    entry.signal?.removeEventListener('abort', entry.abort)
    queue.active = true
    Promise.resolve()
      .then(entry.operation)
      .then(entry.resolve, entry.reject)
      .finally(() => {
        queue.active = false
        this.#drain(key, queue)
      })
  }

  get size() {
    return this.queues.size
  }
}
