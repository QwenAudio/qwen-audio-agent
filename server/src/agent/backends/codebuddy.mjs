import { baseEnvironment, clean, processAcpConnection } from './shared.mjs'

export const codeBuddyBackendDriver = {
  id: 'codebuddy',
  label: 'CodeBuddy',
  capabilities: {
    delegation: true,
    permissions: true,
    backendUi: false,
    nativeSessionHistory: true,
    externalMcp: true,
    nativeDelegation: false,
    sessionMcp: true,
    coordinatorMcpInstructions: false,
  },

  createProfile({
    directory,
    cliPath,
    model,
    modelUrl,
    permissionMode,
  }) {
    return {
      label: this.label,
      acpConnection: processAcpConnection({
        command: cliPath || 'codebuddy',
        args: [
          '--acp',
          ...(clean(model) ? ['--model', clean(model)] : []),
          ...(permissionMode === 'full'
            ? ['--dangerously-skip-permissions']
            : []),
        ],
        cwd: directory,
        env: {
          ...baseEnvironment('codebuddy'),
          ...(clean(modelUrl)
            ? { CODEBUDDY_MODEL_URL: clean(modelUrl) }
            : {}),
        },
      }),
      externalMcp: true,
      nativeDelegation: false,
      backendUi: false,
    }
  },
}
