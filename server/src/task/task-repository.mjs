const MAX_JOB_NUMBER = 99_999

function normalizedJobNumber(value) {
  const number = Number(value)
  return Number.isInteger(number) && number >= 1 && number <= MAX_JOB_NUMBER
    ? number
    : 1
}

/**
 * Durable repository for internal Work records.
 *
 * Recovery policy remains in TaskManager; this boundary owns the record
 * collection, its persisted projection, atomic/deferred writes, and the
 * durable short job-id cursor.
 */
export class TaskRepository {
  constructor({ store = null, serialize = task => task } = {}) {
    this.store = store
    this.serialize = serialize
    this.records = new Map()
    this.nextJobNumber = 1
  }

  load() {
    const saved = this.store?.load() || []
    this.nextJobNumber = normalizedJobNumber(this.store?.nextJobNumber)
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

  allocateJobId() {
    const current = normalizedJobNumber(this.nextJobNumber)
    this.nextJobNumber = current >= MAX_JOB_NUMBER ? 1 : current + 1
    return `job_${current}`
  }

  save() {
    this.store?.save(this.#serializedRecords(), {
      nextJobNumber: this.nextJobNumber,
    })
  }

  saveDeferred() {
    const tasks = this.#serializedRecords()
    const state = { nextJobNumber: this.nextJobNumber }
    if (this.store?.saveDeferred) this.store.saveDeferred(tasks, state)
    else this.store?.save(tasks, state)
  }

  #serializedRecords() {
    return [...this.records.values()].map(this.serialize)
  }
}
