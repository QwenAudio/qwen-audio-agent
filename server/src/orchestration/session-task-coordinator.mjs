import { randomUUID } from 'node:crypto'
import { TaskDomainEvent } from '../task/task-events.mjs'

/**
 * Per-frontend-session Task observation and delivery policy. TaskManager remains
 * the state/notification authority; closing this observer never cancels work.
 *
 * presentation supplies connection state, request presentation and the existing
 * announcement managers. It owns model text, response cancellation and playback;
 * this coordinator never receives transport or provider events.
 */
export class SessionTaskCoordinator {
  constructor({
    taskManager, ownerId, sessionId, presentation,
    onTaskEvent = () => {}, onResult = () => {}, onWake = () => {},
    retryMs = 100,
  }) {
    this.taskManager = taskManager
    this.ownerId = ownerId
    this.sessionId = sessionId
    this.presentation = presentation
    this.onTaskEvent = onTaskEvent
    this.onResult = onResult
    this.onWake = onWake
    this.retryMs = Math.max(100, retryMs)
    this.claimantId = `session_${randomUUID()}`
    this.requests = { permission: new Map(), input: new Map() }
    this.closed = false
    this.retryTimer = null
    this.unsubscribe = null
    this.announcements = presentation.createAnnouncements({
      isTaskActive: id => this.activeTasks().some(task => task.id === id),
      onDelivered: ids => taskManager.markNotificationsDelivered(ids, {
        claimantId: this.claimantId,
      }),
      onLeaseRenew: ids => taskManager.renewNotificationClaims(ids, {
        claimantId: this.claimantId,
      }),
      onRelease: ids => taskManager.releaseNotificationClaims(ids, {
        claimantId: this.claimantId,
      }),
    })
  }

  start() {
    if (!this.closed && !this.unsubscribe) {
      this.unsubscribe = this.taskManager.subscribe(event => this.handleEvent(event))
    }
  }

  activeTasks() {
    return this.taskManager.list({
      ownerId: this.ownerId, sessionId: this.sessionId, active: true,
    })
  }

  hasPendingPermission() {
    return this.activeTasks().some(task => task.authorization?.status === 'pending')
  }

  hasPendingInput() {
    return this.activeTasks().some(task => task.inputRequest?.status === 'pending')
  }

  requestFor(task, kind) {
    return kind === 'permission' ? task.authorization : task.inputRequest
  }

  isPending(kind, id) {
    return !this.closed && this.activeTasks().some(task => {
      const request = this.requestFor(task, kind)
      return request?.id === id && request.status === 'pending'
    })
  }

  canDeliver() {
    const state = this.presentation.state()
    return !this.closed && state.ready && state.outputEnabled
      && !state.sleeping && !state.waking
  }

  scheduleRetry() {
    if (this.retryTimer || !this.canDeliver()) return
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.announcePendingPermissions()
      this.announcePendingInputs()
    }, this.retryMs)
    this.retryTimer.unref?.()
  }

  announceRequest(task, kind) {
    const request = this.requestFor(task, kind)
    const announced = this.requests[kind]
    if (!this.canDeliver() || request?.status !== 'pending' || announced.has(request.id)) return
    if (this.presentation.state().busy) {
      this.scheduleRetry()
      return
    }
    // An attempt identity prevents an old promise from clearing a newer retry
    // after resolution, disconnection or permission-delivery failure.
    const attempt = {}
    announced.set(request.id, attempt)
    const shouldDeliver = () => announced.get(request.id) === attempt
      && this.isPending(kind, request.id)
    const retry = error => {
      if (this.closed || announced.get(request.id) !== attempt) return
      announced.delete(request.id)
      if (!this.isPending(kind, request.id)) return
      this.scheduleRetry()
      if (error) this.presentation.reportRequestError(kind, error)
    }
    Promise.resolve().then(() => {
      if (!shouldDeliver()) return { completed: false }
      return this.presentation.presentRequest(kind, task, { shouldDeliver })
    }).then(outcome => {
      if (!outcome?.completed) retry()
    }).catch(retry)
  }

  announcePending(kind) {
    const tasks = this.activeTasks()
    const pendingIds = new Set(tasks.map(task => this.requestFor(task, kind))
      .filter(request => request?.status === 'pending').map(request => request.id))
    for (const id of this.requests[kind].keys()) {
      if (!pendingIds.has(id)) this.requests[kind].delete(id)
    }
    for (const task of tasks) this.announceRequest(task, kind)
  }

  announcePendingPermissions() { this.announcePending('permission') }
  announcePendingInputs() { this.announcePending('input') }

  retryPermission(id) {
    this.requests.permission.delete(id)
    this.announcePendingPermissions()
  }

  claimPendingNotifications(taskIds, { includeOtherSessions = !taskIds?.length } = {}) {
    if (!this.canDeliver()) return
    const claimed = this.taskManager.claimNotifications({
      ownerId: this.ownerId,
      sessionId: this.sessionId,
      includeOtherSessions,
      claimantId: this.claimantId,
      taskIds,
    })
    for (const task of claimed) {
      this.onResult(task)
      if (task.status === 'completed') this.announcements.results.completed(task)
      if (task.status === 'failed') this.announcements.results.failed(task)
    }
  }

  handleEvent(event) {
    if (this.closed || event.ownerId !== this.ownerId) return
    const task = event.task
    if (event.type === TaskDomainEvent.NOTIFICATION_PENDING) {
      if (this.presentation.state().sleeping) {
        this.onWake()
      } else if (task.sessionId === this.sessionId) {
        this.claimPendingNotifications([task.id])
      }
      return
    }
    if (task.sessionId !== this.sessionId) return
    this.onTaskEvent(event)
    const state = this.presentation.state()
    if (event.type === TaskDomainEvent.UPDATED && event.message
      && state.outputEnabled && !state.sleeping && !state.waking) {
      this.announcements.progress.offer({
        taskId: task.id, startedAt: task.startedAt, message: event.message,
      })
    }
    const requested = event.type === TaskDomainEvent.PERMISSION_REQUESTED ? 'permission'
      : event.type === TaskDomainEvent.INPUT_REQUESTED ? 'input' : null
    if (requested) {
      // Expose the response tool before the corresponding model input.
      this.presentation.updateContext()
      if (state.sleeping) this.onWake()
      this.announceRequest(task, requested)
    }
    const resolved = event.type === TaskDomainEvent.PERMISSION_RESOLVED ? 'permission'
      : event.type === TaskDomainEvent.INPUT_RESOLVED ? 'input' : null
    if (resolved) {
      this.presentation.updateContext()
      if (resolved === 'permission') this.announcements.progress.remove(task.id)
      const id = resolved === 'permission' ? event.permission?.id : event.input?.id
      if (id) {
        const announced = this.requests[resolved].has(id)
        this.requests[resolved].delete(id)
        this.presentation.resolveRequest(resolved, id, { announced })
      }
    }
    if ([TaskDomainEvent.COMPLETED, TaskDomainEvent.FAILED, TaskDomainEvent.CANCELLED]
      .includes(event.type)) {
      this.announcements.progress.remove(task.id)
    }
    if ([TaskDomainEvent.COMPLETED, TaskDomainEvent.FAILED].includes(event.type)) {
      this.claimPendingNotifications([task.id])
    }
  }

  close() {
    if (this.closed) return
    this.closed = true
    this.unsubscribe?.()
    this.unsubscribe = null
    clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.requests.permission.clear()
    this.requests.input.clear()
    this.announcements.results.close()
    this.announcements.progress.close()
  }
}
