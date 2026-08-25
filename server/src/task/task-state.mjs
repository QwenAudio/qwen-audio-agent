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

export function publicTask(task, { now = Date.now() } = {}) {
  return {
    id: task.id,
    workId: task.id,
    jobId: task.jobId,
    workState: isTaskActive(task.status) ? 'active' : task.status,
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
    elapsedMs: task.startedAt && isTaskActive(task.status)
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
