export const TaskDomainEvent = Object.freeze({
  ACCEPTED: 'task.accepted',
  SCHEDULED: 'task.scheduled',
  SCHEDULED_FIRED: 'task.scheduled.fired',
  RUNNING: 'task.running',
  DELEGATED: 'task.delegated',
  FINALIZING: 'task.finalizing',
  CANCELLING: 'task.cancelling',
  UPDATED: 'task.updated',
  PROGRESS: 'task.progress',
  COMPLETED: 'task.completed',
  FAILED: 'task.failed',
  CANCELLED: 'task.cancelled',
  PERMISSION_REQUESTED: 'task.permission.requested',
  PERMISSION_RESOLVED: 'task.permission.resolved',
  INPUT_REQUESTED: 'task.input.requested',
  INPUT_RESOLVED: 'task.input.resolved',
  NOTIFICATION_PENDING: 'task.notification.pending',
  NOTIFICATION_DELIVERED: 'task.notification.delivered',
})

export const TASK_DOMAIN_EVENT_TYPES = new Set(
  Object.values(TaskDomainEvent),
)
