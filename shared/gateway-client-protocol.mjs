import { z } from 'zod'
import {
  GatewayClientEvent,
  GATEWAY_CLIENT_EVENT_TYPES,
} from './realtime-events.mjs'
import {
  GatewayInputPartSchema,
  GatewayTaskSchema,
  parseGatewayClientMessage,
} from './protocol/gateway-events.mjs'

export const GATEWAY_CLIENT_PROTOCOL_VERSION = '6.0.0'

export const GatewayClientProtocolEvent = Object.freeze({
  SESSION_HELLO: 'session.hello',
  SESSION_READY: 'session.ready',
  INPUT_AUDIO_APPEND: 'input_audio_buffer.append',
  CONVERSATION_ITEM_CREATE: 'conversation.item.create',
  RESPONSE_CANCEL: 'response.cancel',
  CLIENT_EVENT_PUBLISH: 'client.event.publish',
  CLIENT_EVENT_PUBLISH_RESULT: 'client.event.publish.result',
  TASK_CREATE: 'task.create',
  TASK_CREATE_RESULT: 'task.create.result',
  TASK_GET: 'task.get',
  TASK_GET_RESULT: 'task.get.result',
  TASK_LIST: 'task.list',
  TASK_LIST_RESULT: 'task.list.result',
  TASK_CANCEL: 'task.cancel',
  TASK_CANCEL_RESULT: 'task.cancel.result',
  PERMISSION_RESPOND: 'permission.respond',
  PERMISSION_RESPOND_RESULT: 'permission.respond.result',
  CONVERSATION_HISTORY: 'conversation.history',
  CONVERSATION_HISTORY_RESULT: 'conversation.history.result',
})

export const GatewayClientCapability = Object.freeze({
  INPUT_AUDIO: 'input.audio',
  INPUT_TEXT: 'input.text',
  INPUT_IMAGE: 'input.image',
  INPUT_FILE: 'input.file',
  PLAYBACK_RECEIPTS: 'playback.receipts',
  TASK_COMMANDS: 'tasks.commands',
  PERMISSION_RESPOND: 'permissions.respond',
  CONVERSATION_HISTORY: 'conversation.history',
  CLIENT_EVENTS: 'client.events',
  CLIENT_ACTION_ENTER_SLEEP: 'client.actions.desktop.presence.enter_sleep',
  SESSION_REPLAY: 'session.replay',
})

// The complete roadmap vocabulary is published so clients and extensions do
// not invent competing names. Only capabilities whose runtime exists today
// are negotiated; later stages append implementations without changing the
// handshake shape.
export const GATEWAY_CLIENT_KNOWN_CAPABILITIES = Object.freeze(
  Object.values(GatewayClientCapability),
)

export const GATEWAY_CLIENT_IMPLEMENTED_CAPABILITIES = Object.freeze([
  GatewayClientCapability.INPUT_AUDIO,
  GatewayClientCapability.INPUT_TEXT,
  GatewayClientCapability.INPUT_IMAGE,
  GatewayClientCapability.INPUT_FILE,
  GatewayClientCapability.PLAYBACK_RECEIPTS,
  GatewayClientCapability.TASK_COMMANDS,
  GatewayClientCapability.PERMISSION_RESPOND,
  GatewayClientCapability.CONVERSATION_HISTORY,
  GatewayClientCapability.CLIENT_EVENTS,
])

const IdentifierSchema = z.string().min(1).max(128)
const CapabilitySchema = z.string()
  .min(3)
  .max(120)
  .regex(/^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)+$/)
const SemVerSchema = z.string().regex(/^\d+\.\d+\.\d+$/)

export const GatewayClientEnvelopeSchema = z.object({
  type: z.string().min(1).max(120),
  event_id: IdentifierSchema,
  request_event_id: IdentifierSchema.optional(),
  occurred_at: z.number().int().nonnegative().optional(),
}).passthrough()

export const GatewayServerEnvelopeSchema = GatewayClientEnvelopeSchema.extend({
  sequence: z.number().int().positive().optional(),
})

export const GatewaySessionHelloSchema = GatewayClientEnvelopeSchema.extend({
  type: z.literal(GatewayClientProtocolEvent.SESSION_HELLO),
  protocol: z.object({
    min: SemVerSchema,
    max: SemVerSchema,
  }),
  client: z.object({
    type: z.string().min(1).max(40),
    version: z.string().min(1).max(80).optional(),
    instance_id: IdentifierSchema,
    label: z.string().min(1).max(80).optional(),
  }),
  capabilities: z.array(CapabilitySchema).max(64),
  locale: z.string().min(2).max(40).optional(),
  time_zone: z.string().min(1).max(80).optional(),
}).superRefine((value, context) => {
  if (new Set(value.capabilities).size !== value.capabilities.length) {
    context.addIssue({
      code: 'custom',
      path: ['capabilities'],
      message: 'capabilities must not contain duplicates',
    })
  }
})

export const GatewaySessionReadySchema = GatewayServerEnvelopeSchema.extend({
  type: z.literal(GatewayClientProtocolEvent.SESSION_READY),
  request_event_id: IdentifierSchema,
  protocol_version: SemVerSchema,
  session_id: IdentifierSchema,
  capabilities: z.array(CapabilitySchema).max(64),
})

export const GatewayProtocolErrorSchema = GatewayServerEnvelopeSchema.extend({
  type: z.literal('error'),
  request_event_id: IdentifierSchema.optional(),
  error: z.object({
    code: z.string().min(1).max(80),
    message: z.string().min(1).max(500),
  }),
})

const EventNameSchema = z.string()
  .min(3)
  .max(120)
  .regex(/^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)+$/)

export const GatewayClientEventPublishSchema = GatewayClientEnvelopeSchema.extend({
  type: z.literal(GatewayClientProtocolEvent.CLIENT_EVENT_PUBLISH),
  name: EventNameSchema,
  data: z.unknown().optional(),
  delivery_hint: z.enum(['handle', 'context', 'respond', 'interrupt']).optional(),
})

export const GatewayClientEventPublishResultSchema = GatewayServerEnvelopeSchema.extend({
  type: z.literal(GatewayClientProtocolEvent.CLIENT_EVENT_PUBLISH_RESULT),
  request_event_id: IdentifierSchema,
  accepted: z.boolean(),
  name: EventNameSchema,
  duplicate: z.boolean().optional(),
})

export const GatewayTaskCreateSchema = GatewayClientEnvelopeSchema.extend({
  type: z.literal(GatewayClientProtocolEvent.TASK_CREATE),
  message: z.object({
    parts: z.array(GatewayInputPartSchema).min(1).max(16),
  }),
})

export const GatewayTaskGetSchema = GatewayClientEnvelopeSchema.extend({
  type: z.literal(GatewayClientProtocolEvent.TASK_GET),
  task_id: IdentifierSchema,
})

export const GatewayTaskListSchema = GatewayClientEnvelopeSchema.extend({
  type: z.literal(GatewayClientProtocolEvent.TASK_LIST),
  active: z.boolean().optional(),
  session_id: IdentifierSchema.optional(),
  limit: z.number().int().min(1).max(100).optional(),
})

export const GatewayTaskCancelSchema = GatewayClientEnvelopeSchema.extend({
  type: z.literal(GatewayClientProtocolEvent.TASK_CANCEL),
  task_id: IdentifierSchema,
})

export const GatewayPermissionRespondSchema = GatewayClientEnvelopeSchema.extend({
  type: z.literal(GatewayClientProtocolEvent.PERMISSION_RESPOND),
  permission_id: IdentifierSchema,
  decision: z.enum(['always', 'reject']),
})

export const GatewayConversationHistorySchema = GatewayClientEnvelopeSchema.extend({
  type: z.literal(GatewayClientProtocolEvent.CONVERSATION_HISTORY),
  session_id: IdentifierSchema.optional(),
})

const TaskResultBaseSchema = GatewayServerEnvelopeSchema.extend({
  request_event_id: IdentifierSchema,
  task: GatewayTaskSchema,
})

export const GatewayTaskCreateResultSchema = TaskResultBaseSchema.extend({
  type: z.literal(GatewayClientProtocolEvent.TASK_CREATE_RESULT),
})
export const GatewayTaskGetResultSchema = TaskResultBaseSchema.extend({
  type: z.literal(GatewayClientProtocolEvent.TASK_GET_RESULT),
})
export const GatewayTaskCancelResultSchema = TaskResultBaseSchema.extend({
  type: z.literal(GatewayClientProtocolEvent.TASK_CANCEL_RESULT),
})
export const GatewayTaskListResultSchema = GatewayServerEnvelopeSchema.extend({
  type: z.literal(GatewayClientProtocolEvent.TASK_LIST_RESULT),
  request_event_id: IdentifierSchema,
  tasks: z.array(GatewayTaskSchema).max(100),
})
export const GatewayPermissionRespondResultSchema = GatewayServerEnvelopeSchema.extend({
  type: z.literal(GatewayClientProtocolEvent.PERMISSION_RESPOND_RESULT),
  request_event_id: IdentifierSchema,
  permission: z.unknown(),
})
export const GatewayConversationHistoryResultSchema = GatewayServerEnvelopeSchema.extend({
  type: z.literal(GatewayClientProtocolEvent.CONVERSATION_HISTORY_RESULT),
  request_event_id: IdentifierSchema,
  messages: z.array(z.unknown()).max(100),
})

const GCP2_CLIENT_MESSAGE_SCHEMAS = Object.freeze({
  [GatewayClientProtocolEvent.CLIENT_EVENT_PUBLISH]: GatewayClientEventPublishSchema,
  [GatewayClientProtocolEvent.TASK_CREATE]: GatewayTaskCreateSchema,
  [GatewayClientProtocolEvent.TASK_GET]: GatewayTaskGetSchema,
  [GatewayClientProtocolEvent.TASK_LIST]: GatewayTaskListSchema,
  [GatewayClientProtocolEvent.TASK_CANCEL]: GatewayTaskCancelSchema,
  [GatewayClientProtocolEvent.PERMISSION_RESPOND]: GatewayPermissionRespondSchema,
  [GatewayClientProtocolEvent.CONVERSATION_HISTORY]: GatewayConversationHistorySchema,
})

const GCP2_SERVER_MESSAGE_SCHEMAS = Object.freeze({
  [GatewayClientProtocolEvent.CLIENT_EVENT_PUBLISH_RESULT]: GatewayClientEventPublishResultSchema,
  [GatewayClientProtocolEvent.TASK_CREATE_RESULT]: GatewayTaskCreateResultSchema,
  [GatewayClientProtocolEvent.TASK_GET_RESULT]: GatewayTaskGetResultSchema,
  [GatewayClientProtocolEvent.TASK_LIST_RESULT]: GatewayTaskListResultSchema,
  [GatewayClientProtocolEvent.TASK_CANCEL_RESULT]: GatewayTaskCancelResultSchema,
  [GatewayClientProtocolEvent.PERMISSION_RESPOND_RESULT]: GatewayPermissionRespondResultSchema,
  [GatewayClientProtocolEvent.CONVERSATION_HISTORY_RESULT]: GatewayConversationHistoryResultSchema,
})

const GCP2_REQUIRED_CAPABILITIES = Object.freeze({
  [GatewayClientProtocolEvent.CLIENT_EVENT_PUBLISH]: GatewayClientCapability.CLIENT_EVENTS,
  [GatewayClientProtocolEvent.TASK_CREATE]: GatewayClientCapability.TASK_COMMANDS,
  [GatewayClientProtocolEvent.TASK_GET]: GatewayClientCapability.TASK_COMMANDS,
  [GatewayClientProtocolEvent.TASK_LIST]: GatewayClientCapability.TASK_COMMANDS,
  [GatewayClientProtocolEvent.TASK_CANCEL]: GatewayClientCapability.TASK_COMMANDS,
  [GatewayClientProtocolEvent.PERMISSION_RESPOND]: GatewayClientCapability.PERMISSION_RESPOND,
  [GatewayClientProtocolEvent.CONVERSATION_HISTORY]: GatewayClientCapability.CONVERSATION_HISTORY,
})

const V6_CLIENT_EVENT_ALIASES = Object.freeze({
  [GatewayClientProtocolEvent.INPUT_AUDIO_APPEND]: GatewayClientEvent.AUDIO_APPEND,
  [GatewayClientProtocolEvent.CONVERSATION_ITEM_CREATE]: GatewayClientEvent.INPUT_MESSAGE,
  [GatewayClientProtocolEvent.RESPONSE_CANCEL]: GatewayClientEvent.INTERRUPT,
})

function semverTuple(value) {
  return String(value).split('.').map(Number)
}

function compareSemVer(left, right) {
  const a = semverTuple(left)
  const b = semverTuple(right)
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1
  }
  return 0
}

export function supportsGatewayClientProtocol(protocol = {}) {
  const parsed = z.object({ min: SemVerSchema, max: SemVerSchema }).safeParse(protocol)
  if (!parsed.success) return false
  return (
    compareSemVer(parsed.data.min, GATEWAY_CLIENT_PROTOCOL_VERSION) <= 0
    && compareSemVer(parsed.data.max, GATEWAY_CLIENT_PROTOCOL_VERSION) >= 0
  )
}

export function negotiateGatewayClientCapabilities(
  requested = [],
  supported = GATEWAY_CLIENT_IMPLEMENTED_CAPABILITIES,
) {
  const available = new Set(supported)
  return [...new Set(requested)].filter(capability => available.has(capability))
}

export function normalizeGatewayClientProtocolMessage(value) {
  const envelope = GatewayClientEnvelopeSchema.parse(value)
  const type = V6_CLIENT_EVENT_ALIASES[envelope.type] || envelope.type
  const normalized = { ...envelope, type }
  if (!GATEWAY_CLIENT_EVENT_TYPES.has(type)) {
    const error = new Error(`unsupported Gateway Client event: ${envelope.type}`)
    error.code = 'unknown_type'
    throw error
  }
  return parseGatewayClientMessage(normalized)
}

export function gatewayClientProtocolCapabilityFor(type) {
  return GCP2_REQUIRED_CAPABILITIES[type] || null
}

export function isGatewayClientRuntimeMessage(type) {
  return Boolean(GCP2_CLIENT_MESSAGE_SCHEMAS[type])
}

export function gatewayHelloAsLegacyConnect(hello) {
  const parsed = GatewaySessionHelloSchema.parse(hello)
  const capabilities = new Set(parsed.capabilities)
  const audioInput = capabilities.has(GatewayClientCapability.INPUT_AUDIO)
  return parseGatewayClientMessage({
    type: GatewayClientEvent.CONNECT,
    event_id: parsed.event_id,
    clientType: parsed.client.type,
    clientLabel: parsed.client.label,
    clientInstanceId: parsed.client.instance_id,
    locale: parsed.locale,
    timeZone: parsed.time_zone,
    voiceEnabled: audioInput,
    inputEnabled: audioInput,
    outputEnabled: true,
    textOnly: !audioInput,
    inputCapabilities: {
      text: capabilities.has(GatewayClientCapability.INPUT_TEXT),
      audio: audioInput,
      image: capabilities.has(GatewayClientCapability.INPUT_IMAGE),
      resource: capabilities.has(GatewayClientCapability.INPUT_FILE),
    },
  })
}

let fallbackEventCounter = 0

export function createGatewayProtocolEventId(origin = 'client') {
  const uuid = globalThis.crypto?.randomUUID?.()
  if (uuid) return `evt_${origin}_${uuid.replaceAll('-', '')}`
  fallbackEventCounter = (fallbackEventCounter + 1) % Number.MAX_SAFE_INTEGER
  return `evt_${origin}_${Date.now().toString(36)}_${fallbackEventCounter.toString(36)}`
}

export function createGatewaySessionHello({
  eventId = createGatewayProtocolEventId('client'),
  protocolMin = GATEWAY_CLIENT_PROTOCOL_VERSION,
  protocolMax = GATEWAY_CLIENT_PROTOCOL_VERSION,
  clientType = 'web',
  clientVersion,
  clientInstanceId = createGatewayProtocolEventId('instance'),
  clientLabel,
  capabilities = GATEWAY_CLIENT_IMPLEMENTED_CAPABILITIES,
  locale,
  timeZone,
} = {}) {
  return GatewaySessionHelloSchema.parse({
    type: GatewayClientProtocolEvent.SESSION_HELLO,
    event_id: eventId,
    protocol: { min: protocolMin, max: protocolMax },
    client: {
      type: clientType,
      version: clientVersion,
      instance_id: clientInstanceId,
      label: clientLabel,
    },
    capabilities,
    locale,
    time_zone: timeZone,
  })
}

export function createGatewayClientProtocolMessage(type, payload = {}, {
  eventId = createGatewayProtocolEventId('client'),
  occurredAt,
} = {}) {
  return parseGatewayClientProtocolMessage({
    type,
    event_id: eventId,
    ...(occurredAt == null ? {} : { occurred_at: occurredAt }),
    ...payload,
  })
}

export function parseGatewayClientProtocolMessage(value) {
  if (value?.type === GatewayClientProtocolEvent.SESSION_HELLO) {
    return GatewaySessionHelloSchema.parse(value)
  }
  if (GCP2_CLIENT_MESSAGE_SCHEMAS[value?.type]) {
    return GCP2_CLIENT_MESSAGE_SCHEMAS[value.type].parse(value)
  }
  return GatewayClientEnvelopeSchema.parse(value)
}

export function parseGatewayServerProtocolMessage(value) {
  if (value?.type === GatewayClientProtocolEvent.SESSION_READY) {
    return GatewaySessionReadySchema.parse(value)
  }
  if (value?.type === 'error' && value?.error) {
    return GatewayProtocolErrorSchema.parse(value)
  }
  if (GCP2_SERVER_MESSAGE_SCHEMAS[value?.type]) {
    return GCP2_SERVER_MESSAGE_SCHEMAS[value.type].parse(value)
  }
  return GatewayServerEnvelopeSchema.parse(value)
}
