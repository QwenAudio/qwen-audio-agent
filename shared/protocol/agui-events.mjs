import { z } from 'zod'

// This is the deliberately small AG-UI surface emitted by the Gateway today.
// Keep the wire names identical to the upstream protocol while avoiding a
// runtime dependency on the complete AG-UI SDK for one event type.
export const AguiEventType = Object.freeze({
  ACTIVITY_SNAPSHOT: 'ACTIVITY_SNAPSHOT',
})

export const AguiActivitySnapshotEventSchema = z.object({
  type: z.literal(AguiEventType.ACTIVITY_SNAPSHOT),
  messageId: z.string().min(1),
  activityType: z.string().min(1),
  content: z.record(z.string(), z.unknown()),
  replace: z.boolean().optional().default(true),
  timestamp: z.number().optional(),
  rawEvent: z.unknown().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).passthrough()

export const AguiGatewayEventSchema = z.discriminatedUnion('type', [
  AguiActivitySnapshotEventSchema,
])

export function parseAguiGatewayEvent(value) {
  return AguiGatewayEventSchema.parse(value)
}
