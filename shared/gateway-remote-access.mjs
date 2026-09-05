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
  id: IdentifierSchema,
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

export function assertGatewayInvitationActive(invitation, now = Date.now()) {
  const parsed = parseGatewayInvitation(invitation)
  if (parsed.expires_at <= now) {
    const error = new Error('Gateway invitation has expired')
    error.code = 'gateway_invitation_expired'
    throw error
  }
  return parsed
}

export function encodeGatewayInvitation(invitation) {
  const parsed = parseGatewayInvitation(invitation)
  return `qwaudio://connect#${encodeURIComponent(JSON.stringify(parsed))}`
}

export function encodeGatewayBrowserInvitation(invitation) {
  const parsed = parseGatewayInvitation(invitation)
  const url = new URL('/connect', parsed.gateway_url)
  url.hash = encodeURIComponent(JSON.stringify(parsed))
  return url.toString()
}

export function decodeGatewayInvitation(value) {
  let url
  try {
    url = new URL(String(value || ''))
  } catch {
    throw Object.assign(new Error('Invalid Gateway invitation URL'), {
      code: 'gateway_invitation_invalid',
    })
  }
  if (url.protocol !== 'qwaudio:' || url.hostname !== 'connect' || !url.hash) {
    throw Object.assign(new Error('Invalid Gateway invitation URL'), {
      code: 'gateway_invitation_invalid',
    })
  }
  try {
    return parseGatewayInvitation(JSON.parse(decodeURIComponent(url.hash.slice(1))))
  } catch (error) {
    throw Object.assign(new Error('Invalid Gateway invitation payload'), {
      code: 'gateway_invitation_invalid',
      cause: error,
    })
  }
}
