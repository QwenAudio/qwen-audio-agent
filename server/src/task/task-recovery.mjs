import {
  isTaskActive,
  isUserWork,
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
    && task?.delegation?.id
    && task?.delegation?.sessionId
  ) {
    return TaskRecoveryAction.REATTACH
  }
  if (isTaskActive(task?.status)) return TaskRecoveryAction.FAIL
  return TaskRecoveryAction.RESTORE
}

export function recoveredNotificationStatus(task, action) {
  if (!isUserWork(task)) return 'none'
  if (action === TaskRecoveryAction.FAIL) return 'pending'
  if ([
    TaskRecoveryAction.RESCHEDULE,
    TaskRecoveryAction.REATTACH,
    TaskRecoveryAction.CANCEL,
  ].includes(action)) return 'none'
  if (task?.notificationStatus === 'delivering') return 'pending'
  return task?.notificationStatus || 'none'
}
