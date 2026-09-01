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
  SESSION_OUTPUT_VOICE_UPDATE: 'session.output_voice.update',
  SESSION_OUTPUT_VOICE_UPDATED: 'session.output_voice.updated',
  INPUT_AUDIO_APPEND: 'input_audio_buffer.append',
  CONVERSATION_ITEM_CREATE: 'conversation.item.create',
  RESPONSE_CANCEL: 'response.cancel',
  CLIENT_EVENT_PUBLISH: 'client.event.publish',
  CLIENT_EVENT_PUBLISH_RESULT: 'client.event.publish.result',
  CLIENT_ACTION_REQUEST: 'client.action.request',
  CLIENT_ACTION_RESULT: 'client.action.result',
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
  INPUT_RESPOND: 'task.input.respond',
  INPUT_RESPOND_RESULT: 'task.input.respond.result',
  CONVERSATION_HISTORY: 'conversation.history',
  CONVERSATION_HISTORY_RESULT: 'conversation.history.result',
  SESSION_REPLAY: 'session.replay',
  SESSION_REPLAY_RESULT: 'session.replay.result',
})

export const GatewayClientCapability = Object.freeze({
  INPUT_AUDIO: 'input.audio',
  INPUT_TEXT: 'input.text',
  INPUT_IMAGE: 'input.image',
  INPUT_FILE: 'input.file',
  PLAYBACK_RECEIPTS: 'playback.receipts',
  TASK_COMMANDS: 'tasks.commands',
  PERMISSION_RESPOND: 'permissions.respond',
  INPUT_RESPOND: 'tasks.input.respond',
  CONVERSATION_HISTORY: 'conversation.history',
  CLIENT_EVENTS: 'client.events',
  SESSION_OUTPUT_VOICE: 'session.output_voice',
  CLIENT_ACTION_ENTER_SLEEP: 'client.actions.desktop.presence.enter_sleep',
  SESSION_REPLAY: 'session.replay',
})

export const GatewayClientActionName = Object.freeze({
  ENTER_SLEEP: 'desktop.presence.enter_sleep',
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
  GatewayClientCapability.INPUT_RESPOND,
  GatewayClientCapability.CONVERSATION_HISTORY,
  GatewayClientCapability.CLIENT_EVENTS,
  GatewayClientCapability.SESSION_OUTPUT_VOICE,
  GatewayClientCapability.CLIENT_ACTION_ENTER_SLEEP,
  GatewayClientCapability.SESSION_REPLAY,
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
  connection: z.object({
    voice_enabled: z.boolean().optional(),
    input_enabled: z.boolean().optional(),
    output_enabled: z.boolean().optional(),
    text_only: z.boolean().optional(),
    wake_word_only: z.boolean().optional(),
    provider: z.string().min(1).max(80).optional(),
    output_voice: z.string().min(1).max(160).optional(),
    working_directory: z.string().min(1).max(4096).optional(),
    client_states: z.array(z.string().min(1).max(80)).max(16).optional(),
  }).optional(),
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

export const GatewaySessionOutputVoiceUpdateSchema = GatewayClientEnvelopeSchema.extend({
  type: z.literal(GatewayClientProtocolEvent.SESSION_OUTPUT_VOICE_UPDATE),
  voice: z.string().trim().min(1).max(160),
})

export const GatewaySessionOutputVoiceUpdatedSchema = GatewayServerEnvelopeSchema.extend({
  type: z.literal(GatewayClientProtocolEvent.SESSION_OUTPUT_VOICE_UPDATED),
  request_event_id: IdentifierSchema,
  voice: z.string().min(1).max(160),
  changed: z.boolean(),
  reconnecting: z.boolean(),
})

export const GatewayClientActionRequestSchema = GatewayServerEnvelopeSchema.extend({
  type: z.literal(GatewayClientProtocolEvent.CLIENT_ACTION_REQUEST),
  name: EventNameSchema,
  arguments: z.unknown().optional(),
})

export const GatewayClientActionResultSchema = GatewayClientEnvelopeSchema.extend({
  type: z.literal(GatewayClientProtocolEvent.CLIENT_ACTION_RESULT),
  request_event_id: IdentifierSchema,
  status: z.enum(['completed', 'failed', 'unsupported']),
  output: z.unknown().optional(),
  error: z.object({
    code: z.string().min(1).max(80),
    message: z.string().min(1).max(500),
  }).optional(),
}).superRefine((value, context) => {
  if (value.status !== 'completed' && !value.error) {
    context.addIssue({
      code: 'custom',
      path: ['error'],
      message: 'failed and unsupported Client Actions require an error',
    })
  }
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
  decision: z.enum(['once', 'always', 'reject']),
})

export const GatewayInputRespondSchema = GatewayClientEnvelopeSchema.extend({
  type: z.literal(GatewayClientProtocolEvent.INPUT_RESPOND),
  task_id: IdentifierSchema,
  input_request_id: IdentifierSchema,
  action: z.enum(['accept', 'decline', 'cancel']),
  text: z.string().max(16_000).optional(),
  values: z.record(z.unknown()).optional(),
})

export const GatewayConversationHistorySchema = GatewayClientEnvelopeSchema.extend({
  type: z.literal(GatewayClientProtocolEvent.CONVERSATION_HISTORY),
  session_id: IdentifierSchema.optional(),
})

export const GatewaySessionReplaySchema = GatewayClientEnvelopeSchema.extend({
  type: z.literal(GatewayClientProtocolEvent.SESSION_REPLAY),
  after_sequence: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(200).default(50),
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
export const GatewayInputRespondResultSchema = GatewayServerEnvelopeSchema.extend({
  type: z.literal(GatewayClientProtocolEvent.INPUT_RESPOND_RESULT),
  request_event_id: IdentifierSchema,
  input: z.unknown(),
})
export const GatewayConversationHistoryResultSchema = GatewayServerEnvelopeSchema.extend({
  type: z.literal(GatewayClientProtocolEvent.CONVERSATION_HISTORY_RESULT),
  request_event_id: IdentifierSchema,
  messages: z.array(z.unknown()).max(100),
})
export const GatewaySessionReplayResultSchema = GatewayServerEnvelopeSchema.extend({
  type: z.literal(GatewayClientProtocolEvent.SESSION_REPLAY_RESULT),
  request_event_id: IdentifierSchema,
  events: z.array(GatewayServerEnvelopeSchema).max(200),
  earliest_sequence: z.number().int().nonnegative(),
  latest_sequence: z.number().int().nonnegative(),
  next_sequence: z.number().int().nonnegative(),
  has_more: z.boolean(),
})

const GATEWAY_RUNTIME_CLIENT_MESSAGE_SCHEMAS = Object.freeze({
  [GatewayClientProtocolEvent.CLIENT_EVENT_PUBLISH]: GatewayClientEventPublishSchema,
  [GatewayClientProtocolEvent.SESSION_OUTPUT_VOICE_UPDATE]: GatewaySessionOutputVoiceUpdateSchema,
  [GatewayClientProtocolEvent.CLIENT_ACTION_RESULT]: GatewayClientActionResultSchema,
  [GatewayClientProtocolEvent.TASK_CREATE]: GatewayTaskCreateSchema,
  [GatewayClientProtocolEvent.TASK_GET]: GatewayTaskGetSchema,
  [GatewayClientProtocolEvent.TASK_LIST]: GatewayTaskListSchema,
  [GatewayClientProtocolEvent.TASK_CANCEL]: GatewayTaskCancelSchema,
  [GatewayClientProtocolEvent.PERMISSION_RESPOND]: GatewayPermissionRespondSchema,
  [GatewayClientProtocolEvent.INPUT_RESPOND]: GatewayInputRespondSchema,
  [GatewayClientProtocolEvent.CONVERSATION_HISTORY]: GatewayConversationHistorySchema,
  [GatewayClientProtocolEvent.SESSION_REPLAY]: GatewaySessionReplaySchema,
})

const GATEWAY_RUNTIME_SERVER_MESSAGE_SCHEMAS = Object.freeze({
  [GatewayClientProtocolEvent.CLIENT_EVENT_PUBLISH_RESULT]: GatewayClientEventPublishResultSchema,
  [GatewayClientProtocolEvent.SESSION_OUTPUT_VOICE_UPDATED]: GatewaySessionOutputVoiceUpdatedSchema,
  [GatewayClientProtocolEvent.CLIENT_ACTION_REQUEST]: GatewayClientActionRequestSchema,
  [GatewayClientProtocolEvent.TASK_CREATE_RESULT]: GatewayTaskCreateResultSchema,
  [GatewayClientProtocolEvent.TASK_GET_RESULT]: GatewayTaskGetResultSchema,
  [GatewayClientProtocolEvent.TASK_LIST_RESULT]: GatewayTaskListResultSchema,
  [GatewayClientProtocolEvent.TASK_CANCEL_RESULT]: GatewayTaskCancelResultSchema,
  [GatewayClientProtocolEvent.PERMISSION_RESPOND_RESULT]: GatewayPermissionRespondResultSchema,
  [GatewayClientProtocolEvent.INPUT_RESPOND_RESULT]: GatewayInputRespondResultSchema,
  [GatewayClientProtocolEvent.CONVERSATION_HISTORY_RESULT]: GatewayConversationHistoryResultSchema,
  [GatewayClientProtocolEvent.SESSION_REPLAY_RESULT]: GatewaySessionReplayResultSchema,
})

const GATEWAY_RUNTIME_REQUIRED_CAPABILITIES = Object.freeze({
  [GatewayClientProtocolEvent.CLIENT_EVENT_PUBLISH]: GatewayClientCapability.CLIENT_EVENTS,
  [GatewayClientProtocolEvent.SESSION_OUTPUT_VOICE_UPDATE]: GatewayClientCapability.SESSION_OUTPUT_VOICE,
  [GatewayClientProtocolEvent.CLIENT_ACTION_RESULT]: GatewayClientCapability.CLIENT_ACTION_ENTER_SLEEP,
  [GatewayClientProtocolEvent.TASK_CREATE]: GatewayClientCapability.TASK_COMMANDS,
  [GatewayClientProtocolEvent.TASK_GET]: GatewayClientCapability.TASK_COMMANDS,
  [GatewayClientProtocolEvent.TASK_LIST]: GatewayClientCapability.TASK_COMMANDS,
  [GatewayClientProtocolEvent.TASK_CANCEL]: GatewayClientCapability.TASK_COMMANDS,
  [GatewayClientProtocolEvent.PERMISSION_RESPOND]: GatewayClientCapability.PERMISSION_RESPOND,
  [GatewayClientProtocolEvent.INPUT_RESPOND]: GatewayClientCapability.INPUT_RESPOND,
  [GatewayClientProtocolEvent.CONVERSATION_HISTORY]: GatewayClientCapability.CONVERSATION_HISTORY,
  [GatewayClientProtocolEvent.SESSION_REPLAY]: GatewayClientCapability.SESSION_REPLAY,
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
  return GATEWAY_RUNTIME_REQUIRED_CAPABILITIES[type] || null
}

export function isGatewayClientRuntimeMessage(type) {
  return Boolean(GATEWAY_RUNTIME_CLIENT_MESSAGE_SCHEMAS[type])
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
    ...(parsed.connection ? {
      voiceEnabled: parsed.connection.voice_enabled ?? audioInput,
      inputEnabled: parsed.connection.input_enabled ?? audioInput,
      outputEnabled: parsed.connection.output_enabled ?? true,
      textOnly: parsed.connection.text_only ?? !audioInput,
      wakeWordOnly: parsed.connection.wake_word_only === true,
      ...(parsed.connection.provider ? { provider: parsed.connection.provider } : {}),
      ...(parsed.connection.output_voice
        ? { outputVoice: parsed.connection.output_voice }
        : {}),
      ...(parsed.connection.working_directory
        ? { workingDirectory: parsed.connection.working_directory }
        : {}),
      ...(parsed.connection.client_states
        ? { clientStates: parsed.connection.client_states }
        : {}),
    } : {}),
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
  connection,
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
    connection,
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
  if (GATEWAY_RUNTIME_CLIENT_MESSAGE_SCHEMAS[value?.type]) {
    return GATEWAY_RUNTIME_CLIENT_MESSAGE_SCHEMAS[value.type].parse(value)
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
  if (GATEWAY_RUNTIME_SERVER_MESSAGE_SCHEMAS[value?.type]) {
    return GATEWAY_RUNTIME_SERVER_MESSAGE_SCHEMAS[value.type].parse(value)
  }
  return GatewayServerEnvelopeSchema.parse(value)
}
