import { baseEnvironment, clean, processAcpConnection } from './shared.mjs'

export const deepSeekHarnessBackendDriver = {
  id: 'deepseek',
  label: 'DeepSeek',
  capabilities: {
    delegation: false,
    permissions: true,
    backendUi: false,
    nativeSessionHistory: false,
    externalMcp: true,
    nativeDelegation: false,
    sessionMcp: true,
    coordinatorMcpInstructions: false,
  },

  createProfile({ directory, cliPath }) {
    return {
      label: this.label,
      acpConnection: processAcpConnection({
        command: clean(cliPath) || 'dsh',
        args: ['--profile', 'acp'],
        cwd: directory,
        env: baseEnvironment('deepseek'),
      }),
      // The official CLI owns ACP initialization and the user's profile.
      externalMcp: true,
      sessionMcp: true,
      nativeDelegation: false,
      delegation: false,
      nativeSessionHistory: false,
      backendUi: false,
      sessionInstructions: [
        'Complete the requested work in this Session with the available tools.',
        'Do not claim to have opened a separate Gateway-managed task Session.',
      ].join(' '),
    }
  },
}
