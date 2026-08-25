import { config } from '../core/config.mjs'
import { assertBackendPort } from '../backend/backend-port.mjs'
import { AcpBackendAdapter } from './acp-backend-adapter.mjs'
import {
  backendDriver,
  createBackendProfile,
} from './backends/registry.mjs'

/**
 * ACP composition belongs to the ACP boundary, not AgentClient. This factory
 * selects one configured driver and returns one concrete adapter instance.
 */
export function createAcpBackendAdapter({
  protocol = config.agentProtocol,
  ownership = config.backendOwnership,
  permissionMode = config.backendPermissionMode,
  model,
  coordinatorAgent,
  timeoutMs = config.agentTimeoutMs,
  backends = {},
  sessionStatePath = config.backendSessionStatePath,
  acpClient,
  acpClientFactory,
  sessionToolServer,
} = {}) {
  const driver = backendDriver(protocol)
  const backend = {
    ...(config.backends?.[driver.id] || {}),
    ...(backends?.[driver.id] || {}),
  }
  const options = {
    baseUrl: '',
    ...backend,
    model: model ?? backend.model,
    coordinatorAgent: coordinatorAgent ?? backend.coordinatorAgent,
  }
  const profile = createBackendProfile(protocol, {
    protocol,
    root: config.root,
    ownership,
    permissionMode,
    ...options,
  })
  const adapter = new AcpBackendAdapter({
    protocol,
    root: config.root,
    ownership,
    permissionMode,
    timeoutMs,
    ...options,
    profile,
    nativeDelegationAdapter:
      driver.createNativeDelegationAdapter?.(options) || null,
    sessionStatePath,
    ...(acpClient ? { client: acpClient } : {}),
    ...(acpClientFactory ? { clientFactory: acpClientFactory } : {}),
    ...(sessionToolServer ? { sessionToolServer } : {}),
  })
  return assertBackendPort(adapter, {
    name: `${profile.label || protocol} ACP adapter`,
  })
}
