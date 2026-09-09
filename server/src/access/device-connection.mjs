import {
  createGatewayDirectConnection,
  encodeGatewayBrowserDirectConnection,
  parseGatewayConnectionEndpoint,
} from '../../../shared/gateway/remote-access.mjs'

export { parseGatewayConnectionEndpoint }

export function gatewayDeviceConnectionResponse({ endpoint, issued }) {
  const connection = createGatewayDirectConnection({
    gatewayUrl: endpoint,
    deviceId: issued.device.id,
    credentialId: issued.credentialId,
    accessToken: issued.token,
    label: issued.device.label || undefined,
  })
  return {
    device: issued.device,
    connection_code: encodeGatewayBrowserDirectConnection(connection),
  }
}
