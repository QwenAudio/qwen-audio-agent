import {
  isTaskActive,
  isUserWork,
  shouldNotifyTaskCompletion,
  TaskStatus,
} from './task-state.mjs'

export const TaskRecoveryAction = Object.freeze({
  RESTORE: 'restore',
  RESCHEDULE: 'reschedule',
  REATTACH: 'reattach',
  CANCEL: 'cancel',
  FAIL: 'fail',
})

const REPLAYABLE_REMINDER = new Set([
  TaskStatus.QUEUED,
  TaskStatus.RUNNING,
])

function hasRecoverableDelegation(delegation) {
  // A multi-target checkpoint is all-or-nothing: never reattach only its valid
  // children, or fall back to a legacy top-level id when targets is malformed.
  const targets = delegation && Object.hasOwn(delegation, 'targets')
    ? delegation.targets : [delegation]
  return Array.isArray(targets) && targets.length > 0 && targets.every(target => (
    typeof target?.id === 'string' && target.id.trim()
    && typeof target?.sessionId === 'string' && target.sessionId.trim()
  ))
}

export function taskRecoveryAction(task) {
  if (task?.status === TaskStatus.SCHEDULED) {
    return TaskRecoveryAction.RESCHEDULE
  }
  if (
    task?.kind === 'reminder'
    && REPLAYABLE_REMINDER.has(task?.status)
  ) {
    return TaskRecoveryAction.RESCHEDULE
  }
  if (task?.status === TaskStatus.CANCELLING) {
    return TaskRecoveryAction.CANCEL
  }
  if (
    isUserWork(task)
    && [TaskStatus.DELEGATED, TaskStatus.FINALIZING].includes(task?.status)
    && hasRecoverableDelegation(task?.delegation)
  ) {
    return TaskRecoveryAction.REATTACH
  }
  if (isTaskActive(task?.status)) return TaskRecoveryAction.FAIL
  return TaskRecoveryAction.RESTORE
}

export function recoveredNotificationStatus(task, action) {
  if (!shouldNotifyTaskCompletion(task)) return 'none'
  if (action === TaskRecoveryAction.FAIL) return 'pending'
  if ([
    TaskRecoveryAction.RESCHEDULE,
    TaskRecoveryAction.REATTACH,
    TaskRecoveryAction.CANCEL,
  ].includes(action)) return 'none'
  if (task?.notificationStatus === 'delivering') return 'pending'
  return task?.notificationStatus || 'none'
}
