const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

export const BAILIAN_API_KEY_URL = 'https://bailian.console.aliyun.com/?tab=model#/api-key'
export const WINDOWS_MICROPHONE_SETTINGS_URL = 'ms-settings:privacy-microphone'

const WINDOWS_SUPPORT_URLS = Object.freeze({
  'wsl-install': 'https://learn.microsoft.com/windows/wsl/install',
  'wsl-networking': 'https://learn.microsoft.com/windows/wsl/networking',
  'node-download': 'https://nodejs.org/en/download',
})

export function getWindowsSupportUrl(id) {
  if (typeof id !== 'string') return null
  return Object.hasOwn(WINDOWS_SUPPORT_URLS, id)
    ? WINDOWS_SUPPORT_URLS[id]
    : null
}

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

export function desktopOrbUrl(value, { orbStyle } = {}) {
  const url = new URL(value)
  url.searchParams.set('desktop', 'orb')
  if (orbStyle) url.searchParams.set('orbStyle', orbStyle)
  return url.href
}
