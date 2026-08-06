const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

export function validateAppUrl(value) {
  const url = new URL(value)
  const localHttp = url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)
  if (url.protocol !== 'https:' && !localHttp) {
    throw new Error(
      'QWEN_AUDIO_AGENT_URL must use HTTPS, or HTTP on localhost.',
    )
  }
  return url.origin
}

export function isSameOrigin(value, expectedOrigin) {
  try {
    return new URL(value).origin === expectedOrigin
  } catch {
    return false
  }
}

export function isLoopbackUrl(value) {
  try {
    return LOOPBACK_HOSTS.has(new URL(value).hostname)
  } catch {
    return false
  }
}

export function isSafeExternalUrl(value) {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol)
  } catch {
    return false
  }
}

export function desktopOrbUrl(value, {
  orbStyle,
  autoHideSeconds,
  wakeWordEnabled = false,
} = {}) {
  const url = new URL(value)
  url.searchParams.set('desktop', 'orb')
  if (orbStyle) url.searchParams.set('orbStyle', orbStyle)
  if (Number.isFinite(autoHideSeconds)) {
    url.searchParams.set('autoHideSeconds', String(autoHideSeconds))
  }
  if (wakeWordEnabled) url.searchParams.set('wakeWordEnabled', 'true')
  return url.href
}
