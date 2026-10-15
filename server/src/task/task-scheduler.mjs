function limit(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : fallback
}

export class TaskScheduler {
  constructor({
    maxConcurrent = 1,
    maxConcurrentPerOwner = 1,
  } = {}) {
    this.maxConcurrent = limit(maxConcurrent, 1)
    this.maxConcurrentPerOwner = limit(maxConcurrentPerOwner, 1)
    this.active = new Map()
  }

  count(predicate) {
    let total = 0
    for (const task of this.active.values()) {
      if (predicate(task)) total += 1
    }
    return total
  }

  canStart(task) {
    if (this.active.size >= this.maxConcurrent) return false
    if (
      this.count(active => active.ownerId === task.ownerId)
      >= this.maxConcurrentPerOwner
    ) return false
    if (!task.laneKey) return true
    return (
      this.count(active => active.laneKey === task.laneKey)
      < limit(task.laneLimit, 1)
    )
  }

  acquire(task) {
    this.active.set(task.id, task)
  }

  release(task) {
    this.active.delete(task.id)
  }
}
