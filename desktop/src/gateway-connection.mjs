import { pairGatewayConnectionCode } from '../../shared/gateway/access-client.mjs'
import { readGatewayHealth } from '../../shared/gateway/http-client.mjs'
import {
  decodeGatewayConnectionCode,
  gatewayOriginFromWebSocketUrl,
  parseGatewayConnectionProfile,
} from '../../shared/gateway/remote-access.mjs'
import { isLoopbackUrl, validateAppUrl } from './security.mjs'

// Pairing links are input, never persisted Gateway addresses. Decode before
// normalizing to an origin so a browser pairing link cannot lose its code.
export function parseDesktopGatewayInput(value) {
  let url
  try {
    url = new URL(String(value || '').trim())
  } catch {
    throw new Error('请输入有效的 Gateway 地址或连接链接')
  }
  const connectionLink = url.protocol === 'qwaudio:' || url.pathname === '/c'
  const decoded = connectionLink ? decodeGatewayConnectionCode(url.href) : null
  const pairingCode = decoded?.kind === 'pairing' ? decoded.connection : null
  const directConnection = decoded?.kind === 'direct' ? decoded.connection : null
  if (!decoded && (url.username || url.password || url.search || url.hash || url.pathname !== '/')) {
    throw new Error('请输入 Gateway 根地址或完整的连接链接')
  }
  const origin = validateAppUrl(
    pairingCode?.gateway_url
    || (directConnection
      ? gatewayOriginFromWebSocketUrl(directConnection.websocket_url)
      : url.href),
  )
  return {
    origin,
    remote: !isLoopbackUrl(origin),
    pairingCode,
    ...(directConnection ? { directConnection } : {}),
  }
}

export async function desktopGatewayCredential(origin, profileStore, fallback = '') {
  const resolved = await profileStore.resolve('desktop')
  return String(resolved?.profile?.gateway_url === origin
    ? resolved.credential || ''
    : fallback).trim()
}

// Prepare the destination without mutating the active runtime. Credentials
// stay in the profile store, never in settings or the renderer's URL field.
export async function prepareDesktopGatewayConnection(target, {
  profileStore,
  clientInstanceId,
  label,
  fallbackAccessToken = '',
  fetchImpl = globalThis.fetch,
} = {}) {
  let paired = null
  if (target.directConnection) {
    const direct = target.directConnection
    paired = {
      profile: parseGatewayConnectionProfile({
        id: 'desktop',
        gateway_url: target.origin,
        device_id: direct.device_id,
        credential_ref: direct.credential_id,
        client_instance_id: clientInstanceId || direct.device_id,
        label: label || direct.label,
      }),
      credential: direct.access_token,
    }
  } else if (target.pairingCode) {
    await pairGatewayConnectionCode(target.pairingCode, {
      device: { id: clientInstanceId, type: 'desktop', label },
      clientInstanceId,
      profileId: 'desktop',
      label,
      // Verify the authenticated destination before replacing the active
      // saved profile. A rejected connection must not erase its credential.
      profileStore: {
        save: async (profile, credential) => {
          paired = { profile: parseGatewayConnectionProfile(profile), credential }
          return paired.profile
        },
      },
      fetchImpl,
    })
  }
  const credential = paired?.credential
    || await desktopGatewayCredential(target.origin, profileStore, fallbackAccessToken)
  // A local URL may point at an already running Gateway. Connecting to it
  // does not require configuring or installing another backend on this client.
  if (!target.remote && !target.pairingCode && !target.directConnection) {
    const health = await readGatewayHealth(target.origin, fetchImpl, { accessToken: credential })
    return { credential, connected: Boolean(health) }
  }
  if (!credential) {
    throw new Error('Gateway 需要认证，请粘贴其主机生成的新连接链接')
  }
  if (paired) await profileStore.save(paired.profile, paired.credential)
  // Remote Conversation Clients authenticate and operate on their single
  // WS/WSS channel. Connection failures are reported by GatewayClient instead
  // of requiring a separate HTTPS health preflight here.
  return { credential, connected: true }
}
