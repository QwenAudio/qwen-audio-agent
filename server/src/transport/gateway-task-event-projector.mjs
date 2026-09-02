import {
  GatewayTaskEventMessageSchema,
} from '../../../shared/protocol/gateway-events.mjs'
import { GatewayTaskEvent } from '../../../shared/realtime-events.mjs'
import { TaskDomainEvent } from '../task/task-events.mjs'
import { TaskScope } from '../task/task-state.mjs'

const PUBLIC_EVENT_TYPE = new Map([
  [TaskDomainEvent.ACCEPTED, GatewayTaskEvent.ACCEPTED],
  [TaskDomainEvent.SCHEDULED, GatewayTaskEvent.SCHEDULED],
  [TaskDomainEvent.SCHEDULED_FIRED, GatewayTaskEvent.SCHEDULED_FIRED],
  [TaskDomainEvent.RUNNING, GatewayTaskEvent.RUNNING],
  [TaskDomainEvent.DELEGATED, GatewayTaskEvent.DELEGATED],
  [TaskDomainEvent.FINALIZING, GatewayTaskEvent.FINALIZING],
  [TaskDomainEvent.CANCELLING, GatewayTaskEvent.CANCELLING],
  [TaskDomainEvent.UPDATED, GatewayTaskEvent.UPDATED],
  [TaskDomainEvent.PROGRESS, GatewayTaskEvent.PROGRESS],
  [TaskDomainEvent.COMPLETED, GatewayTaskEvent.COMPLETED],
  [TaskDomainEvent.FAILED, GatewayTaskEvent.FAILED],
  [TaskDomainEvent.CANCELLED, GatewayTaskEvent.CANCELLED],
  [
    TaskDomainEvent.PERMISSION_REQUESTED,
    GatewayTaskEvent.PERMISSION_REQUESTED,
  ],
  [
    TaskDomainEvent.PERMISSION_RESOLVED,
    GatewayTaskEvent.PERMISSION_RESOLVED,
  ],
  [TaskDomainEvent.INPUT_REQUESTED, GatewayTaskEvent.INPUT_REQUESTED],
  [TaskDomainEvent.INPUT_RESOLVED, GatewayTaskEvent.INPUT_RESOLVED],
  [
    TaskDomainEvent.NOTIFICATION_PENDING,
    GatewayTaskEvent.NOTIFICATION_PENDING,
  ],
  [
    TaskDomainEvent.NOTIFICATION_DELIVERED,
    GatewayTaskEvent.NOTIFICATION_DELIVERED,
  ],
])

function publicDetails(event) {
  return {
    ...(
      event.permission && typeof event.permission === 'object'
        ? { permission: event.permission }
        : {}
    ),
    ...(
      event.input && typeof event.input === 'object'
        ? { input: event.input }
        : {}
    ),
    ...(
      typeof event.message === 'string'
        ? { message: event.message }
        : {}
    ),
  }
}

export function projectGatewayTaskEvent(event) {
  if (!event || typeof event !== 'object') return null
  const type = PUBLIC_EVENT_TYPE.get(event.type)
  if (!type || !event.task || typeof event.task !== 'object') return null
  if (event.task.scope === TaskScope.SYSTEM) return null
  return GatewayTaskEventMessageSchema.parse({
    type,
    task: event.task,
    ...publicDetails(event),
  })
}

export function projectGatewayTaskSnapshot(task) {
  if (!task || typeof task !== 'object') return null
  if (task.scope === TaskScope.SYSTEM) return null
  return GatewayTaskEventMessageSchema.parse({
    type: GatewayTaskEvent.SNAPSHOT,
    task,
  })
}
