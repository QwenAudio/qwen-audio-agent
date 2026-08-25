/**
 * Owns the delivery lease for completed Work notifications.
 *
 * Task execution and transport delivery stay outside this class. It only
 * mutates notification fields on the shared Work records and reports durable
 * changes to its owner.
 */
export class TaskNotificationQueue {
  constructor({
    tasks,
    snapshot,
    claimTtlMs,
    onChanged = () => {},
    onDelivered = () => {},
    now = () => Date.now(),
  }) {
    this.tasks = tasks
    this.snapshot = snapshot
    this.claimTtlMs = claimTtlMs
    this.onChanged = onChanged
    this.onDelivered = onDelivered
    this.now = now
  }

  claim({
    ownerId,
    sessionId,
    includeOtherSessions = false,
    claimantId,
    taskIds,
  }) {
    this.reclaimExpired()
    const requested = taskIds?.length ? new Set(taskIds.map(String)) : null
    const claimed = []
    for (const task of this.tasks.values()) {
      if (
        task.ownerId !== String(ownerId)
        || task.notificationStatus !== 'pending'
        || (
          sessionId !== undefined
          && !includeOtherSessions
          && task.sessionId !== String(sessionId)
        )
        || (requested && !requested.has(task.id))
      ) continue
      task.notificationStatus = 'delivering'
      task.notificationClaimantId = claimantId
      task.notificationClaimedAt = this.now()
      claimed.push(this.snapshot(task))
    }
    if (claimed.length) this.onChanged()
    return claimed.sort((left, right) => left.createdAt - right.createdAt)
  }

  markDelivered(taskIds, { claimantId } = {}) {
    let delivered = 0
    const deliveredTasks = []
    for (const id of taskIds || []) {
      const task = this.#ownedClaim(id, claimantId)
      if (!task) continue
      task.notificationStatus = 'delivered'
      task.notificationClaimantId = null
      task.notificationClaimedAt = null
      task.notificationDeliveredAt = this.now()
      delivered += 1
      deliveredTasks.push(task)
    }
    if (delivered) this.onChanged()
    // Checkpoint the acknowledgement before observers see it. A crash after
    // the event is therefore restored as delivered rather than replayed.
    deliveredTasks.forEach(task => this.onDelivered(task))
    return delivered
  }

  renew(taskIds, { claimantId } = {}) {
    let renewed = 0
    const claimedAt = this.now()
    for (const id of taskIds || []) {
      const task = this.#ownedClaim(id, claimantId)
      if (!task) continue
      task.notificationClaimedAt = claimedAt
      renewed += 1
    }
    return renewed
  }

  release(taskIds, { claimantId } = {}) {
    let released = 0
    for (const id of taskIds || []) {
      const task = this.#ownedClaim(id, claimantId)
      if (!task) continue
      task.notificationStatus = 'pending'
      task.notificationClaimantId = null
      task.notificationClaimedAt = null
      released += 1
    }
    if (released) this.onChanged()
    return released
  }

  reclaimExpired(now = this.now(), { persist = true } = {}) {
    let reclaimed = 0
    const claimTtlMs = Number(this.claimTtlMs())
    for (const task of this.tasks.values()) {
      if (
        task.notificationStatus !== 'delivering'
        || !task.notificationClaimedAt
        || now - task.notificationClaimedAt < claimTtlMs
      ) continue
      task.notificationStatus = 'pending'
      task.notificationClaimantId = null
      task.notificationClaimedAt = null
      reclaimed += 1
    }
    if (reclaimed && persist) this.onChanged()
    return reclaimed
  }

  #ownedClaim(id, claimantId) {
    const task = this.tasks.get(String(id))
    if (
      !task
      || task.notificationStatus !== 'delivering'
      || (
        claimantId !== undefined
        && task.notificationClaimantId !== claimantId
      )
    ) return null
    return task
  }
}
