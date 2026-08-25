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

export const GatewayServerMessageSchema = GatewayEventEnvelopeSchema.extend({
  type: z.union([
    GatewayServerEventTypeSchema,
    GatewayTaskEventTypeSchema,
  ]),
})

export function parseGatewayClientMessage(value) {
  return GatewayClientMessageSchema.parse(value)
}

export function parseGatewayServerMessage(value) {
  return GatewayServerMessageSchema.parse(value)
}
