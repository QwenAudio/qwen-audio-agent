export {
  createGatewayPairingTicket,
  issueGatewayDevice,
  listGatewayDevices,
  pairGatewayDevice,
  revokeGatewayDevice,
} from './http-client.mjs'

import { pairGatewayDevice } from './http-client.mjs'
import {
  assertGatewayPairingCodeActive,
  gatewayOriginFromWebSocketUrl,
  parseGatewayDirectConnection,
} from './remote-access.mjs'

export async function saveGatewayDirectConnection(connection, {
  clientInstanceId,
  profileId,
  label,
  profileStore,
} = {}) {
  const direct = parseGatewayDirectConnection(connection)
  if (!profileStore?.save) {
    throw new TypeError('saveGatewayDirectConnection requires a connection profile store')
  }
  const profile = await profileStore.save({
    id: profileId || direct.device_id,
    gateway_url: gatewayOriginFromWebSocketUrl(direct.websocket_url),
    device_id: direct.device_id,
    credential_ref: direct.credential_id,
    client_instance_id: clientInstanceId || direct.device_id,
    ...((label || direct.label) ? { label: label || direct.label } : {}),
  }, direct.access_token)
  return { profile }
}

export async function pairGatewayConnectionCode(pairingCode, {
  device,
  clientInstanceId,
  profileId = device?.id,
  label = device?.label,
  profileStore,
  fetchImpl = globalThis.fetch,
  now = Date.now(),
} = {}) {
  const active = assertGatewayPairingCodeActive(pairingCode, now)
  if (!profileStore?.save) {
    throw new TypeError('pairGatewayConnectionCode requires a connection profile store')
  }
  const paired = await pairGatewayDevice(active.gateway_url, {
    code: active.pairing_code,
    device,
  }, fetchImpl)
  const profile = await profileStore.save({
    id: profileId,
    gateway_url: active.gateway_url,
    device_id: paired.device.id,
    credential_ref: `gateway/${paired.device.id}`,
    client_instance_id: clientInstanceId,
    ...(label ? { label } : {}),
  }, paired.access_token)
  return { profile, owner_id: paired.owner_id }
}
