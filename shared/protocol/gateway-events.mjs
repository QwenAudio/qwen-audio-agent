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

const GatewayCitationUrlSchema = z.string().max(2048).url().refine(value => {
  const url = new URL(value)
  return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
}, 'citation URL must be a public HTTP(S) URL without credentials')

export const GatewayCitationSchema = z.object({
  id: z.string().min(1).max(40),
  title: z.string().min(1).max(300),
  url: GatewayCitationUrlSchema,
  snippet: z.string().max(1200).optional(),
  source: z.string().max(120).optional(),
  published_at: z.string().max(80).optional(),
})

export const GatewayAuthorizationSchema = z.object({
  id: z.string().min(1),
  taskId: z.string().nullable(),
  status: z.enum(['pending', 'approved', 'denied', 'cancelled']),
  category: z.string().min(1),
  summary: z.string().min(1),
  patterns: z.array(z.string()),
  approvalScope: z.enum(['once', 'session', 'persistent']).optional(),
  operation: z.object({
    title: z.string().min(1),
    kind: z.string().min(1),
    description: z.string().optional(),
    command: z.string().optional(),
    path: z.string().optional(),
    locations: z.array(z.object({
      path: z.string().min(1),
      line: z.number().int().positive().optional(),
    })).optional(),
  }).nullable().optional(),
  createdAt: z.number(),
  resolvedAt: z.number().nullable(),
})

// Adapter implementations may add presentation hints, but every activity
// crosses the Gateway through these protocol-neutral common fields. ACP event
// names and A2A Task payloads stay private to their adapters.
export const GatewayActivitySchema = z.object({
  id: z.string().nullable().optional(),
  kind: z.string().min(1),
  status: z.string().optional(),
  message: z.string().optional(),
  label: z.string().optional(),
  detail: z.string().optional(),
  category: z.string().optional(),
  tool: z.string().optional(),
  title: z.string().optional(),
  updatedAt: z.string().optional(),
  mode: z.string().optional(),
  completed: z.number().int().nonnegative().optional(),
  total: z.number().int().nonnegative().optional(),
}).passthrough()

export const GatewayTaskSchema = z.object({
  id: z.string().min(1),
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
  parentTaskId: z.string().nullable().optional(),
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
  message: z.string().nullable().optional(),
  artifacts: z.array(GatewayArtifactSchema).optional(),
  presentation: GatewayPresentationSchema.nullable().optional(),
  activity: z.array(GatewayActivitySchema).optional(),
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
  citations: z.array(GatewayCitationSchema).max(16).optional(),
}).superRefine((event, context) => {
  if (
    event.citations
    && (
      event.type !== GatewayServerEvent.TRANSCRIPT_FINAL
      || event.role !== 'assistant'
    )
  ) {
    context.addIssue({
      code: 'custom',
      path: ['citations'],
      message: 'citations are allowed only on final assistant transcripts',
    })
  }
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
