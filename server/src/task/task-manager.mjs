import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { config } from '../core/config.mjs'
import { TaskScheduler } from './task-scheduler.mjs'
import { TaskStore } from './task-store.mjs'
import { TaskDomainEvent } from './task-events.mjs'
import { TaskNotificationQueue } from './task-notification-queue.mjs'
import { TaskRepository } from './task-repository.mjs'
import {
  artifactsFromOutcome,
  mergeArtifacts,
  normalizeArtifacts,
} from './task-artifact.mjs'
import {
  normalizeAuthorization,
  resolveAuthorization,
} from '../core/work-authorization.mjs'
import {
  normalizeInputRequest,
  resolveInputRequest,
} from '../core/work-input-request.mjs'
import {
  isTaskActive,
  isTaskCancellable,
  isTaskTerminal,
  isUserWork,
  normalizeTaskScope,
  persistedTask,
  publicTask,
  TaskScope,
  TaskStatus,
  transitionTask,
} from './task-state.mjs'
import {
  recoveredNotificationStatus,
  TaskRecoveryAction,
  taskRecoveryAction,
} from './task-recovery.mjs'
import { logger } from '../core/logger.mjs'
import { BackendEventType } from '../core/backend-events.mjs'
import { SessionJournalRegistry } from '../session/session-journal-registry.mjs'

export function taskExecutionContext(task, { onEvent, signal }) {
  return Object.freeze({
    taskId: String(task.id),
    ownerId: String(task.ownerId || ''),
    sessionId: String(task.sessionId || 'main'),
    turnId: task.turnId || null,
    kind: String(task.kind || 'work'),
    schedule: task.schedule ? Object.freeze({ ...task.schedule }) : null,
    onEvent,
    signal,
  })
}

export class TaskManager {
  constructor({
    runner = null,
    store = null,
    maxConcurrent = 4,
    maxConcurrentPerOwner = 2,
    systemMaxConcurrent = 2,
    // 终态任务保留 3 天而非 24 小时：语音场景里「周五派的活周一问」很常见，
    // 24 小时会让隔天的查询就拿不到状态，用户只能重新派一次。
    //
    // 数量上限（maxTerminalTasksPerOwner）保持不变：prune() 按 createdAt 降序
    // 保留最新的那一批，所以放宽时间窗不会让内存无界增长 —— 上限仍然是硬顶。
    terminalTtlMs = 259_200_000,
    pendingNotificationTtlMs = 604_800_000,
    notificationClaimTtlMs = 60_000,
    maxTerminalTasksPerOwner = 100,
    progressEventIntervalMs = 1_000,
    logger: taskLogger = null,
    sessionJournal = null,
  } = {}) {
    this.runner = runner
    this.repository = new TaskRepository({ store, serialize: persistedTask })
    // Compatibility view for ReminderScheduler and existing integrations.
    // New persistence behavior belongs to repository, not this Map-like view.
    this.tasks = this.repository
    this.scheduler = new TaskScheduler({
      maxConcurrent,
      maxConcurrentPerOwner,
    })
    this.systemScheduler = new TaskScheduler({
      maxConcurrent: systemMaxConcurrent,
      maxConcurrentPerOwner: systemMaxConcurrent,
    })
    this.terminalTtlMs = terminalTtlMs
    this.pendingNotificationTtlMs = pendingNotificationTtlMs
    this.notificationClaimTtlMs = notificationClaimTtlMs
    this.maxTerminalTasksPerOwner = maxTerminalTasksPerOwner
    this.progressEventIntervalMs = Math.max(
      50,
      Number(progressEventIntervalMs) || 1_000,
    )
    this.logger = taskLogger
    this.sessionJournal = sessionJournal
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
    this.restore()
    if (this.sessionJournal) this.restoreFromJournal(this.sessionJournal)
  }

  get nextTaskNumber() {
    return this.repository.nextTaskNumber
  }

  set nextTaskNumber(value) {
    this.repository.nextTaskNumber = value
  }

  configureRetention(options = {}) {
    Object.assign(this, options)
    this.prune()
  }

  configureScheduledTaskRunner(runner) {
    this.scheduledTaskRunner = runner
  }

  schedulerFor(task) {
    return isUserWork(task) ? this.scheduler : this.systemScheduler
  }

  releaseScheduler(task) {
    if (!task.schedulerHeld) return
    this.schedulerFor(task).release(task)
    task.schedulerHeld = false
  }

  restore(savedTasks = null) {
    const records = savedTasks || this.repository.load()
    let recoveryChanged = false
    for (const saved of records) {
      saved.scope = normalizeTaskScope(saved.scope)
      if (isUserWork(saved) && !/^task_\d+$/u.test(String(saved.id || ''))) {
        const legacy = /^job_(\d+)$/u.exec(String(saved.jobId || ''))
        const candidate = legacy ? `task_${legacy[1]}` : ''
        saved.id = candidate && !this.tasks.get(candidate)
          ? candidate
          : this.allocateTaskId()
        recoveryChanged = true
      }
      delete saved.jobId
      if (!saved.parentTaskId && saved.parentWorkId) {
        saved.parentTaskId = saved.parentWorkId
      }
      delete saved.parentWorkId
      delete saved.presentation
      delete saved.resultMetadata
      saved.artifacts = normalizeArtifacts(saved.artifacts)
      saved.authorization = normalizeAuthorization(saved.authorization, {
        taskId: saved.id,
      })
      saved.inputRequest = normalizeInputRequest(saved.inputRequest, {
        taskId: saved.id,
      })
      const recovery = taskRecoveryAction(saved)
      if (recovery !== TaskRecoveryAction.RESTORE) recoveryChanged = true
      if (saved.notificationStatus === 'delivering') recoveryChanged = true
      // Scheduled work survives intact. A reminder that was already firing
      // is safe to catch up because its runner only speaks persisted text.
      if (recovery === TaskRecoveryAction.RESCHEDULE) {
        const task = {
          ...saved,
          status: 'scheduled',
          runner: saved.kind === 'reminder'
            ? async obj => ({ content: obj })
            : null, // scheduled_task runner set from scheduledTaskRunner in start()
          resolve: null,
          promise: null,
          activity: Array.isArray(saved.activity) ? saved.activity : [],
          abortController: null,
          schedulerHeld: false,
          notificationStatus: 'none',
          notificationClaimantId: null,
          notificationClaimedAt: null,
          timeoutTimer: null,
        }
        task.promise = new Promise(resolve => {
          task.resolve = resolve
        })
        this.tasks.set(task.id, task)
        continue
      }
      const reattach = recovery === TaskRecoveryAction.REATTACH
      const fail = recovery === TaskRecoveryAction.FAIL
      const cancel = recovery === TaskRecoveryAction.CANCEL
      const task = {
        ...saved,
        status: reattach
          ? 'queued'
          : cancel ? 'cancelled'
            : fail ? 'failed' : saved.status,
        error: fail
          ? 'qwen-audio-agent 重启时这项工作尚未完成，请重新提交。'
          : cancel ? null : saved.error || null,
        completedAt: fail || cancel
          ? Date.now()
          : saved.completedAt,
        activity: Array.isArray(saved.activity) ? saved.activity : [],
        delegation: reattach || !isTaskActive(saved.status)
          ? saved.delegation || null
          : null,
        authorization: recovery !== TaskRecoveryAction.RESTORE
          || isTaskTerminal(saved.status)
          ? null
          : saved.authorization,
        inputRequest: recovery !== TaskRecoveryAction.RESTORE
          || isTaskTerminal(saved.status)
          ? null
          : saved.inputRequest,
        notificationStatus: recoveredNotificationStatus(saved, recovery),
        notificationClaimantId: null,
        notificationClaimedAt: null,
        resolve: null,
        promise: null,
        runner: null,
        timeoutTimer: null,
        // Until the adapter accepts recovery, persistence must retain the
        // recoverable backend phase rather than checkpoint the temporary
        // in-memory `queued` phase.
        recoveryPersistedStatus: reattach ? saved.status : null,
      }
      if (reattach) {
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
    if (recoveryChanged) this.persist()
  }

  /** Reconciles the task projection with the latest durable Journal snapshot. */
  restoreFromJournalSnapshots(snapshots = []) {
    const candidates = snapshots.filter(snapshot => snapshot?.id)
    if (!candidates.length) return 0
    let restored = 0
    for (const snapshot of candidates) {
      const id = String(snapshot.id)
      const existing = this.tasks.get(id)
      // A journal event is the durable revision. Remove the compact snapshot
      // projection before replaying it so a terminal Journal state can repair
      // a stale/failed tasks.json state after a crash.
      if (existing) {
        this.recoveryCandidates = this.recoveryCandidates.filter(
          candidate => candidate !== existing,
        )
        this.tasks.delete(id)
      }
      this.restore([{ ...snapshot }])
      restored += 1
    }
    return restored
  }

  restoreFromJournal(journal) {
    return this.restoreFromJournalSnapshots(journal?.taskSnapshotsSync?.() || [])
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
        task.recoveryPersistedStatus = null
        transitionTask(task, TaskStatus.FAILED)
        task.error = 'qwen-audio-agent 重启时这项项目任务失去连接，请重新提交。'
        task.completedAt = Date.now()
        task.notificationStatus = isUserWork(task) ? 'pending' : 'none'
        task.promise = Promise.resolve(publicTask(task))
        task.resolve = null
        this.emit(TaskDomainEvent.FAILED, task)
        if (isUserWork(task)) {
          this.emit(TaskDomainEvent.NOTIFICATION_PENDING, task)
        }
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
    this.repository.save()
  }

  persistDeferred() {
    this.repository.saveDeferred()
  }

  allocateTaskId() {
    return this.repository.allocateTaskId()
  }

  subscribe(listener, { scope = TaskScope.USER } = {}) {
    const subscription = { listener, scope }
    this.listeners.add(subscription)
    return () => this.listeners.delete(subscription)
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
    for (const subscription of this.listeners) {
      if (
        subscription.scope !== 'all'
        && normalizeTaskScope(task.scope) !== subscription.scope
      ) continue
      try {
        subscription.listener(event)
      } catch {
        // One observer must not break the work queue.
      }
    }
    if (persist) this.persist()
  }

  markProgressChanged(task, { message = false } = {}) {
    task.progressChanged = true
    if (message) task.messageChanged = true
  }

  flushProgress(task, { heartbeat = false } = {}) {
    if (!heartbeat && !task.progressChanged) return false
    const messageChanged = task.messageChanged === true
    task.progressChanged = false
    task.messageChanged = false
    this.emit(
      messageChanged ? TaskDomainEvent.UPDATED : TaskDomainEvent.PROGRESS,
      task,
      {
        persist: false,
        ...(messageChanged ? { message: task.message } : {}),
      },
    )
    return true
  }

  create(options = {}) {
    return this.#create({
      ...options,
      scope: TaskScope.USER,
      kind: options.kind || 'work',
    })
  }

  createSystemJob(options = {}) {
    return this.#create({
      ...options,
      scope: TaskScope.SYSTEM,
      kind: options.kind || 'system_job',
      ownerId: options.ownerId || 'system',
      sessionId: options.sessionId || 'system',
    })
  }

  #create({
    objective,
    ownerId,
    sessionId,
    turnId,
    submissionKey,
    laneKey,
    laneLimit = 1,
    kind,
    scope,
    parentTaskId = null,
    priority = 0,
    runner,
    canceler,
  }) {
    const normalizedScope = normalizeTaskScope(scope)
    const normalizedOwnerId = String(ownerId || '')
    const normalizedSubmissionKey = String(submissionKey || '').trim()
    if (normalizedSubmissionKey) {
      const existing = [...this.tasks.values()].find(item => (
        item.ownerId === normalizedOwnerId
        && normalizeTaskScope(item.scope) === normalizedScope
        && item.submissionKey === normalizedSubmissionKey
      ))
      if (existing) return { ...publicTask(existing), reused: true }
    }
    const task = {
      id: normalizedScope === TaskScope.USER
        ? this.allocateTaskId()
        : `system_${randomUUID()}`,
      status: 'queued',
      scope: normalizedScope,
      kind: String(kind),
      parentTaskId: parentTaskId ? String(parentTaskId) : null,
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
      message: null,
      artifacts: [],
      activity: [],
      delegation: null,
      cancellation: null,
      authorization: null,
      inputRequest: null,
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
      id: this.allocateTaskId(),
      status: 'scheduled',
      scope: TaskScope.USER,
      kind,
      objective: String(objective || '').trim(),
      ownerId: String(ownerId || ''),
      sessionId: String(sessionId || 'main'),
      turnId: turnId || null,
      priority: 0,
      parentTaskId: null,
      schedule: { type: 'at', at: Number(at), recurrence },
      timeoutMs: type === 'task'
        ? Number(timeoutMs) || config.scheduledTaskTimeoutMs
        : null,
      createdAt: Date.now(),
      startedAt: null,
      completedAt: null,
      elapsedMs: 0,
      result: null,
      error: null,
      message: null,
      artifacts: [],
      activity: [],
      delegation: null,
      cancellation: null,
      authorization: null,
      inputRequest: null,
      notificationStatus: 'none',
      notificationClaimantId: null,
      notificationClaimedAt: null,
      runner: runner || (async obj => ({ content: obj })),
      canceler: null,
      cancelPromise: null,
      terminalHandled: false,
      abortController: null,
      schedulerHeld: false,
      timeoutTimer: null,
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
      if (!this.schedulerFor(task).canStart(task)) continue
      this.start(task)
    }
  }

  start(task) {
    task.recoveryPersistedStatus = null
    transitionTask(task, TaskStatus.RUNNING)
    task.startedAt = Date.now()
    task.abortController = new AbortController()
    this.schedulerFor(task).acquire(task)
    task.schedulerHeld = true
    this.emit(TaskDomainEvent.RUNNING, task)
    task.progressTimer = setInterval(() => {
      if (isTaskActive(task.status)) {
        this.flushProgress(task, { heartbeat: true })
      }
    }, this.progressEventIntervalMs)
    task.progressTimer.unref?.()
    const onEvent = event => {
      if (
        event?.type === BackendEventType.AUTHORIZATION_REQUESTED
        && event.permission
      ) {
        const authorization = normalizeAuthorization(event.permission, {
          taskId: task.id,
        })
        if (!authorization) return
        task.authorization = authorization
        this.emit(TaskDomainEvent.PERMISSION_REQUESTED, task, {
          permission: authorization,
        })
        return
      }
      if (
        event?.type === BackendEventType.AUTHORIZATION_RESOLVED
        && event.permission
      ) {
        const permission = resolveAuthorization(
          task.authorization?.id === event.permission.id
            ? task.authorization
            : event.permission,
          event.permission.status,
          { taskId: task.id },
        )
        if (!permission) return
        if (task.authorization?.id === permission.id) {
          task.authorization = null
        }
        this.emit(TaskDomainEvent.PERMISSION_RESOLVED, task, {
          permission,
        })
        return
      }
      if (event?.type === BackendEventType.INPUT_REQUESTED && event.input) {
        const inputRequest = normalizeInputRequest(event.input, {
          taskId: task.id,
        })
        if (!inputRequest) return
        task.inputRequest = inputRequest
        this.emit(TaskDomainEvent.INPUT_REQUESTED, task, { input: inputRequest })
        return
      }
      if (event?.type === BackendEventType.INPUT_RESOLVED && event.input) {
        const input = resolveInputRequest(
          task.inputRequest?.id === event.input.id
            ? task.inputRequest
            : event.input,
          event.input.status,
          { taskId: task.id },
        )
        if (!input) return
        if (task.inputRequest?.id === input.id) task.inputRequest = null
        this.emit(TaskDomainEvent.INPUT_RESOLVED, task, { input })
        return
      }
      if (['cancelling', 'cancelled'].includes(task.status)) return
      if (event?.type === BackendEventType.DELEGATED && event.delegation) {
        transitionTask(task, TaskStatus.DELEGATED)
        const { presentation: _presentation, ...delegation } = event.delegation
        task.delegation = delegation
        this.releaseScheduler(task)
        this.emit(TaskDomainEvent.DELEGATED, task)
        this.drain()
        return
      }
      if (
        event?.type === BackendEventType.DELEGATION_COMPLETED
        && event.delegation
      ) {
        transitionTask(task, TaskStatus.FINALIZING)
        task.delegation = { ...event.delegation, status: 'completed' }
        this.emit(TaskDomainEvent.FINALIZING, task)
        return
      }
      if (event?.type === BackendEventType.MESSAGE && event.message) {
        const message = String(event.message).trim().slice(0, 4_000)
        if (!message || message === task.message) return
        task.message = message
        this.markProgressChanged(task, { message: true })
        this.persistDeferred()
        return
      }
      if (event?.type === BackendEventType.ARTIFACT && event.artifact) {
        const artifacts = normalizeArtifacts([event.artifact])
        if (!artifacts.length) return
        const artifact = artifacts[0]
        const merged = mergeArtifacts(task.artifacts, [artifact])
        if (isDeepStrictEqual(merged, task.artifacts)) return
        task.artifacts = merged
        this.emit(TaskDomainEvent.UPDATED, task, { persist: false })
        this.persistDeferred()
        return
      }
      if (event?.type !== BackendEventType.ACTIVITY || !event.activity) return
      const activity = event.activity
      const index = activity.id
        ? task.activity.findIndex(item => item.id === activity.id)
        : -1
      if (
        index === task.activity.length - 1
        && isDeepStrictEqual(task.activity[index], activity)
      ) return
      if (index >= 0) task.activity.splice(index, 1)
      task.activity.push(activity)
      task.activity = task.activity.slice(-20)
      this.markProgressChanged(task)
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
        if (!isTaskActive(task.status)) return
        task.abortController?.abort(
          new Error('定时任务执行超时，正在终止'),
        )
        const cleanup = setTimeout(() => {
          if (!isTaskActive(task.status)) return
          task.terminalHandled = true
          transitionTask(task, TaskStatus.FAILED)
          task.error = `定时任务执行超时（${Math.round(task.timeoutMs / 60000)} 分钟）`
          task.completedAt = Date.now()
          task.elapsedMs = task.startedAt
            ? task.completedAt - task.startedAt : 0
          task.notificationStatus = 'pending'
          clearInterval(task.progressTimer)
          task.progressTimer = null
          this.releaseScheduler(task)
          this.emit(TaskDomainEvent.FAILED, task)
          this.emit(TaskDomainEvent.NOTIFICATION_PENDING, task)
          this.persistDeferred()
          this.drain()
        }, 5000)
        cleanup.unref?.()
      }, task.timeoutMs)
      task.timeoutTimer.unref?.()
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
        this.flushProgress(task)
        transitionTask(task, TaskStatus.COMPLETED)
        task.result = String(outcome?.content ?? outcome ?? '').trim()
        task.artifacts = mergeArtifacts(
          task.artifacts,
          artifactsFromOutcome(outcome),
        )
      })
      .catch(error => {
        if (
          task.terminalHandled
          || ['cancelling', 'cancelled'].includes(task.status)
        ) return
        this.flushProgress(task)
        transitionTask(task, TaskStatus.FAILED)
        task.error = error?.message || String(error)
      })
      .finally(() => {
        if (task.terminalHandled) return
        clearInterval(task.progressTimer)
        task.progressTimer = null
        if (task.timeoutTimer) { clearTimeout(task.timeoutTimer); task.timeoutTimer = null }
        task.abortController = null
        task.authorization = null
        task.inputRequest = null
        if (task.status === 'cancelling') return
        if (task.status === 'cancelled') {
          this.releaseScheduler(task)
          this.drain()
          return
        }
        task.completedAt = Date.now()
        task.elapsedMs = task.startedAt
          ? task.completedAt - task.startedAt
          : 0
        task.notificationStatus = isUserWork(task) ? 'pending' : 'none'
        task.terminalHandled = true
        this.releaseScheduler(task)
        this.emit(
          task.status === 'completed'
            ? TaskDomainEvent.COMPLETED
            : TaskDomainEvent.FAILED,
          task,
        )
        if (isUserWork(task)) {
          this.emit(TaskDomainEvent.NOTIFICATION_PENDING, task)
        }
        task.resolve?.(publicTask(task))
        this.prune()
        this.drain()
      })
  }

  async cancel(id, { ownerId, scope = TaskScope.USER } = {}) {
    const task = this.tasks.get(String(id))
    if (
      !task
      || normalizeTaskScope(task.scope) !== scope
      || (ownerId !== undefined && task.ownerId !== String(ownerId))
      || (!isTaskCancellable(task.status) && task.status !== 'cancelling')
    ) {
      return null
    }
    if (task.cancelPromise) return task.cancelPromise
    const previousStatus = task.status
    if (previousStatus === 'queued' || previousStatus === 'scheduled') {
      return this.finishCancellation(task)
    }
    transitionTask(task, TaskStatus.CANCELLING)
    task.authorization = null
    task.inputRequest = null
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
        task.abortController = null
        task.authorization = null
        task.inputRequest = null
        transitionTask(task, TaskStatus.FAILED)
        task.error = `取消失败：${error?.message || String(error)}`
        task.completedAt = Date.now()
        task.elapsedMs = task.startedAt
          ? task.completedAt - task.startedAt
          : 0
        task.notificationStatus = isUserWork(task) ? 'pending' : 'none'
        task.terminalHandled = true
        this.releaseScheduler(task)
        this.emit(TaskDomainEvent.FAILED, task)
        if (isUserWork(task)) {
          this.emit(TaskDomainEvent.NOTIFICATION_PENDING, task)
        }
        task.resolve?.(publicTask(task))
        this.prune()
        this.drain()
        return publicTask(task)
      })
    return task.cancelPromise
  }

  finishCancellation(task) {
    transitionTask(task, TaskStatus.CANCELLED)
    task.authorization = null
    task.inputRequest = null
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
    task.abortController = null
    this.releaseScheduler(task)
    this.emit(TaskDomainEvent.CANCELLED, task)
    task.resolve?.(publicTask(task))
    this.prune()
    this.drain()
    return publicTask(task)
  }

  get(id, { ownerId, scope = TaskScope.USER } = {}) {
    const task = this.tasks.get(String(id))
    if (
      !task
      || normalizeTaskScope(task.scope) !== scope
      || (ownerId !== undefined && task.ownerId !== String(ownerId))
    ) {
      return null
    }
    return publicTask(task)
  }

  getByTaskId(taskId, { ownerId } = {}) {
    return this.get(taskId, { ownerId, scope: TaskScope.USER })
  }

  list({
    ownerId,
    sessionId,
    active = false,
    scope = TaskScope.USER,
  } = {}) {
    this.prune()
    return [...this.tasks.values()]
      .filter(task => (
        (scope === 'all' || normalizeTaskScope(task.scope) === scope)
        && (ownerId === undefined || task.ownerId === String(ownerId))
        && (sessionId === undefined || task.sessionId === String(sessionId))
        && (!active || isTaskActive(task.status))
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
      if (!isTaskTerminal(task.status)) continue
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

export const taskSessionJournal = new SessionJournalRegistry({
  directory: resolve(config.configDirectory, 'sessions'),
  logger,
})

export const taskManager = new TaskManager({
  store: taskStore,
  logger,
  maxConcurrent: config.taskMaxConcurrent,
  maxConcurrentPerOwner: config.taskMaxConcurrentPerOwner,
  terminalTtlMs: config.taskTerminalTtlMs,
  pendingNotificationTtlMs: config.taskPendingNotificationTtlMs,
  maxTerminalTasksPerOwner: config.maxTerminalTasksPerOwner,
  sessionJournal: taskSessionJournal,
})
