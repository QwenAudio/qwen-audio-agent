import {
  AguiActivitySnapshotEventSchema,
  AguiEventType,
} from '../../../shared/protocol/agui-events.mjs'
import {
  GatewayTaskEventMessageSchema,
} from '../../../shared/protocol/gateway-events.mjs'

export const AGUI_TASK_ACTIVITY_TYPE = 'qwen.audio.task'

/**
 * Projects one public Gateway Task event into an AG-UI activity snapshot.
 *
 * The input is validated at the public Gateway boundary first. The projector
 * then copies only declared fields, so adapter-only routing data cannot leak
 * through AG-UI even when a caller accidentally passes an enriched object.
 */
export function projectGatewayTaskEventToAgui(event) {
  const parsed = GatewayTaskEventMessageSchema.safeParse(event)
  if (!parsed.success) return null

  const { type, task, permission, message } = parsed.data
  return AguiActivitySnapshotEventSchema.parse({
    type: AguiEventType.ACTIVITY_SNAPSHOT,
    messageId: `${AGUI_TASK_ACTIVITY_TYPE}:${task.id}`,
    activityType: AGUI_TASK_ACTIVITY_TYPE,
    content: {
      schema: 'qwen.audio.task/v1',
      eventType: type,
      task,
      ...(permission ? { permission } : {}),
      ...(message ? { message } : {}),
    },
    replace: true,
  })
}

export function projectGatewayTaskEventForFormat(event, format) {
  return format === 'ag-ui'
    ? projectGatewayTaskEventToAgui(event)
    : event
}
