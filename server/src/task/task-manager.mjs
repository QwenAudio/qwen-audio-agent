import { randomUUID } from 'node:crypto'
import { config } from '../core/config.mjs'
import { TaskScheduler } from './task-scheduler.mjs'
import { TaskStore } from './task-store.mjs'
import { TaskDomainEvent } from './task-events.mjs'
import { TaskNotificationQueue } from './task-notification-queue.mjs'
import { logger } from '../core/logger.mjs'

const ACTIVE = new Set([
  'queued',
  'running',
  'delegated',
  'finalizing',
  'cancelling',
])
const CANCELLABLE = new Set(['scheduled', 'queued', 'running', 'delegated', 'finalizing'])
const TERMINAL = new Set(['completed', 'failed', 'cancelled'])
const REPLAYABLE_REMINDER = new Set(['queued', 'running'])
const MAX_JOB_NUMBER = 99_999

function normalizedJobNumber(value) {
  const number = Number(value)
  return Number.isInteger(number) && number >= 1 && number <= MAX_JOB_NUMBER
    ? number
    : 1
}

export function taskExecutionContext(task, { onEvent, signal }) {
  return Object.freeze({
    taskId: String(task.id),
    jobId: String(task.jobId || ''),
    ownerId: String(task.ownerId || ''),
    sessionId: String(task.sessionId || 'main'),
    turnId: task.turnId || null,
    kind: String(task.kind || 'work'),
    schedule: task.schedule ? Object.freeze({ ...task.schedule }) : null,
    onEvent,
    signal,
  })
}

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
    jobId: task.jobId,
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
    schedule: task.schedule || null,
    timeoutMs: task.timeoutMs || null,
    progressCheckMs: task.progressCheckMs || null,
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
    progressCheckMs = config.backgroundTaskProgressCheckMs,
    logger: taskLogger = null,
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
    this.progressCheckMs = Math.max(0, Number(progressCheckMs) || 0)
    this.logger = taskLogger
    this.tasks = new Map()
    this.listeners = new Set()
    this.notifications = new TaskNotificationQueue({
      tasks: this.tasks,
      snapshot: publicTask,
      claimTtlMs: () => this.notificationClaimTtlMs,
      onChanged: () => this.persist(),
      onDelivered: task => this.emit(
        TaskDomainEvent.NOTIFICATION_DELIVERED,
        task,
        { persist: false },
      ),
    })
    this.recoveryCandidates = []
    this.scheduledTaskRunner = null
    this.nextJobNumber = 1
    this.restore()
  }

  configureRetention(options = {}) {
    Object.assign(this, options)
    this.prune()
  }

  configureScheduledTaskRunner(runner) {
    this.scheduledTaskRunner = runner
  }

  restore() {
    const savedTasks = this.store?.load() || []
    this.nextJobNumber = normalizedJobNumber(this.store?.nextJobNumber)
    for (const saved of savedTasks) {
      saved.jobId = String(saved.jobId || this.allocateJobId())
      // Scheduled tasks survive restarts intact. ReminderScheduler.start()
      // handles overdue vs future dispatch. Reminders that had already fired
      // (queued/running) when the Gateway stopped are also restored as
      // scheduled: their runner only speaks the stored text, so re-firing
      // them as overdue catch-up is safe and they are never silently lost.
      const restartAsScheduled = (
        saved.kind === 'reminder'
        && REPLAYABLE_REMINDER.has(saved.status)
      )
      if (saved.status === 'scheduled' || restartAsScheduled) {
        const task = {
          ...saved,
          status: 'scheduled',
          runner: saved.kind === 'reminder'
            ? async (obj) => ({
                content: obj,
                metadata: { presentation: { speech: obj } },
              })
            : null, // scheduled_task runner set from scheduledTaskRunner in start()
          resolve: null,
          promise: null,
          activity: Array.isArray(saved.activity) ? saved.activity : [],
          abortController: null,
          schedulerHeld: false,
          timeoutTimer: null,
          progressCheckTimer: null,
        }
        task.promise = new Promise(resolve => {
          task.resolve = resolve
        })
        this.tasks.set(task.id, task)
        continue
      }
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
        timeoutTimer: null,
        progressCheckTimer: null,
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
        this.emit(TaskDomainEvent.FAILED, task)
        this.emit(TaskDomainEvent.NOTIFICATION_PENDING, task)
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
    this.store?.save(
      [...this.tasks.values()].map(task => this.persistedTask(task)),
      { nextJobNumber: this.nextJobNumber },
    )
  }

  persistDeferred() {
    const tasks = [...this.tasks.values()].map(task => this.persistedTask(task))
    const state = { nextJobNumber: this.nextJobNumber }
    if (this.store?.saveDeferred) this.store.saveDeferred(tasks, state)
    else this.store?.save(tasks, state)
  }

  allocateJobId() {
    const current = this.nextJobNumber
    this.nextJobNumber = current >= MAX_JOB_NUMBER ? 1 : current + 1
    return `job_${current}`
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
    const log = [
      TaskDomainEvent.SCHEDULED,
      'task.created',
      TaskDomainEvent.RUNNING,
      TaskDomainEvent.DELEGATED,
      TaskDomainEvent.PERMISSION_REQUESTED,
      TaskDomainEvent.PERMISSION_RESOLVED,
      TaskDomainEvent.COMPLETED,
      TaskDomainEvent.FAILED,
      TaskDomainEvent.CANCELLED,
    ].includes(type) ? this.logger?.info : this.logger?.debug
    log?.(type, {
      taskId: task.id,
      ownerId: task.ownerId,
      sessionId: task.sessionId,
      turnId: task.turnId,
      kind: task.kind || 'work',
      status: task.status,
      elapsedMs: task.elapsedMs,
      hasError: Boolean(task.error),
    })
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
      jobId: this.allocateJobId(),
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
      progressCheckMs: String(kind || 'work') === 'work'
        ? this.progressCheckMs
        : null,
    }
    task.promise = new Promise(resolve => {
      task.resolve = resolve
    })
    this.tasks.set(task.id, task)
    this.emit(TaskDomainEvent.ACCEPTED, task)
    queueMicrotask(() => this.drain())
    return { ...publicTask(task), reused: false }
  }

  createScheduled({
    objective,
    ownerId,
    sessionId,
    turnId,
    schedule: { at, recurrence = 'once' } = {},
    type = 'reminder',
    timeoutMs = null,
    runner = null,
  }) {
    const kind = type === 'task' ? 'scheduled_task' : 'reminder'
    const task = {
      id: `work_${randomUUID()}`,
      jobId: this.allocateJobId(),
      status: 'scheduled',
      kind,
      objective: String(objective || '').trim(),
      ownerId: String(ownerId || ''),
      sessionId: String(sessionId || 'main'),
      turnId: turnId || null,
      priority: 0,
      parentWorkId: null,
      schedule: { type: 'at', at: Number(at), recurrence },
      timeoutMs: type === 'task'
        ? Number(timeoutMs) || config.scheduledTaskTimeoutMs
        : null,
      progressCheckMs: null,
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
      runner: runner || (async (obj) => ({
        content: obj,
        metadata: { presentation: { speech: obj } },
      })),
      canceler: null,
      cancelPromise: null,
      terminalHandled: false,
      abortController: null,
      schedulerHeld: false,
      timeoutTimer: null,
      progressCheckTimer: null,
    }
    task.promise = new Promise(resolve => {
      task.resolve = resolve
    })
    this.tasks.set(task.id, task)
    this.emit(TaskDomainEvent.SCHEDULED, task)
    // Do not call drain() — scheduled tasks wait for their timer.
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
    this.emit(TaskDomainEvent.RUNNING, task)
    task.progressTimer = setInterval(() => {
      if (ACTIVE.has(task.status)) {
        this.emit(TaskDomainEvent.PROGRESS, task, { persist: false })
      }
    }, 1000)
    task.progressTimer.unref?.()
    const onEvent = event => {
      if (event?.type === 'backend.permission.requested' && event.permission) {
        task.authorization = { ...event.permission }
        this.emit(TaskDomainEvent.PERMISSION_REQUESTED, task)
        return
      }
      if (event?.type === 'backend.permission.resolved' && event.permission) {
        if (task.authorization?.id === event.permission.id) {
          task.authorization = null
        }
        this.emit(TaskDomainEvent.PERMISSION_RESOLVED, task, {
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
        this.emit(TaskDomainEvent.DELEGATED, task)
        this.drain()
        return
      }
      if (
        event?.type === 'backend.delegation.completed'
        && event.delegation
      ) {
        task.status = 'finalizing'
        task.delegation = { ...event.delegation, status: 'completed' }
        this.emit(TaskDomainEvent.FINALIZING, task)
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
      this.emit(TaskDomainEvent.PROGRESS, task, { persist: false })
      this.persistDeferred()
    }
    // Fallback runner for restored scheduled tasks whose runner was lost
    // during serialisation.
    if (typeof task.runner !== 'function'
      && task.kind === 'scheduled_task'
      && typeof this.scheduledTaskRunner === 'function'
    ) {
      task.runner = this.scheduledTaskRunner
    }
    // Hard timeout watchdog for scheduled tasks (borrowed from OpenClaw's
    // per-run wall-clock budget). Aborts the runner, then gives a 5-second
    // cleanup window before force-failing.
    if (task.kind === 'scheduled_task' && task.timeoutMs) {
      task.timeoutTimer = setTimeout(() => {
        if (!ACTIVE.has(task.status)) return
        task.abortController?.abort(
          new Error('定时任务执行超时，正在终止'),
        )
        const cleanup = setTimeout(() => {
          if (!ACTIVE.has(task.status)) return
          task.terminalHandled = true
          task.status = 'failed'
          task.error = `定时任务执行超时（${Math.round(task.timeoutMs / 60000)} 分钟）`
          task.completedAt = Date.now()
          task.elapsedMs = task.startedAt
            ? task.completedAt - task.startedAt : 0
          task.notificationStatus = 'pending'
          clearInterval(task.progressTimer)
          task.progressTimer = null
          clearInterval(task.progressCheckTimer)
          task.progressCheckTimer = null
          if (task.schedulerHeld) {
            this.scheduler.release(task)
            task.schedulerHeld = false
          }
          this.emit(TaskDomainEvent.FAILED, task)
          this.emit(TaskDomainEvent.NOTIFICATION_PENDING, task)
          this.persistDeferred()
          this.drain()
        }, 5000)
        cleanup.unref?.()
      }, task.timeoutMs)
      task.timeoutTimer.unref?.()
    }
    // Interactive background work reports long-running progress. Scheduled
    // work stays quiet until it completes, fails, or needs permission.
    if (task.kind === 'work' && task.progressCheckMs) {
      task.progressCheckTimer = setInterval(() => {
        if (!ACTIVE.has(task.status)) {
          clearInterval(task.progressCheckTimer)
          task.progressCheckTimer = null
          return
        }
        const lastActivity = task.activity.at(-1)
        const elapsedMin = Math.round(
          (Date.now() - (task.startedAt || Date.now())) / 60000,
        )
        let message
        if (lastActivity) {
          const verb = {
            run: '执行',
            read: '读取',
            write: '修改',
            search: '搜索',
            image: '生成图片',
          }[lastActivity.category] || '处理'
          const detail = lastActivity.detail
            ? ` ${lastActivity.detail}` : ''
          message = `任务"${task.objective.slice(0, 80)}"`
            + `已运行 ${elapsedMin} 分钟，正在${verb}${detail}`
            + `（${lastActivity.status}）`
        } else {
          message = `任务"${task.objective.slice(0, 80)}"`
            + `已运行 ${elapsedMin} 分钟，正在处理中`
        }
        this.emit(TaskDomainEvent.PROGRESS_CHECK, task, {
          persist: false,
          message,
          delegated: task.status === 'delegated',
        })
      }, task.progressCheckMs)
      task.progressCheckTimer.unref?.()
    }
    Promise.resolve()
      .then(() => {
        if (typeof task.runner !== 'function') {
          throw new Error('未配置后台 Agent 执行器')
        }
        return task.runner(task.objective, taskExecutionContext(task, {
          onEvent,
          signal: task.abortController.signal,
        }))
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
        if (task.timeoutTimer) { clearTimeout(task.timeoutTimer); task.timeoutTimer = null }
        if (task.progressCheckTimer) { clearInterval(task.progressCheckTimer); task.progressCheckTimer = null }
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
          task.status === 'completed'
            ? TaskDomainEvent.COMPLETED
            : TaskDomainEvent.FAILED,
          task,
        )
        this.emit(TaskDomainEvent.NOTIFICATION_PENDING, task)
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
    if (previousStatus === 'queued' || previousStatus === 'scheduled') {
      return this.finishCancellation(task)
    }
    task.status = 'cancelling'
    task.authorization = null
    this.emit(TaskDomainEvent.CANCELLING, task)
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
        if (task.timeoutTimer) { clearTimeout(task.timeoutTimer); task.timeoutTimer = null }
        if (task.progressCheckTimer) { clearInterval(task.progressCheckTimer); task.progressCheckTimer = null }
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
        this.emit(TaskDomainEvent.FAILED, task)
        this.emit(TaskDomainEvent.NOTIFICATION_PENDING, task)
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
    if (task.timeoutTimer) { clearTimeout(task.timeoutTimer); task.timeoutTimer = null }
    if (task.progressCheckTimer) { clearInterval(task.progressCheckTimer); task.progressCheckTimer = null }
    task.abortController = null
    if (task.schedulerHeld) {
      this.scheduler.release(task)
      task.schedulerHeld = false
    }
    this.emit(TaskDomainEvent.CANCELLED, task)
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

  getByJobId(jobId, { ownerId } = {}) {
    const normalized = String(jobId || '')
    const task = [...this.tasks.values()]
      .filter(item => (
        item.jobId === normalized
        && (ownerId === undefined || item.ownerId === String(ownerId))
      ))
      .sort((left, right) => right.createdAt - left.createdAt)[0]
    return task ? publicTask(task) : null
  }

  list({
    ownerId,
    sessionId,
    active = false,
  } = {}) {
    this.prune()
    return [...this.tasks.values()]
      .filter(task => (
        (ownerId === undefined || task.ownerId === String(ownerId))
        && (sessionId === undefined || task.sessionId === String(sessionId))
        && (!active || ACTIVE.has(task.status))
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
    return this.notifications.claim({
      ownerId,
      sessionId,
      includeOtherSessions,
      claimantId,
      taskIds,
    })
  }

  markNotificationsDelivered(taskIds, { claimantId } = {}) {
    return this.notifications.markDelivered(taskIds, { claimantId })
  }

  renewNotificationClaims(taskIds, { claimantId } = {}) {
    return this.notifications.renew(taskIds, { claimantId })
  }

  releaseNotificationClaims(taskIds, { claimantId } = {}) {
    return this.notifications.release(taskIds, { claimantId })
  }

  reclaimExpiredNotificationClaims(now = Date.now(), { persist = true } = {}) {
    return this.notifications.reclaimExpired(now, { persist })
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
  onWarning: warning => logger.warn('task.persistence_warning', { warning }),
})

export const taskManager = new TaskManager({
  store: taskStore,
  logger,
  maxConcurrent: config.taskMaxConcurrent,
  maxConcurrentPerOwner: config.taskMaxConcurrentPerOwner,
  terminalTtlMs: config.taskTerminalTtlMs,
  pendingNotificationTtlMs: config.taskPendingNotificationTtlMs,
  maxTerminalTasksPerOwner: config.maxTerminalTasksPerOwner,
})
