import {
  isBuiltinOrbSkin,
  normalizeOrbSkinId,
} from '../../shared/orb-skin-catalog.mjs'

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
  orbSkin,
  autoHideSeconds,
  wakeWordEnabled = false,
} = {}) {
  const url = new URL(value)
  url.searchParams.set('desktop', 'orb')
  const skinId = normalizeOrbSkinId(orbSkin)
  if (skinId) {
    url.searchParams.set('orbSkin', skinId)
    // 内置 id 同时写旧参数，作为与旧 web/dist 的兼容缓冲。
    if (isBuiltinOrbSkin(skinId)) url.searchParams.set('orbStyle', skinId)
  }
  if (Number.isFinite(autoHideSeconds)) {
    url.searchParams.set('autoHideSeconds', String(autoHideSeconds))
  }
  if (wakeWordEnabled) url.searchParams.set('wakeWordEnabled', 'true')
  return url.href
}
