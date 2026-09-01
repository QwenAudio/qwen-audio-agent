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

export const GatewayInputRequestSchema = z.object({
  id: z.string().min(1),
  taskId: z.string().nullable(),
  status: z.enum(['pending', 'accepted', 'declined', 'cancelled']),
  kind: z.enum(['input', 'authorization']),
  mode: z.enum(['text', 'form', 'url']),
  prompt: z.string().min(1),
  schema: z.record(z.unknown()).optional(),
  url: z.string().url().optional(),
  createdAt: z.number(),
  resolvedAt: z.number().nullable(),
})

// Adapter implementations may add display hints, but every activity
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
    'input_required',
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
  activity: z.array(GatewayActivitySchema).optional(),
  delegation: z.unknown().optional(),
  authorization: GatewayAuthorizationSchema.nullable().optional(),
  inputRequest: GatewayInputRequestSchema.nullable().optional(),
  notificationStatus: z.string().optional(),
  notificationDeliveredAt: z.number().nullable().optional(),
  schedule: z.unknown().optional(),
  timeoutMs: z.number().nullable().optional(),
})

export const GatewayClientEventTypeSchema = z.enum(GATEWAY_CLIENT_EVENT_NAMES)
export const GatewayServerEventTypeSchema = z.enum(GATEWAY_SERVER_EVENT_NAMES)
export const GatewayTaskEventTypeSchema = z.enum(GATEWAY_TASK_EVENT_NAMES)

export const GatewayInputPartSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('text'),
    text: z.string().min(1),
  }).passthrough(),
  z.object({
    type: z.literal('file'),
    mime: z.string().min(3).refine(value => value.includes('/'), 'invalid MIME type'),
    filename: z.string().min(1).optional(),
    url: z.string().min(1),
  }).passthrough(),
])

const GatewayInputMessagePayloadSchema = z.object({
  text: z.string().min(1).optional(),
  parts: z.array(GatewayInputPartSchema).min(1).max(16).optional(),
}).passthrough().refine(value => value.text || value.parts, {
  message: 'a text or parts payload is required',
})

const GatewayClientPayloadSchemas = Object.freeze({
  [GatewayClientEvent.CONNECT]: z.object({
    voiceEnabled: z.boolean().optional(),
    inputEnabled: z.boolean().optional(),
    outputEnabled: z.boolean().optional(),
    textOnly: z.boolean().optional(),
    provider: z.string().min(1).optional(),
    outputVoice: z.string().min(1).max(160).optional(),
    clientType: z.string().min(1).optional(),
    clientLabel: z.string().min(1).optional(),
    clientInstanceId: z.string().min(1).optional(),
    timeZone: z.string().min(1).optional(),
    locale: z.string().min(1).optional(),
    workingDirectory: z.string().min(1).optional(),
    inputCapabilities: z.object({
      text: z.boolean().optional(),
      audio: z.boolean().optional(),
      image: z.boolean().optional(),
      resource: z.boolean().optional(),
    }).passthrough().optional(),
    clientStates: z.array(z.string().min(1)).optional(),
  }).passthrough(),
  [GatewayClientEvent.AUDIO_APPEND]: z.object({
    audio: z.string().min(1),
  }).passthrough(),
  [GatewayClientEvent.TEXT_MESSAGE]: GatewayInputMessagePayloadSchema,
  [GatewayClientEvent.INPUT_MESSAGE]: GatewayInputMessagePayloadSchema,
  [GatewayClientEvent.PLAYBACK_STARTED]: z.object({
    responseId: z.string().min(1),
  }).passthrough(),
  [GatewayClientEvent.PLAYBACK_ENDED]: z.object({
    responseId: z.string().min(1),
  }).passthrough(),
  [GatewayClientEvent.PLAYBACK_CANCELLED]: z.object({
    responseId: z.string().min(1),
    reason: z.string().optional(),
  }).passthrough(),
})

const GatewayVoicePayloadSchemas = Object.freeze({
  [GatewayServerEvent.VOICE_READY]: z.object({
    inputSampleRate: z.number().int().positive(),
    provider: z.string().min(1).optional(),
    providerLabel: z.string().min(1).optional(),
  }).passthrough(),
  [GatewayServerEvent.VOICE_CONNECTION]: z.object({
    state: z.string().min(1),
  }).passthrough(),
  [GatewayServerEvent.VOICE_STATE]: z.object({
    state: z.enum(['idle', 'listening', 'processing', 'speaking']),
    turnId: z.string().min(1).nullable().optional(),
  }).passthrough(),
  [GatewayServerEvent.VOICE_OWNERSHIP]: z.object({
    state: z.enum(['active', 'busy', 'available']),
    holder: z.unknown().nullable().optional(),
  }).passthrough(),
  [GatewayServerEvent.VOICE_DEACTIVATED]: z.object({
    holder: z.unknown().nullable().optional(),
  }).passthrough(),
  [GatewayServerEvent.VOICE_SLEEP]: z.object({
    state: z.enum(['preparing', 'enabled', 'sleeping', 'detected', 'awake', 'disabled']),
  }).passthrough(),
  [GatewayServerEvent.TURN_STARTED]: z.object({
    turnId: z.string().min(1),
  }).passthrough(),
  [GatewayServerEvent.INPUT_SUSPEND]: z.object({
    owner: z.string().min(1),
    reason: z.string().optional(),
    expiresAt: z.number().optional(),
  }).passthrough(),
  [GatewayServerEvent.AUDIO_DELTA]: z.object({
    audio: z.string().min(1),
    sampleRate: z.number().int().positive(),
    responseId: z.string().min(1),
  }).passthrough(),
  [GatewayServerEvent.AUDIO_DONE]: z.object({
    responseId: z.string().min(1),
  }).passthrough(),
  [GatewayServerEvent.RESPONSE_STARTED]: z.object({
    responseId: z.string().min(1),
  }).passthrough(),
  [GatewayServerEvent.RESPONSE_INTERRUPTED]: z.object({
    responseId: z.string().min(1),
  }).passthrough(),
  [GatewayServerEvent.TRANSCRIPT_DELTA]: z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string(),
  }).passthrough(),
  [GatewayServerEvent.TRANSCRIPT_FINAL]: z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string(),
  }).passthrough(),
  [GatewayServerEvent.TRANSCRIPT_DISCARD]: z.object({
    role: z.enum(['user', 'assistant']),
  }).passthrough(),
  [GatewayServerEvent.AGENT_ACTIVITY]: z.object({
    activity: z.string().min(1),
  }).passthrough(),
  [GatewayServerEvent.CLIENT_STATE]: z.object({
    state: z.string().min(1),
  }).passthrough(),
  [GatewayServerEvent.ERROR]: z.object({
    message: z.string().min(1),
  }).passthrough(),
})

function validatePayload(schema, event, context) {
  if (!schema) return
  const result = schema.safeParse(event)
  if (result.success) return
  for (const issue of result.error.issues) context.addIssue(issue)
}

// Stable fields are validated per event while passthrough preserves optional
// client/provider extensions. The constants remain the single event registry.
export const GatewayClientMessageSchema = GatewayEventEnvelopeSchema.extend({
  type: GatewayClientEventTypeSchema,
}).superRefine((event, context) => {
  validatePayload(GatewayClientPayloadSchemas[event.type], event, context)
})

export const GatewayVoiceMessageSchema = GatewayEventEnvelopeSchema.extend({
  type: GatewayServerEventTypeSchema,
  citations: z.array(GatewayCitationSchema).max(16).optional(),
}).superRefine((event, context) => {
  validatePayload(GatewayVoicePayloadSchemas[event.type], event, context)
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
