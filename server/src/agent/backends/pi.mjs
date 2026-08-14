import { resolve } from 'node:path'
import { baseEnvironment, clean, processAcpConnection } from './shared.mjs'

export const piBackendDriver = {
  id: 'pi',
  label: 'Pi',

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
          ...baseEnvironment(),
          ELECTRON_RUN_AS_NODE: '1',
          ...(clean(cliPath) ? { PI_ACP_BIN: clean(cliPath) } : {}),
        },
      }),
      externalMcp: true,
      nativeDelegation: false,
      backendUi: false,
    }
  },
}
