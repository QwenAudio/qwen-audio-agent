export {
  createGatewayPairingTicket,
  disableGatewayRemoteAccess,
  enableGatewayRemoteAccess,
  listGatewayDevices,
  pairGatewayDevice,
  readGatewayRemoteAccess,
  revokeGatewayDevice,
} from './gateway-client.mjs'

import { pairGatewayDevice } from './gateway-client.mjs'
import { assertGatewayInvitationActive } from './gateway-remote-access.mjs'

export async function pairGatewayInvitation(invitation, {
  device,
  clientInstanceId,
  profileId = device?.id,
  label = device?.label,
  profileStore,
  fetchImpl = globalThis.fetch,
  now = Date.now(),
} = {}) {
  const active = assertGatewayInvitationActive(invitation, now)
  if (!profileStore?.save) {
    throw new TypeError('pairGatewayInvitation requires a connection profile store')
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
