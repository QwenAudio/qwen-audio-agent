import { randomUUID } from '../../shared/runtime-crypto.mjs'
import {
  assertGatewayPairingCodeActive,
  decodeGatewayPairingCode,
} from '../../shared/gateway-remote-access.mjs'

export const MOBILE_GATEWAY_PROFILE_KEY = 'mobile-gateway-profile'
export const MOBILE_DEVICE_ID_KEY = 'mobile-device-id'

export function parseMobileGatewayProfile(value) {
  if (!value || typeof value !== 'object') return null
  const gatewayUrl = String(value.gatewayUrl || '').trim()
  const accessToken = String(value.accessToken || '').trim()
  const deviceId = String(value.deviceId || '').trim()
  const clientInstanceId = String(value.clientInstanceId || '').trim()
  try {
    const url = new URL(gatewayUrl)
    if (url.protocol !== 'https:' || url.origin !== gatewayUrl) return null
  } catch {
    return null
  }
  if (!accessToken || !deviceId || !clientInstanceId) return null
  return {
    gatewayUrl,
    accessToken,
    deviceId,
    clientInstanceId,
    label: String(value.label || '').trim() || 'Mobile',
  }
}

export function mobileGatewayTransport(profile) {
  const parsed = parseMobileGatewayProfile(profile)
  if (!parsed) throw new TypeError('complete mobile Gateway profile is required')
  return {
    gatewayUrl: parsed.gatewayUrl,
    accessToken: parsed.accessToken,
    clientType: 'mobile',
    clientLabel: parsed.label,
    clientInstanceId: parsed.clientInstanceId,
  }
}

export async function pairMobileGateway(pairingUrl, {
  request,
  deviceId,
  clientInstanceId = randomUUID(),
  label = 'Mobile',
} = {}) {
  if (typeof request !== 'function') throw new TypeError('pairing request is required')
  const pairingCode = assertGatewayPairingCodeActive(decodeGatewayPairingCode(pairingUrl))
  const gateway = new URL(pairingCode.gateway_url)
  if (gateway.protocol !== 'https:') {
    const error = new Error('移动端只连接 HTTPS Gateway，请先在电脑上开启远程访问')
    error.code = 'mobile_gateway_requires_https'
    throw error
  }
  const id = String(deviceId || '').trim() || `mobile_${randomUUID()}`
  const response = await request(`${gateway.origin}/api/access/pair`, {
    code: pairingCode.pairing_code,
    device: { id, type: 'mobile', label },
  })
  if (!response || response.status < 200 || response.status >= 300) {
    const message = response?.data?.error || `配对失败（${response?.status || 'network'}）`
    const error = new Error(message)
    error.code = response?.data?.code || 'mobile_pairing_failed'
    throw error
  }
  return parseMobileGatewayProfile({
    gatewayUrl: gateway.origin,
    accessToken: response.data?.access_token,
    deviceId: response.data?.device?.id || id,
    clientInstanceId,
    label,
  })
}
