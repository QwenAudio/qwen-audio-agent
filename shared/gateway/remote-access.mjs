import { z } from 'zod'
import { randomUUID } from '../runtime-crypto.mjs'
import { isLiteralIpv4GatewayUrl } from './url-policy.mjs'

export { isLiteralIpv4GatewayUrl } from './url-policy.mjs'

export const GATEWAY_CONNECTION_MODEL_VERSION = 1
export const GATEWAY_DIRECT_CONNECTION_VERSION = 2

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

function normalizeGatewayWebSocketUrl(value, context) {
  let url
  try {
    url = new URL(value)
  } catch {
    context.addIssue({ code: 'custom', message: 'websocket URL must be an absolute URL' })
    return z.NEVER
  }
  if (!['ws:', 'wss:'].includes(url.protocol)) {
    context.addIssue({ code: 'custom', message: 'websocket URL must use ws or wss' })
    return z.NEVER
  }
  if (
    url.username
    || url.password
    || url.pathname !== '/api/realtime'
    || url.search
    || url.hash
  ) {
    context.addIssue({
      code: 'custom',
      message: 'websocket URL must target /api/realtime without credentials, query, or fragment',
    })
    return z.NEVER
  }
  return url.toString()
}

export const GatewayWebSocketUrlSchema = z.string().trim().min(1)
  .transform(normalizeGatewayWebSocketUrl)

export const GatewayDirectConnectionSchema = z.object({
  schema: z.literal('qwaudio.connection/v2'),
  websocket_url: GatewayWebSocketUrlSchema,
  device_id: IdentifierSchema,
  credential_id: IdentifierSchema,
  access_token: z.string().trim().min(16).max(512),
  label: z.string().trim().min(1).max(128).optional(),
  issued_at: z.number().int().positive(),
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

export function parseGatewayDirectConnection(value) {
  return GatewayDirectConnectionSchema.parse(value)
}

export function gatewayWebSocketUrl(gatewayUrl) {
  const origin = new URL(GatewayUrlSchema.parse(gatewayUrl))
  origin.protocol = origin.protocol === 'https:' ? 'wss:' : 'ws:'
  origin.pathname = '/api/realtime'
  return GatewayWebSocketUrlSchema.parse(origin.toString())
}

export function gatewayOriginFromWebSocketUrl(websocketUrl) {
  const url = new URL(GatewayWebSocketUrlSchema.parse(websocketUrl))
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:'
  url.pathname = '/'
  return GatewayUrlSchema.parse(url.origin)
}

export function parseGatewayConnectionEndpoint(value) {
  const origin = GatewayUrlSchema.parse(value)
  if (origin.startsWith('https://') || isLiteralIpv4GatewayUrl(origin)) return origin
  const url = new URL(origin)
  if (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    return origin
  }
  const error = new Error(
    'Gateway connection endpoint must use HTTPS, or HTTP on localhost/a literal IPv4 address',
  )
  error.code = 'gateway_connection_endpoint_unsafe'
  throw error
}

export function createGatewayDirectConnection({
  gatewayUrl,
  websocketUrl,
  deviceId,
  credentialId,
  accessToken,
  label,
  issuedAt = Date.now(),
}) {
  return parseGatewayDirectConnection({
    schema: 'qwaudio.connection/v2',
    websocket_url: websocketUrl || gatewayWebSocketUrl(gatewayUrl),
    device_id: deviceId,
    credential_id: credentialId,
    access_token: accessToken,
    ...(String(label || '').trim() ? { label: String(label).trim() } : {}),
    issued_at: issuedAt,
  })
}

export function decodeGatewayDirectConnection(value) {
  try {
    const url = new URL(String(value || ''))
    if (
      ['http:', 'https:'].includes(url.protocol)
      && url.pathname === '/c'
      && !url.username
      && !url.password
      && !url.search
      && url.hash.startsWith('#d.')
    ) {
      const accessToken = decodeURIComponent(url.hash.slice(3))
      // Local profile identifiers are persisted outside the credential store;
      // never derive them from any part of the device token.
      const localId = randomUUID()
      return createGatewayDirectConnection({
        gatewayUrl: url.origin,
        deviceId: `device_connection_${localId}`,
        credentialId: `gateway/connection/${localId}`,
        accessToken,
        issuedAt: 1,
      })
    }
    throw new Error()
  } catch (error) {
    throw Object.assign(new Error('Invalid Gateway direct connection code'), {
      code: 'gateway_direct_connection_invalid',
      cause: error,
    })
  }
}

export function encodeGatewayBrowserDirectConnection(connection) {
  const parsed = parseGatewayDirectConnection(connection)
  const gatewayUrl = gatewayOriginFromWebSocketUrl(parsed.websocket_url)
  const url = new URL('/c', gatewayUrl)
  // Fragment data is not included in the HTTP request or access logs. The
  // browser shell exchanges this device token for an HttpOnly session cookie.
  url.hash = `d.${parsed.access_token}`
  return url.toString()
}

export function decodeGatewayConnectionCode(value) {
  try {
    return { kind: 'direct', connection: decodeGatewayDirectConnection(value) }
  } catch {
    return { kind: 'pairing', connection: decodeGatewayPairingCode(value) }
  }
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
