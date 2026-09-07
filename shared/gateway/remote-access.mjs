import { z } from 'zod'

export const GATEWAY_CONNECTION_MODEL_VERSION = 1

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
  version: z.literal(GATEWAY_CONNECTION_MODEL_VERSION).default(GATEWAY_CONNECTION_MODEL_VERSION),
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
  version: z.literal(GATEWAY_CONNECTION_MODEL_VERSION).default(GATEWAY_CONNECTION_MODEL_VERSION),
  id: IdentifierSchema,
  gateway_url: GatewayUrlSchema,
  device_id: IdentifierSchema,
  credential_ref: IdentifierSchema,
  client_instance_id: IdentifierSchema,
  label: z.string().trim().min(1).max(128).optional(),
}).strict()

export const GatewayPairingCodeSchema = z.object({
  version: z.literal(GATEWAY_CONNECTION_MODEL_VERSION),
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

export function parseGatewayPairingCode(value) {
  return GatewayPairingCodeSchema.parse(value)
}

export function createGatewayPairingCode({ gatewayUrl, pairingCode, expiresAt }) {
  return parseGatewayPairingCode({
    version: GATEWAY_CONNECTION_MODEL_VERSION,
    gateway_url: gatewayUrl,
    pairing_code: pairingCode,
    expires_at: expiresAt,
  })
}

export function assertGatewayPairingCodeActive(pairingCode, now = Date.now()) {
  const parsed = parseGatewayPairingCode(pairingCode)
  if (parsed.expires_at <= now) {
    const error = new Error('Gateway pairing code has expired')
    error.code = 'gateway_pairing_code_expired'
    throw error
  }
  return parsed
}

export function encodeGatewayPairingCode(pairingCode) {
  const parsed = parseGatewayPairingCode(pairingCode)
  const url = new URL('qwaudio://connect')
  url.searchParams.set('v', String(parsed.version))
  url.searchParams.set('gateway', parsed.gateway_url)
  url.searchParams.set('code', parsed.pairing_code)
  url.searchParams.set('expires', String(parsed.expires_at))
  return url.toString()
}

export function encodeGatewayBrowserPairingCode(pairingCode) {
  const parsed = parseGatewayPairingCode(pairingCode)
  const url = new URL('/c', parsed.gateway_url)
  url.searchParams.set('e', parsed.expires_at.toString(36))
  url.hash = parsed.pairing_code
  return url.toString()
}

export function decodeGatewayPairingCode(value) {
  let url
  try {
    url = new URL(String(value || ''))
  } catch {
    throw Object.assign(new Error('Invalid Gateway pairing URL'), {
      code: 'gateway_pairing_code_invalid',
    })
  }
  const isAppPairingCode = url.protocol === 'qwaudio:' && url.hostname === 'connect'
  const isBrowserPairingCode = url.protocol === 'https:' && url.pathname === '/c'
  if (!isAppPairingCode && !isBrowserPairingCode) {
    throw Object.assign(new Error('Invalid Gateway pairing URL'), {
      code: 'gateway_pairing_code_invalid',
    })
  }
  try {
    return parseGatewayPairingCode({
      version: isAppPairingCode
        ? Number(url.searchParams.get('v'))
        : GATEWAY_CONNECTION_MODEL_VERSION,
      gateway_url: isAppPairingCode ? url.searchParams.get('gateway') : url.origin,
      pairing_code: isAppPairingCode
        ? url.searchParams.get('code')
        : decodeURIComponent(url.hash.slice(1)),
      expires_at: isAppPairingCode
        ? Number(url.searchParams.get('expires'))
        : Number.parseInt(url.searchParams.get('e'), 36),
    })
  } catch (error) {
    throw Object.assign(new Error('Invalid Gateway pairing payload'), {
      code: 'gateway_pairing_code_invalid',
      cause: error,
    })
  }
}
