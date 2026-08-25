import { z } from 'zod'
import {
  GatewayClientEvent,
  GatewayServerEvent,
  GatewayTaskEvent,
} from '../realtime-events.mjs'

const values = object => Object.freeze(Object.values(object))

export const GATEWAY_CLIENT_EVENT_NAMES = values(GatewayClientEvent)
export const GATEWAY_SERVER_EVENT_NAMES = values(GatewayServerEvent)
export const GATEWAY_TASK_EVENT_NAMES = values(GatewayTaskEvent)

export const GatewayEventEnvelopeSchema = z.object({
  type: z.string().min(1),
}).passthrough()

export const GatewayArtifactPartSchema = z.union([
  z.object({
    text: z.string(),
    mediaType: z.string().min(1),
    filename: z.string().optional(),
  }),
  z.object({
    raw: z.string().min(1),
    mediaType: z.string().min(1),
    filename: z.string().optional(),
  }),
  z.object({
    url: z.string().min(1),
    mediaType: z.string().min(1),
    filename: z.string().optional(),
  }),
  z.object({
    data: z.unknown(),
    mediaType: z.string().min(1),
    filename: z.string().optional(),
  }),
])

export const GatewayArtifactSchema = z.object({
  artifactId: z.string().min(1),
  name: z.string().optional(),
  description: z.string().optional(),
  parts: z.array(GatewayArtifactPartSchema).min(1),
})

export const GatewayPresentationSchema = z.object({
  speech: z.string(),
  inline: z.object({
    title: z.string(),
    format: z.enum(['markdown', 'code', 'link']),
    content: z.string(),
  }).nullable(),
})

export const GatewayAuthorizationSchema = z.object({
  id: z.string().min(1),
  workId: z.string().nullable(),
  status: z.enum(['pending', 'approved', 'denied', 'cancelled']),
  category: z.string().min(1),
  summary: z.string().min(1),
  patterns: z.array(z.string()),
  createdAt: z.number(),
  resolvedAt: z.number().nullable(),
})

export const GatewayTaskSchema = z.object({
  id: z.string().min(1),
  workId: z.string().min(1),
  jobId: z.string().min(1),
  workState: z.enum([
    'submitted',
    'working',
    'auth_required',
    'completed',
    'failed',
    'cancelled',
  ]),
  status: z.string().min(1),
  kind: z.string().min(1),
  parentWorkId: z.string().nullable().optional(),
  objective: z.string(),
  ownerId: z.string().optional(),
  sessionId: z.string().optional(),
  turnId: z.string().nullable().optional(),
  createdAt: z.number(),
  startedAt: z.number().nullable().optional(),
  completedAt: z.number().nullable().optional(),
  elapsedMs: z.number(),
  result: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
  artifacts: z.array(GatewayArtifactSchema).optional(),
  presentation: GatewayPresentationSchema.nullable().optional(),
  activity: z.array(z.unknown()).optional(),
  delegation: z.unknown().optional(),
  authorization: GatewayAuthorizationSchema.nullable().optional(),
  notificationStatus: z.string().optional(),
  notificationDeliveredAt: z.number().nullable().optional(),
  schedule: z.unknown().optional(),
  timeoutMs: z.number().nullable().optional(),
  progressCheckMs: z.number().nullable().optional(),
})

export const GatewayClientEventTypeSchema = z.enum(GATEWAY_CLIENT_EVENT_NAMES)
export const GatewayServerEventTypeSchema = z.enum(GATEWAY_SERVER_EVENT_NAMES)
export const GatewayTaskEventTypeSchema = z.enum(GATEWAY_TASK_EVENT_NAMES)

// The first protocol boundary deliberately validates the stable envelope and
// event namespace while preserving provider/client extension fields. Payload
// schemas can now be tightened one event at a time without inventing a second
// event registry or breaking compatible clients.
export const GatewayClientMessageSchema = GatewayEventEnvelopeSchema.extend({
  type: GatewayClientEventTypeSchema,
})

export const GatewayVoiceMessageSchema = GatewayEventEnvelopeSchema.extend({
  type: GatewayServerEventTypeSchema,
})

export const GatewayTaskEventMessageSchema = GatewayEventEnvelopeSchema.extend({
  type: GatewayTaskEventTypeSchema,
  task: GatewayTaskSchema,
  permission: GatewayAuthorizationSchema.optional(),
  message: z.string().optional(),
})

export const GatewayServerMessageSchema = z.union([
  GatewayVoiceMessageSchema,
  GatewayTaskEventMessageSchema,
])

export function parseGatewayClientMessage(value) {
  return GatewayClientMessageSchema.parse(value)
}

export function parseGatewayServerMessage(value) {
  return GatewayServerMessageSchema.parse(value)
}
