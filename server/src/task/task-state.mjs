import { normalizeArtifacts } from './task-artifact.mjs'
import { publicAuthorization } from '../core/work-authorization.mjs'
import { publicInputRequest } from '../core/work-input-request.mjs'

export const TaskStatus = Object.freeze({
  SCHEDULED: 'scheduled',
  QUEUED: 'queued',
  RUNNING: 'running',
  DELEGATED: 'delegated',
  FINALIZING: 'finalizing',
  CANCELLING: 'cancelling',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
})

export const TaskScope = Object.freeze({
  USER: 'user',
  SYSTEM: 'system',
})

const ACTIVE = new Set([
  TaskStatus.QUEUED,
  TaskStatus.RUNNING,
  TaskStatus.DELEGATED,
  TaskStatus.FINALIZING,
  TaskStatus.CANCELLING,
])
const CANCELLABLE = new Set([
  TaskStatus.SCHEDULED,
  TaskStatus.QUEUED,
  TaskStatus.RUNNING,
  TaskStatus.DELEGATED,
  TaskStatus.FINALIZING,
])
const TERMINAL = new Set([
  TaskStatus.COMPLETED,
  TaskStatus.FAILED,
  TaskStatus.CANCELLED,
])
const KNOWN = new Set(Object.values(TaskStatus))
const TRANSITIONS = new Map([
  [TaskStatus.SCHEDULED, new Set([
    TaskStatus.QUEUED,
    TaskStatus.FAILED,
    TaskStatus.CANCELLED,
  ])],
  [TaskStatus.QUEUED, new Set([
    TaskStatus.RUNNING,
    TaskStatus.FAILED,
    TaskStatus.CANCELLED,
  ])],
  [TaskStatus.RUNNING, new Set([
    TaskStatus.DELEGATED,
    TaskStatus.FINALIZING,
    TaskStatus.CANCELLING,
    TaskStatus.COMPLETED,
    TaskStatus.FAILED,
  ])],
  [TaskStatus.DELEGATED, new Set([
    TaskStatus.FINALIZING,
    TaskStatus.CANCELLING,
    TaskStatus.COMPLETED,
    TaskStatus.FAILED,
  ])],
  [TaskStatus.FINALIZING, new Set([
    TaskStatus.CANCELLING,
    TaskStatus.COMPLETED,
    TaskStatus.FAILED,
  ])],
  [TaskStatus.CANCELLING, new Set([
    TaskStatus.CANCELLED,
    TaskStatus.FAILED,
  ])],
])

export function isTaskActive(status) {
  return ACTIVE.has(status)
}

export function isTaskCancellable(status) {
  return CANCELLABLE.has(status)
}

export function isTaskTerminal(status) {
  return TERMINAL.has(status)
}

export function normalizeTaskScope(scope) {
  return scope === TaskScope.SYSTEM ? TaskScope.SYSTEM : TaskScope.USER
}

export function isUserWork(task) {
  return normalizeTaskScope(task?.scope) === TaskScope.USER
}

export function publicWorkState(task) {
  if (task?.authorization?.status === 'pending') return 'auth_required'
  if (task?.inputRequest?.status === 'pending') {
    return task.inputRequest.kind === 'authorization'
      ? 'auth_required'
      : 'input_required'
  }
  if ([TaskStatus.SCHEDULED, TaskStatus.QUEUED].includes(task?.status)) {
    return 'submitted'
  }
  if (isTaskActive(task?.status)) return 'working'
  return isTaskTerminal(task?.status) ? task.status : 'submitted'
}

export function transitionTask(task, nextStatus) {
  const currentStatus = task?.status
  if (!KNOWN.has(currentStatus) || !KNOWN.has(nextStatus)) {
    throw new Error(`Unknown task transition: ${currentStatus} -> ${nextStatus}`)
  }
  if (currentStatus === nextStatus) return task
  if (!TRANSITIONS.get(currentStatus)?.has(nextStatus)) {
    throw new Error(`Invalid task transition: ${currentStatus} -> ${nextStatus}`)
  }
  task.status = nextStatus
  return task
}

export function publicTask(task, { now = Date.now() } = {}) {
  return {
    id: task.id,
    workState: publicWorkState(task),
    status: task.status,
    scope: normalizeTaskScope(task.scope),
    kind: task.kind || 'work',
    parentTaskId: task.parentTaskId || null,
    objective: task.objective,
    ownerId: task.ownerId,
    sessionId: task.sessionId,
    turnId: task.turnId,
    createdAt: task.createdAt,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
    elapsedMs: task.startedAt && isTaskActive(task.status)
      ? now - task.startedAt
      : task.elapsedMs,
    result: task.result,
    error: task.error,
    message: task.message || null,
    artifacts: normalizeArtifacts(task.artifacts),
    activity: [...(task.activity || [])],
    delegation: task.delegation
      ? {
          status: task.delegation.status || 'running',
          title: String(task.delegation.title || '').slice(0, 160),
        }
      : null,
    authorization: publicAuthorization(task.authorization, { taskId: task.id }),
    inputRequest: publicInputRequest(task.inputRequest, { taskId: task.id }),
    notificationStatus: task.notificationStatus,
    notificationDeliveredAt: task.notificationDeliveredAt,
    schedule: task.schedule || null,
    timeoutMs: task.timeoutMs || null,
  }
}

export function persistedTask(task) {
  const saved = publicTask(task)
  delete saved.workState
  if (task.recoveryPersistedStatus) {
    saved.status = task.recoveryPersistedStatus
  }
  saved.submissionKey = task.submissionKey || null
  saved.delegation = task.delegation
    ? { ...task.delegation }
    : null
  return saved
}
