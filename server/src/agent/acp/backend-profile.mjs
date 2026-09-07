import { createBackendProfile } from './drivers/registry.mjs'
export { endpointAvailable } from './drivers/shared.mjs'

export function acpBackendProfile({
  protocol,
  root,
  ownership,
  directory,
  cliPath,
  baseUrl,
  token,
  tokenFile,
  coordinatorAgent,
  configDirectory,
  permissionMode,
  model,
  modelUrl,
  claudeExecutable,
  args,
  label,
}) {
  return createBackendProfile(protocol, {
    root,
    ownership,
    directory,
    cliPath,
    baseUrl,
    token,
    tokenFile,
    coordinatorAgent,
    configDirectory,
    permissionMode,
    model,
    modelUrl,
    claudeExecutable,
    args,
    label,
  })
}
