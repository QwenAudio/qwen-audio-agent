import { z } from 'zod'

export const GATEWAY_REMOTE_ACCESS_MODEL_VERSION = 1

const IdentifierSchema = z.string().trim().min(1).max(128)

function normalizeGatewayUrl(value, context) {
  let url
  try {
    url = new URL(value)
  } catch {
    context.addIssue({ code: 'custom', message: 'gateway URL must be an absolute URL' })
    return z.NEVER
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    context.addIssue({ code: 'custom', message: 'gateway URL must use http or https' })
    return z.NEVER
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    context.addIssue({
      code: 'custom',
      message: 'gateway URL must be an origin without credentials, path, query, or fragment',
    })
    return z.NEVER
  }
  return url.origin
}

export const GatewayUrlSchema = z.string().trim().min(1).transform(normalizeGatewayUrl)

export const GatewayEndpointDescriptorSchema = z.object({
  version: z.literal(GATEWAY_REMOTE_ACCESS_MODEL_VERSION).default(GATEWAY_REMOTE_ACCESS_MODEL_VERSION),
  url: GatewayUrlSchema,
  transport: z.literal('websocket').default('websocket'),
  secure: z.boolean(),
  publisher: IdentifierSchema,
}).strict().superRefine((value, context) => {
  if (value.secure !== value.url.startsWith('https://')) {
    context.addIssue({
      code: 'custom',
      path: ['secure'],
      message: 'secure must reflect whether the endpoint uses https',
    })
  }
})

export const GatewayConnectionProfileSchema = z.object({
  version: z.literal(GATEWAY_REMOTE_ACCESS_MODEL_VERSION).default(GATEWAY_REMOTE_ACCESS_MODEL_VERSION),
  gateway_url: GatewayUrlSchema,
  device_id: IdentifierSchema,
  credential_ref: IdentifierSchema,
  client_instance_id: IdentifierSchema,
  label: z.string().trim().min(1).max(128).optional(),
}).strict()

export const GatewayInvitationSchema = z.object({
  version: z.literal(GATEWAY_REMOTE_ACCESS_MODEL_VERSION),
  gateway_url: GatewayUrlSchema,
  pairing_code: z.string().trim().min(1).max(256),
  expires_at: z.number().int().positive(),
}).strict()

export function defineGatewayEndpointPublisher({
  id,
  inspect,
  publish,
  unpublish,
}) {
  const publisherId = IdentifierSchema.parse(id)
  for (const [name, implementation] of Object.entries({ inspect, publish, unpublish })) {
    if (typeof implementation !== 'function') {
      throw new TypeError(`Gateway endpoint publisher ${publisherId} requires ${name}()`)
    }
  }
  return Object.freeze({ id: publisherId, inspect, publish, unpublish })
}

export function parseGatewayEndpointDescriptor(value) {
  return GatewayEndpointDescriptorSchema.parse(value)
}

export function parseGatewayConnectionProfile(value) {
  return GatewayConnectionProfileSchema.parse(value)
}

export function parseGatewayInvitation(value) {
  return GatewayInvitationSchema.parse(value)
}

export function createGatewayInvitation({ gatewayUrl, pairingCode, expiresAt }) {
  return parseGatewayInvitation({
    version: GATEWAY_REMOTE_ACCESS_MODEL_VERSION,
    gateway_url: gatewayUrl,
    pairing_code: pairingCode,
    expires_at: expiresAt,
  })
}
