import { PERMISSION_DECISIONS } from '../core/work-authorization.mjs'
import { BackendEventType } from '../core/backend-events.mjs'
import { isTaskActive } from './task-state.mjs'

function key(ownerId, sessionId) {
  return `${String(ownerId || '')}\u0000${String(sessionId || 'main')}`
}

export class PermissionPolicy {
  constructor({
    maxSessions = 500,
    ttlMs = 6 * 60 * 60 * 1000,
    now = () => Date.now(),
    taskManager = null,
  } = {}) {
    this.maxSessions = maxSessions
    this.ttlMs = ttlMs
    this.now = now
    this.sessions = new Map()
    this.tasks = new Map()
    this.pending = new Map()
    this.approving = new Map()
    this.taskManager = taskManager
    this.unsubscribe = taskManager?.subscribe(event => {
      if (event.task && (!isTaskActive(event.task.status) || event.task.status === 'cancelling')) {
        this.tasks.delete(this.taskKey(event.task))
        for (const [id, entry] of this.pending) {
          if (entry.taskId === event.task.id && entry.ownerId === event.task.ownerId) this.pending.delete(id)
        }
      }
    })
  }

  prune() {
    const now = this.now()
    for (const [id, state] of this.sessions) {
      if (now - state.updatedAt >= this.ttlMs) this.sessions.delete(id)
    }
    while (this.sessions.size > this.maxSessions) {
      const oldest = [...this.sessions.entries()]
        .sort((left, right) => left[1].updatedAt - right[1].updatedAt)[0]
      if (!oldest) break
      this.sessions.delete(oldest[0])
    }
  }

  mode(ownerId, sessionId) {
    this.prune()
    return this.sessions.get(key(ownerId, sessionId))?.mode || 'ask'
  }

  setMode(ownerId, sessionId, mode) {
    const normalized = mode === 'auto_allow' ? 'auto_allow' : 'ask'
    this.sessions.set(key(ownerId, sessionId), {
      mode: normalized,
      updatedAt: this.now(),
    })
    this.prune()
    return normalized
  }

  taskKey({ ownerId, sessionId, taskId, id }) {
    return `${key(ownerId, sessionId)}\u0000${String(taskId || id || '')}`
  }

  applyDecision(ownerId, sessionId, decision, taskId) {
    if (!PERMISSION_DECISIONS.includes(decision) || (decision === 'task' && !taskId)) {
      throw new TypeError('Invalid permission decision or missing task ID')
    }
    const sessionKey = key(ownerId, sessionId)
    const taskKey = this.taskKey({ ownerId, sessionId, taskId })
    const previousSession = this.sessions.get(sessionKey)
    const previousTask = this.tasks.get(taskKey)
    // "task" never expands or revokes an existing session grant.
    if (decision !== 'task') this.setMode(ownerId, sessionId, decision === 'always' ? 'auto_allow' : 'ask')
    const taskGrant = { allowed: decision !== 'reject' }
    if (taskId) this.tasks.set(taskKey, taskGrant)
    const sessionGrant = this.sessions.get(sessionKey)
    // Roll back only this decision, never a newer decision or terminal cleanup.
    return () => {
      if (decision !== 'task' && this.sessions.get(sessionKey) === sessionGrant) {
        if (previousSession) this.sessions.set(sessionKey, previousSession)
        else this.sessions.delete(sessionKey)
      }
      if (taskId && this.tasks.get(taskKey) === taskGrant) {
        if (previousTask) this.tasks.set(taskKey, previousTask)
        else this.tasks.delete(taskKey)
      }
    }
  }

  active(context) {
    if (this.closed) return false
    if (!this.taskManager) return true
    const task = this.taskManager.get(context.taskId, { ownerId: context.ownerId })
    return task && task.sessionId === context.sessionId && isTaskActive(task.status) && task.status !== 'cancelling'
  }

  shouldAutoAllow(ownerId, sessionId, taskId) {
    const context = { ownerId, sessionId, taskId }
    if (taskId && !this.active(context)) return false
    return this.mode(ownerId, sessionId) === 'auto_allow'
      || Boolean(taskId && this.tasks.get(this.taskKey(context))?.allowed)
  }

  // One interceptor for voice-created, client-created and scheduled Tasks.
  forwardBackendEvent(context, event, onEvent, respondAuthorization) {
    const id = event?.permission?.id
    if (event?.type === BackendEventType.AUTHORIZATION_RESOLVED && id) {
      this.pending.delete(id)
      const automatic = this.approving.get(id)
      this.approving.delete(id)
      if (automatic && !automatic.published) return
    }
    if (event?.type !== BackendEventType.AUTHORIZATION_REQUESTED || !id) {
      onEvent(event)
      return
    }
    if (!this.active(context)) return
    const entry = { ...context, event, onEvent, respondAuthorization, published: false }
    this.pending.set(id, entry)
    if (respondAuthorization && this.shouldAutoAllow(context.ownerId, context.sessionId, context.taskId)) {
      this.approve(id, entry)
    } else {
      entry.published = true
      onEvent(event)
    }
  }

  approve(id, entry) {
    if (this.approving.has(id) || !this.active(entry)) return
    this.approving.set(id, entry)
    Promise.resolve().then(() => {
      if (!this.active(entry)) return
      return entry.respondAuthorization(entry.taskId, id, 'once', { ownerId: entry.ownerId })
    }).then(() => {
      this.pending.delete(id)
      this.approving.delete(id)
    }).catch(() => {
      this.approving.delete(id)
      if (!this.active(entry)) return
      entry.published = true
      entry.onEvent(entry.event)
    })
  }

  flushPending(ownerId, sessionId) {
    for (const [id, entry] of this.pending) {
      if (entry.ownerId === ownerId && entry.sessionId === sessionId
        && entry.respondAuthorization && this.shouldAutoAllow(ownerId, sessionId, entry.taskId)) {
        this.approve(id, entry)
      }
    }
  }

  close() {
    this.unsubscribe?.()
    this.closed = true
    this.tasks.clear()
    this.sessions.clear()
    this.pending.clear()
    this.approving.clear()
  }

  settle(id) {
    this.pending.delete(id)
  }
}
