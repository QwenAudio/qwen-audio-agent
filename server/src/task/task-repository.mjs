const MAX_TASK_NUMBER = 99_999

function normalizedTaskNumber(value) {
  const number = Number(value)
  return Number.isInteger(number) && number >= 1 && number <= MAX_TASK_NUMBER
    ? number
    : 1
}

/**
 * Durable repository for internal Work records.
 *
 * Recovery policy remains in TaskManager; this boundary owns the record
 * collection, its persisted projection, atomic/deferred writes, and the
 * durable short task-id cursor.
 */
export class TaskRepository {
  constructor({ store = null, serialize = task => task } = {}) {
    this.store = store
    this.serialize = serialize
    this.records = new Map()
    this.nextTaskNumber = 1
  }

  load() {
    const saved = this.store?.load() || []
    this.nextTaskNumber = normalizedTaskNumber(
      this.store?.nextTaskNumber ?? this.store?.nextJobNumber,
    )
    return saved
  }

  get(id) {
    return this.records.get(String(id))
  }

  set(id, task) {
    this.records.set(String(id), task)
    return this
  }

  delete(id) {
    return this.records.delete(String(id))
  }

  values() {
    return this.records.values()
  }

  allocateTaskId() {
    for (let attempts = 0; attempts < MAX_TASK_NUMBER; attempts += 1) {
      const current = normalizedTaskNumber(this.nextTaskNumber)
      this.nextTaskNumber = current >= MAX_TASK_NUMBER ? 1 : current + 1
      const id = `task_${current}`
      if (!this.records.has(id)) return id
    }
    throw new Error('No available task IDs')
  }

  save() {
    this.store?.save(this.#serializedRecords(), {
      nextTaskNumber: this.nextTaskNumber,
    })
  }

  saveDeferred() {
    const tasks = this.#serializedRecords()
    const state = { nextTaskNumber: this.nextTaskNumber }
    if (this.store?.saveDeferred) this.store.saveDeferred(tasks, state)
    else this.store?.save(tasks, state)
  }

  #serializedRecords() {
    return [...this.records.values()].map(this.serialize)
  }
}
