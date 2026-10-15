/** Serializes coordinator turns per owner; delegated execution does not hold a lease. */
export class CoordinatorQueue {
  constructor() {
    this.owners = new Map()
    this.closed = false
  }

  acquire(ownerKey, { signal } = {}) {
    if (this.closed) return Promise.reject(new Error('Coordinator queue is closed'))
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('任务已取消'))
    let state = this.owners.get(ownerKey)
    if (!state) {
      state = { busy: false, waiting: [] }
      this.owners.set(ownerKey, state)
    }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal }
      waiter.abort = () => {
        state.waiting = state.waiting.filter(item => item !== waiter)
        signal?.removeEventListener('abort', waiter.abort)
        reject(signal.reason ?? new Error('任务已取消'))
        this.drain(ownerKey, state)
      }
      signal?.addEventListener('abort', waiter.abort, { once: true })
      state.waiting.push(waiter)
      this.drain(ownerKey, state)
    })
  }

  drain(ownerKey, state) {
    if (this.closed || state.busy) return
    const waiter = state.waiting.shift()
    if (!waiter) {
      this.owners.delete(ownerKey)
      return
    }
    waiter.signal?.removeEventListener('abort', waiter.abort)
    state.busy = true
    let released = false
    waiter.resolve({ key: ownerKey, release: () => {
      if (released) return
      released = true
      state.busy = false
      this.drain(ownerKey, state)
    } })
  }

  close() {
    this.closed = true
    for (const state of this.owners.values()) {
      for (const waiter of state.waiting.splice(0)) {
        waiter.signal?.removeEventListener('abort', waiter.abort)
        waiter.reject(new Error('Coordinator queue is closed'))
      }
    }
    this.owners.clear()
  }
}
