import { resolve } from 'node:path'
import { baseEnvironment, clean, processAcpConnection } from './shared.mjs'

export const piBackendDriver = {
  id: 'pi',
  label: 'Pi',
  capabilities: {
    delegation: false,
    permissions: false,
    backendUi: false,
    nativeSessionHistory: true,
    externalMcp: false,
    nativeDelegation: false,
    sessionMcp: false,
  },

  createProfile({
    root,
    directory,
    cliPath,
  }) {
    return {
      label: this.label,
      acpConnection: processAcpConnection({
        command: process.execPath,
        args: [resolve(root, 'scripts/pi-acp.mjs')],
        cwd: directory,
        env: {
          ...baseEnvironment('pi'),
          ELECTRON_RUN_AS_NODE: '1',
          ...(clean(cliPath) ? { PI_ACP_BIN: clean(cliPath) } : {}),
        },
      }),
      // pi-acp currently accepts ACP mcpServers but does not wire them into Pi.
      externalMcp: false,
      sessionMcp: false,
      nativeDelegation: false,
      delegation: false,
      permissions: false,
      backendUi: false,
      sessionInstructions: [
        'The current Pi ACP adapter does not expose Gateway Session tools.',
        'Complete the requested work in this Session with Pi\'s own tools.',
        'Do not claim to have opened or resumed a separate background Session.',
      ].join(' '),
    }
  },
}
