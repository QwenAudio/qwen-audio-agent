import { randomUUID } from 'node:crypto'
import { config } from '../core/config.mjs'
import { TaskScheduler } from './task-scheduler.mjs'
import { TaskStore } from './task-store.mjs'

const ACTIVE = new Set([
  'queued',
  'running',
  'delegated',
  'finalizing',
  'cancelling',
])
const CANCELLABLE = new Set(['queued', 'running', 'delegated', 'finalizing'])
const TERMINAL = new Set(['completed', 'failed', 'cancelled'])

function publicResultMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object') return null
  const source = metadata.presentation || metadata.decision?.presentation
  if (!source || typeof source !== 'object') return null
  const inline = source.inline && typeof source.inline === 'object'
    && typeof source.inline.content === 'string'
    && source.inline.content.trim()
    ? {
        title: typeof source.inline.title === 'string'
          ? source.inline.title.slice(0, 120)
          : '',
        format: ['markdown', 'code', 'link'].includes(source.inline.format)
          ? source.inline.format
          : 'markdown',
        content: source.inline.content,
      }
    : null
  const speech = typeof source.speech === 'string' ? source.speech : ''
  if (!speech && !inline) return null
  return { presentation: { speech, inline } }
}

function publicTask(task) {
  const now = Date.now()
  return {
    id: task.id,
    workId: task.id,
    workState: ACTIVE.has(task.status) ? 'active' : task.status,
    status: task.status,
    kind: task.kind || 'work',
    parentWorkId: task.parentWorkId || null,
    objective: task.objective,
    ownerId: task.ownerId,
    sessionId: task.sessionId,
    turnId: task.turnId,
    createdAt: task.createdAt,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
    elapsedMs: task.startedAt && ACTIVE.has(task.status)
      ? now - task.startedAt
      : task.elapsedMs,
    result: task.result,
    error: task.error,
    resultMetadata: publicResultMetadata(task.resultMetadata),
    activity: [...(task.activity || [])],
    delegation: task.delegation
      ? {
          status: task.delegation.status || 'running',
          title: String(task.delegation.title || '').slice(0, 160),
          presentation: task.delegation.presentation
            ? {
                speech: String(
                  task.delegation.presentation.speech || '',
                ).slice(0, 1200),
                inline: task.delegation.presentation.inline || null,
              }
            : null,
        }
      : null,
    authorization: task.authorization
      ? { ...task.authorization }
      : null,
    notificationStatus: task.notificationStatus,
    notificationDeliveredAt: task.notificationDeliveredAt,
  }
}

export class TaskManager {
  constructor({
    runner = null,
    store = null,
    maxConcurrent = 4,
    maxConcurrentPerOwner = 2,
    terminalTtlMs = 86_400_000,
    pendingNotificationTtlMs = 604_800_000,
    notificationClaimTtlMs = 60_000,
    maxTerminalTasksPerOwner = 100,
  } = {}) {
    this.runner = runner
    this.store = store
    this.scheduler = new TaskScheduler({
      maxConcurrent,
      maxConcurrentPerOwner,
    })
    this.terminalTtlMs = terminalTtlMs
    this.pendingNotificationTtlMs = pendingNotificationTtlMs
    this.notificationClaimTtlMs = notificationClaimTtlMs
    this.maxTerminalTasksPerOwner = maxTerminalTasksPerOwner
    this.tasks = new Map()
    this.listeners = new Set()
    this.recoveryCandidates = []
    this.restore()
  }

  configureRetention(options = {}) {
    Object.assign(this, options)
    this.prune()
  }

  restore() {
    for (const saved of this.store?.load() || []) {
      const wasActive = ACTIVE.has(saved.status)
      const canRecoverDelegation = (
        ['delegated', 'finalizing'].includes(saved.status)
        && saved.delegation?.id
        && saved.delegation?.sessionId
      )
      const task = {
        ...saved,
        status: canRecoverDelegation
          ? 'queued'
          : wasActive ? 'failed' : saved.status,
        error: wasActive && !canRecoverDelegation
          ? 'qwen-audio-agent 重启时这项工作尚未完成，请重新提交。'
          : saved.error || null,
        completedAt: wasActive && !canRecoverDelegation
          ? Date.now()
          : saved.completedAt,
        activity: Array.isArray(saved.activity) ? saved.activity : [],
        delegation: canRecoverDelegation || !wasActive
          ? saved.delegation || null
          : null,
        authorization: wasActive || TERMINAL.has(saved.status)
          ? null
          : saved.authorization || null,
        notificationStatus: (
          (wasActive && !canRecoverDelegation)
          || saved.notificationStatus === 'delivering'
        )
          ? 'pending'
          : canRecoverDelegation ? 'none' : saved.notificationStatus || 'none',
        notificationClaimantId: null,
        notificationClaimedAt: null,
        resolve: null,
        promise: null,
        runner: null,
      }
      if (canRecoverDelegation) {
        task.promise = new Promise(resolve => {
          task.resolve = resolve
        })
        this.recoveryCandidates.push(task)
      } else {
        task.promise = Promise.resolve(publicTask(task))
      }
      this.tasks.set(task.id, task)
    }
    this.prune()
  }

  persistedTask(task) {
    const saved = publicTask(task)
    delete saved.workId
    delete saved.workState
    saved.submissionKey = task.submissionKey || null
    saved.delegation = task.delegation
      ? {
          ...task.delegation,
          presentation: task.delegation.presentation
            ? { ...task.delegation.presentation }
            : null,
        }
      : null
    return saved
  }

  recoverDelegated({
    canRecover,
    runner,
    canceler,
  } = {}) {
    const candidates = this.recoveryCandidates.splice(0)
    for (const task of candidates) {
      const snapshot = {
        ...publicTask(task),
        delegation: task.delegation ? { ...task.delegation } : null,
      }
      if (!canRecover?.(snapshot)) {
        task.status = 'failed'
        task.error = 'qwen-audio-agent 重启时这项项目任务失去连接，请重新提交。'
        task.completedAt = Date.now()
        task.notificationStatus = 'pending'
        task.promise = Promise.resolve(publicTask(task))
        task.resolve = null
        this.emit('task.failed', task)
        this.emit('task.notification.pending', task)
        continue
      }
      task.runner = (_objective, context) => runner(snapshot, context)
      task.canceler = typeof canceler === 'function'
        ? context => canceler(snapshot, context)
        : null
      this.start(task)
    }
  }

  persist() {
    this.store?.save([...this.tasks.values()].map(task => (
      this.persistedTask(task)
    )))
  }

  persistDeferred() {
    const tasks = [...this.tasks.values()].map(task => this.persistedTask(task))
    if (this.store?.saveDeferred) this.store.saveDeferred(tasks)
    else this.store?.save(tasks)
  }

  subscribe(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit(type, task, { persist = true, ...details } = {}) {
    const snapshot = publicTask(task)
    const event = {
      type,
      ownerId: task.ownerId,
      task: snapshot,
      ...details,
    }
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        // One observer must not break the work queue.
      }
    }
    if (persist) this.persist()
  }

  create({
    objective,
    ownerId,
    sessionId,
    turnId,
    submissionKey,
    laneKey,
    laneLimit = 1,
    kind = 'work',
    parentWorkId = null,
    priority = 0,
    runner,
    canceler,
  }) {
    const normalizedOwnerId = String(ownerId || '')
    const normalizedSubmissionKey = String(submissionKey || '').trim()
    if (normalizedSubmissionKey) {
      const existing = [...this.tasks.values()].find(item => (
        item.ownerId === normalizedOwnerId
        && item.submissionKey === normalizedSubmissionKey
      ))
      if (existing) return { ...publicTask(existing), reused: true }
    }
    const task = {
      id: `work_${randomUUID()}`,
      status: 'queued',
      kind: String(kind || 'work'),
      parentWorkId: parentWorkId ? String(parentWorkId) : null,
      priority: Number.isFinite(Number(priority)) ? Number(priority) : 0,
      objective: String(objective || '').trim(),
      ownerId: normalizedOwnerId,
      sessionId: String(sessionId || 'main'),
      turnId: turnId || null,
      submissionKey: normalizedSubmissionKey || null,
      laneKey: laneKey || null,
      laneLimit,
      createdAt: Date.now(),
      startedAt: null,
      completedAt: null,
      elapsedMs: 0,
      result: null,
      error: null,
      resultMetadata: null,
      activity: [],
      delegation: null,
      cancellation: null,
      authorization: null,
      notificationStatus: 'none',
      notificationClaimantId: null,
      notificationClaimedAt: null,
      runner: runner || this.runner,
      canceler: typeof canceler === 'function' ? canceler : null,
      cancelPromise: null,
      terminalHandled: false,
      abortController: null,
      schedulerHeld: false,
    }
    task.promise = new Promise(resolve => {
      task.resolve = resolve
    })
    this.tasks.set(task.id, task)
    this.emit('task.accepted', task)
    queueMicrotask(() => this.drain())
    return { ...publicTask(task), reused: false }
  }

  drain() {
    const queued = [...this.tasks.values()]
      .filter(task => task.status === 'queued')
      .sort((left, right) => (
        Number(right.priority || 0) - Number(left.priority || 0)
        || left.createdAt - right.createdAt
      ))
    for (const task of queued) {
      if (!this.scheduler.canStart(task)) continue
      this.start(task)
    }
  }

  start(task) {
    task.status = 'running'
    task.startedAt = Date.now()
    task.abortController = new AbortController()
    this.scheduler.acquire(task)
    task.schedulerHeld = true
    this.emit('task.running', task)
    task.progressTimer = setInterval(() => {
      if (ACTIVE.has(task.status)) {
        this.emit('task.progress', task, { persist: false })
      }
    }, 1000)
    task.progressTimer.unref?.()
    const onEvent = event => {
      if (event?.type === 'backend.permission.requested' && event.permission) {
        task.authorization = { ...event.permission }
        this.emit('task.permission.requested', task)
        return
      }
      if (event?.type === 'backend.permission.resolved' && event.permission) {
        if (task.authorization?.id === event.permission.id) {
          task.authorization = null
        }
        this.emit('task.permission.resolved', task, {
          permission: { ...event.permission },
        })
        return
      }
      if (['cancelling', 'cancelled'].includes(task.status)) return
      if (event?.type === 'backend.delegated' && event.delegation) {
        task.status = 'delegated'
        task.delegation = { ...event.delegation }
        if (task.schedulerHeld) {
          this.scheduler.release(task)
          task.schedulerHeld = false
        }
        this.emit('task.delegated', task)
        this.drain()
        return
      }
      if (
        event?.type === 'backend.delegation.completed'
        && event.delegation
      ) {
        task.status = 'finalizing'
        task.delegation = { ...event.delegation, status: 'completed' }
        this.emit('task.finalizing', task)
        return
      }
      if (event?.type !== 'backend.activity' || !event.activity) return
      const activity = event.activity
      const index = activity.id
        ? task.activity.findIndex(item => item.id === activity.id)
        : -1
      if (index >= 0) task.activity[index] = activity
      else task.activity.push(activity)
      task.activity = task.activity.slice(-20)
      this.emit('task.progress', task, { persist: false })
      this.persistDeferred()
    }
    Promise.resolve()
      .then(() => {
        if (typeof task.runner !== 'function') {
          throw new Error('未配置后台 Agent 执行器')
        }
        return task.runner(task.objective, {
          onEvent,
          signal: task.abortController.signal,
        })
      })
      .then(outcome => {
        if (
          task.terminalHandled
          || ['cancelling', 'cancelled'].includes(task.status)
        ) return
        task.status = 'completed'
        task.result = String(outcome?.content ?? outcome ?? '').trim()
        task.resultMetadata = outcome?.metadata || null
      })
      .catch(error => {
        if (
          task.terminalHandled
          || ['cancelling', 'cancelled'].includes(task.status)
        ) return
        task.status = 'failed'
        task.error = error?.message || String(error)
      })
      .finally(() => {
        if (task.terminalHandled) return
        clearInterval(task.progressTimer)
        task.progressTimer = null
        task.abortController = null
        task.authorization = null
        if (task.status === 'cancelling') return
        if (task.status === 'cancelled') {
          if (task.schedulerHeld) {
            this.scheduler.release(task)
            task.schedulerHeld = false
          }
          this.drain()
          return
        }
        task.completedAt = Date.now()
        task.elapsedMs = task.startedAt
          ? task.completedAt - task.startedAt
          : 0
        task.notificationStatus = 'pending'
        task.terminalHandled = true
        if (task.schedulerHeld) {
          this.scheduler.release(task)
          task.schedulerHeld = false
        }
        this.emit(
          task.status === 'completed' ? 'task.completed' : 'task.failed',
          task,
        )
        this.emit('task.notification.pending', task)
        task.resolve?.(publicTask(task))
        this.prune()
        this.drain()
      })
  }

  async cancel(id, { ownerId } = {}) {
    const task = this.tasks.get(String(id))
    if (
      !task
      || (ownerId !== undefined && task.ownerId !== String(ownerId))
      || (!CANCELLABLE.has(task.status) && task.status !== 'cancelling')
    ) {
      return null
    }
    if (task.cancelPromise) return task.cancelPromise
    const previousStatus = task.status
    if (previousStatus === 'queued') {
      return this.finishCancellation(task)
    }
    task.status = 'cancelling'
    task.authorization = null
    this.emit('task.cancelling', task)
    task.cancelPromise = Promise.resolve()
      .then(async () => {
        if (task.canceler) {
          const cancellation = await task.canceler({
            task: publicTask(task),
            previousStatus,
            abort: reason => task.abortController?.abort(
              reason || new Error('用户已取消这项工作'),
            ),
          })
          if (cancellation && typeof cancellation === 'object') {
            task.cancellation = { ...cancellation }
          }
        } else {
          task.abortController?.abort(new Error('用户已取消这项工作'))
        }
        return this.finishCancellation(task)
      })
      .catch(error => {
        task.abortController?.abort(
          error instanceof Error ? error : new Error(String(error)),
        )
        clearInterval(task.progressTimer)
        task.progressTimer = null
        task.abortController = null
        task.authorization = null
        task.status = 'failed'
        task.error = `取消失败：${error?.message || String(error)}`
        task.completedAt = Date.now()
        task.elapsedMs = task.startedAt
          ? task.completedAt - task.startedAt
          : 0
        task.notificationStatus = 'pending'
        task.terminalHandled = true
        if (task.schedulerHeld) {
          this.scheduler.release(task)
          task.schedulerHeld = false
        }
        this.emit('task.failed', task)
        this.emit('task.notification.pending', task)
        task.resolve?.(publicTask(task))
        this.prune()
        this.drain()
        return publicTask(task)
      })
    return task.cancelPromise
  }

  finishCancellation(task) {
    task.status = 'cancelled'
    task.authorization = null
    task.completedAt = Date.now()
    task.elapsedMs = task.startedAt
      ? task.completedAt - task.startedAt
      : 0
    task.error = null
    task.notificationStatus = 'none'
    task.terminalHandled = true
    clearInterval(task.progressTimer)
    task.progressTimer = null
    task.abortController = null
    if (task.schedulerHeld) {
      this.scheduler.release(task)
      task.schedulerHeld = false
    }
    this.emit('task.cancelled', task)
    task.resolve?.(publicTask(task))
    this.prune()
    this.drain()
    return publicTask(task)
  }

  get(id, { ownerId } = {}) {
    const task = this.tasks.get(String(id))
    if (!task || (ownerId !== undefined && task.ownerId !== String(ownerId))) {
      return null
    }
    return publicTask(task)
  }

  list({
    ownerId,
    sessionId,
    active = false,
    includeControl = false,
  } = {}) {
    this.prune()
    return [...this.tasks.values()]
      .filter(task => (
        (ownerId === undefined || task.ownerId === String(ownerId))
        && (sessionId === undefined || task.sessionId === String(sessionId))
        && (!active || ACTIVE.has(task.status))
        && (includeControl || task.kind !== 'control')
      ))
      .sort((left, right) => right.createdAt - left.createdAt)
      .map(publicTask)
  }

  wait(id) {
    const task = this.tasks.get(String(id))
    return task?.promise || Promise.resolve(null)
  }

  claimNotifications({
    ownerId,
    sessionId,
    includeOtherSessions = false,
    claimantId,
    taskIds,
  }) {
    this.reclaimExpiredNotificationClaims()
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
      task.notificationClaimedAt = Date.now()
      claimed.push(publicTask(task))
    }
    if (claimed.length) this.persist()
    return claimed.sort((a, b) => a.createdAt - b.createdAt)
  }

  markNotificationsDelivered(taskIds, { claimantId } = {}) {
    let delivered = 0
    for (const id of taskIds || []) {
      const task = this.tasks.get(String(id))
      if (
        !task
        || task.notificationStatus !== 'delivering'
        || (
          claimantId !== undefined
          && task.notificationClaimantId !== claimantId
        )
      ) continue
      task.notificationStatus = 'delivered'
      task.notificationClaimantId = null
      task.notificationClaimedAt = null
      task.notificationDeliveredAt = Date.now()
      delivered += 1
      this.emit('task.notification.delivered', task, { persist: false })
    }
    if (delivered) this.persist()
    return delivered
  }

  renewNotificationClaims(taskIds, { claimantId } = {}) {
    let renewed = 0
    const now = Date.now()
    for (const id of taskIds || []) {
      const task = this.tasks.get(String(id))
      if (
        !task
        || task.notificationStatus !== 'delivering'
        || (
          claimantId !== undefined
          && task.notificationClaimantId !== claimantId
        )
      ) continue
      task.notificationClaimedAt = now
      renewed += 1
    }
    return renewed
  }

  releaseNotificationClaims(taskIds, { claimantId } = {}) {
    let released = 0
    for (const id of taskIds || []) {
      const task = this.tasks.get(String(id))
      if (
        !task
        || task.notificationStatus !== 'delivering'
        || (
          claimantId !== undefined
          && task.notificationClaimantId !== claimantId
        )
      ) continue
      task.notificationStatus = 'pending'
      task.notificationClaimantId = null
      task.notificationClaimedAt = null
      released += 1
    }
    if (released) this.persist()
    return released
  }

  reclaimExpiredNotificationClaims(now = Date.now(), { persist = true } = {}) {
    let reclaimed = 0
    for (const task of this.tasks.values()) {
      if (
        task.notificationStatus !== 'delivering'
        || !task.notificationClaimedAt
        || now - task.notificationClaimedAt < this.notificationClaimTtlMs
      ) continue
      task.notificationStatus = 'pending'
      task.notificationClaimantId = null
      task.notificationClaimedAt = null
      reclaimed += 1
    }
    if (reclaimed && persist) this.persist()
    return reclaimed
  }

  prune() {
    const now = Date.now()
    let changed = this.reclaimExpiredNotificationClaims(now, { persist: false }) > 0
    const terminalByOwner = new Map()
    for (const task of this.tasks.values()) {
      if (!TERMINAL.has(task.status)) continue
      const age = now - (task.completedAt || task.createdAt)
      const awaitingDelivery = ['pending', 'delivering'].includes(
        task.notificationStatus,
      )
      const ttl = awaitingDelivery
        ? this.pendingNotificationTtlMs
        : this.terminalTtlMs
      if (age > ttl) {
        this.tasks.delete(task.id)
        changed = true
        continue
      }
      if (awaitingDelivery) continue
      const items = terminalByOwner.get(task.ownerId) || []
      items.push(task)
      terminalByOwner.set(task.ownerId, items)
    }
    for (const tasks of terminalByOwner.values()) {
      tasks
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(this.maxTerminalTasksPerOwner)
        .forEach(task => {
          this.tasks.delete(task.id)
          changed = true
        })
    }
    if (changed) this.persist()
  }
}

export const taskStore = new TaskStore({
  filePath: config.taskStatePath,
})

export const taskManager = new TaskManager({
  store: taskStore,
  maxConcurrent: config.taskMaxConcurrent,
  maxConcurrentPerOwner: config.taskMaxConcurrentPerOwner,
  terminalTtlMs: config.taskTerminalTtlMs,
  pendingNotificationTtlMs: config.taskPendingNotificationTtlMs,
  maxTerminalTasksPerOwner: config.maxTerminalTasksPerOwner,
})
