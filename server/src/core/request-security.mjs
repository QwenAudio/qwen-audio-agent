import { config } from './config.mjs'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])
const TRUSTED_NATIVE_CLIENT_ORIGINS = new Set(['https://qwaudio.local'])

function normalizedOrigin(value) {
  try {
    return new URL(value).origin
  } catch {
    return ''
  }
}

function parsedHost(value) {
  try {
    const url = new URL(`http://${value}`)
    return {
      host: url.host,
      hostname: url.hostname,
    }
  } catch {
    return null
  }
}

function trustedOrigins(allowedOrigins) {
  return allowedOrigins
    .map(normalizedOrigin)
    .filter(Boolean)
    .filter(value => {
      const url = new URL(value)
      return (
        url.protocol === 'https:'
        || (
          url.protocol === 'http:'
          && LOOPBACK_HOSTS.has(url.hostname)
        )
      )
    })
}

export function isAllowedOrigin(
  req,
  {
    allowedOrigins = config.allowedOrigins,
    authenticatedRemote = false,
    allowSecureSameOrigin = false,
    trustedNativeClient = false,
  } = {},
) {
  const requestHost = parsedHost(req.headers.host)
  if (!requestHost) return false
  const origin = normalizedOrigin(req.headers.origin)
  const configured = trustedOrigins(allowedOrigins)
  const trustedHost = configured.some(value => (
    new URL(value).host === requestHost.host
  ))

  // CLI and other non-browser clients do not send Origin. They are accepted
  // only through a loopback address or an explicitly trusted reverse proxy.
  if (!origin) {
    return LOOPBACK_HOSTS.has(requestHost.hostname)
      || trustedHost
      || authenticatedRemote === true
  }

  if (
    authenticatedRemote
    && trustedNativeClient
    && TRUSTED_NATIVE_CLIENT_ORIGINS.has(origin)
  ) return true

  const originUrl = new URL(origin)
  if (configured.includes(origin)) {
    return originUrl.host === requestHost.host
  }

  // An authenticated remote browser is already bound to a Gateway-issued
  // credential. The unauthenticated pairing endpoint opts into this path
  // separately because its one-time ticket is the credential being redeemed.
  if (
    (authenticatedRemote || allowSecureSameOrigin)
    && originUrl.protocol === 'https:'
    && originUrl.host === requestHost.host
  ) {
    return true
  }

  // Comparing arbitrary Origin and Host values is vulnerable to DNS rebinding.
  // The implicit same-origin path is therefore limited to literal loopback
  // hosts. Public hostnames must be explicitly allowlisted.
  return (
    LOOPBACK_HOSTS.has(requestHost.hostname)
    && LOOPBACK_HOSTS.has(originUrl.hostname)
    && originUrl.host === requestHost.host
  )
}

export function enforceSameOrigin(req, res, next) {
  if (!isAllowedOrigin(req, {
    authenticatedRemote: req.identity?.access === 'remote',
    trustedNativeClient: req.identity?.clientType === 'mobile',
  })) {
    res.status(403).json({ error: 'origin not allowed' })
    return
  }
  next()
}
