import {
  defineBackendAdapter,
} from '../../server/src/backend/backend-adapter-sdk.mjs'

function clean(value) {
  return String(value || '').trim()
}

function cancellationError(taskId) {
  const error = new Error(`Task ${taskId} was cancelled`)
  error.code = 'WORK_CANCELLED'
  return error
}

/**
 * Minimal non-ACP adapter used as an SDK example and conformance fixture.
 * Replace the result construction with a call to a phone, hardware, HTTP, or
 * other action runtime while preserving the public BackendPort boundary.
 */
export class InMemoryBackendAdapter {
  constructor({ hold = false } = {}) {
    this.hold = hold
    this.ready = false
    this.closed = false
    this.active = new Map()
    this.listeners = new Set()
    this.started = Promise.withResolvers()
  }

  describe() {
    return {
      configured: true,
      enabled: true,
      protocol: 'example-memory',
      label: 'Example in-memory backend',
      capabilities: {
        cancel: true,
        authorization: false,
      },
    }
  }

  async start() {
    if (this.closed) throw new Error('Example backend is closed')
    this.ready = true
    return { ok: true, status: 'ready' }
  }

  async health() {
    return {
      ok: this.ready && !this.closed,
      status: this.ready && !this.closed ? 'ready' : 'stopped',
    }
  }

  async submit(work) {
    const taskId = clean(work?.id)
    const ownerId = clean(work?.ownerId)
    const input = clean(
      work?.instruction
      || work?.objective
      || work?.originalRequest
      || work?.message,
    )
    if (!taskId || !ownerId || !input) {
      throw new Error('Backend submit requires task id, owner and input')
    }
    if (this.active.has(taskId)) {
      throw new Error(`Task ${taskId} is already active`)
    }
    await this.start()
    const cancellation = Promise.withResolvers()
    cancellation.promise.catch(() => {})
    const record = { taskId, ownerId, input, cancellation }
    this.active.set(taskId, record)
    this.emit({
      type: 'backend.activity',
      taskId,
      ownerId,
      activity: { kind: 'status', message: 'Example backend started' },
    })
    this.started.resolve()
    try {
      if (this.hold) await cancellation.promise
      const content = `Example backend received: ${input}`
      return {
        content,
        artifacts: [],
      }
    } finally {
      this.active.delete(taskId)
    }
  }

  status(taskId, { ownerId } = {}) {
    const id = clean(taskId)
    if (!id) {
      return {
        ok: this.ready && !this.closed,
        status: this.ready && !this.closed ? 'ready' : 'stopped',
      }
    }
    const record = this.active.get(id)
    if (!record || (ownerId && clean(ownerId) !== record.ownerId)) {
      return { taskId: id, state: 'not_found' }
    }
    return {
      taskId: record.taskId,
      state: 'working',
      activity: [{ kind: 'status', message: 'Example backend started' }],
    }
  }

  async cancel(taskId, { ownerId } = {}) {
    const record = this.active.get(clean(taskId))
    if (!record) return { taskId: clean(taskId), state: 'not_found' }
    if (ownerId && clean(ownerId) !== record.ownerId) {
      throw new Error('Cannot cancel work owned by another user')
    }
    record.cancellation.reject(cancellationError(record.taskId))
    return { taskId: record.taskId, state: 'cancelled' }
  }

  async respondAuthorization() {
    throw new Error('Example backend does not support authorization requests')
  }

  async respondInput() {
    throw new Error('Example backend does not support input requests')
  }

  subscribe(listener) {
    if (typeof listener !== 'function') {
      throw new TypeError('Backend event listener must be a function')
    }
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit(event) {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        // Observers cannot interrupt backend execution.
      }
    }
  }

  async close() {
    if (this.closed) return
    this.closed = true
    for (const record of this.active.values()) {
      record.cancellation.reject(cancellationError(record.taskId))
    }
    this.listeners.clear()
  }
}

export function createInMemoryBackend(options) {
  return defineBackendAdapter(new InMemoryBackendAdapter(options), {
    name: 'Example in-memory backend',
  })
}

function work(index) {
  return {
    id: `task_${index}`,
    ownerId: 'example-owner',
    objective: `Example request ${index}`,
  }
}

export function createConformanceFixture({ hold }) {
  const backend = createInMemoryBackend({ hold })
  return {
    name: 'Example memory',
    backend,
    work: work(1),
    nextWork: work(2),
    started: backend.started.promise,
  }
}
