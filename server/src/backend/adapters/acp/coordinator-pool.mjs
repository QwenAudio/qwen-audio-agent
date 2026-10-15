/** Leases cover a whole logical request, including delegated work and its final reply. */
export class CoordinatorPool {
  constructor(limit = 1) {
    const value = Number(limit)
    this.limit = Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1
    this.owners = new Map()
    this.closed = false
  }

  acquire(ownerKey, { preferredKey, signal } = {}) {
    if (this.closed) return Promise.reject(new Error('Coordinator pool is closed'))
    if (signal?.aborted) return Promise.reject(signal.reason || new Error('任务已取消'))
    let state = this.owners.get(ownerKey)
    if (!state) {
      state = { busy: new Set(), waiting: [] }
      this.owners.set(ownerKey, state)
    }
    return new Promise((resolve, reject) => {
      const waiter = { preferredKey, resolve, reject, signal }
      waiter.abort = () => {
        state.waiting = state.waiting.filter(item => item !== waiter)
        signal?.removeEventListener('abort', waiter.abort)
        reject(signal.reason || new Error('任务已取消'))
        this.drain(ownerKey, state)
      }
      signal?.addEventListener('abort', waiter.abort, { once: true })
      state.waiting.push(waiter)
      this.drain(ownerKey, state)
    })
  }

  drain(ownerKey, state) {
    for (const waiter of [...state.waiting]) {
      if (state.busy.size >= this.limit) break
      // A resumed request waits for its own Session even when another slot is idle.
      const key = waiter.preferredKey || Array.from({ length: this.limit }, (_, index) => (
        index ? `${ownerKey}:slot:${index}` : ownerKey
      )).find(candidate => !state.busy.has(candidate))
      if (!key || state.busy.has(key)) continue
      state.waiting.splice(state.waiting.indexOf(waiter), 1)
      waiter.signal?.removeEventListener('abort', waiter.abort)
      state.busy.add(key)
      let released = false
      waiter.resolve({ key, release: () => {
        if (released) return
        released = true
        state.busy.delete(key)
        this.drain(ownerKey, state)
      } })
    }
    if (!state.busy.size && !state.waiting.length) this.owners.delete(ownerKey)
  }

  close() {
    this.closed = true
    for (const state of this.owners.values()) {
      for (const waiter of state.waiting.splice(0)) {
        waiter.signal?.removeEventListener('abort', waiter.abort)
        waiter.reject(new Error('Coordinator pool is closed'))
      }
    }
  }
}
