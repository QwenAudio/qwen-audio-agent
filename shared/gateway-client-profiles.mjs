import { clientInputCapabilities } from './client-input-capabilities.mjs'
import { GatewayClientCapability } from './gateway-client-protocol.mjs'

export const GatewayReferenceClientType = Object.freeze({
  WEB: 'web',
  DESKTOP: 'desktop',
  TUI: 'cli',
})

export function gatewayReferenceClientCapabilities(clientType = 'web') {
  const input = clientInputCapabilities(clientType)
  return [
    GatewayClientCapability.INPUT_TEXT,
    ...(input.audio ? [GatewayClientCapability.INPUT_AUDIO] : []),
    ...(input.image ? [GatewayClientCapability.INPUT_IMAGE] : []),
    ...(input.resource ? [GatewayClientCapability.INPUT_FILE] : []),
    GatewayClientCapability.PLAYBACK_RECEIPTS,
    GatewayClientCapability.TASK_COMMANDS,
    GatewayClientCapability.PERMISSION_RESPOND,
    GatewayClientCapability.CONVERSATION_HISTORY,
    GatewayClientCapability.CLIENT_EVENTS,
    GatewayClientCapability.SESSION_OUTPUT_VOICE,
    GatewayClientCapability.SESSION_REPLAY,
    ...(clientType === GatewayReferenceClientType.DESKTOP
      ? [GatewayClientCapability.CLIENT_ACTION_ENTER_SLEEP]
      : []),
  ]
}
