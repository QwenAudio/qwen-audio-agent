import { resolve } from 'node:path'
import { baseEnvironment, processAcpConnection } from './shared.mjs'

export const deepSeekHarnessBackendDriver = {
  id: 'deepseek',
  label: 'DeepSeek',

  createProfile({
    root,
    directory,
    cliPath,
    model,
    permissionMode,
    sessionRoot,
  }) {
    return {
      label: this.label,
      acpConnection: processAcpConnection({
        command: process.execPath,
        args: [resolve(root, 'scripts/deepseek-harness-acp.mjs')],
        cwd: directory,
        env: {
          ...baseEnvironment(),
          ELECTRON_RUN_AS_NODE: '1',
          DEEPSEEK_HARNESS_CONFIG: resolve(
            root,
            'config/deepseek-harness/cordis.yml',
          ),
          DEEPSEEK_HARNESS_SESSION_ROOT: sessionRoot,
          DEEPSEEK_HARNESS_ACP_BIN: cliPath,
          DSH_MODEL: model || 'deepseek-v4-pro',
          DSH_PERMISSION_MODE: permissionMode === 'full'
            ? 'danger-full-access'
            : 'workspace-write',
        },
      }),
      // DeepSeek Harness ACP currently rejects non-empty mcpServers.
      externalMcp: false,
      sessionMcp: false,
      nativeDelegation: false,
      delegation: false,
      nativeSessionHistory: false,
      processModelConfiguration: true,
      backendUi: false,
      sessionInstructions: [
        'DeepSeek Harness ACP does not expose project Session management to',
        'the Gateway. Complete the requested work in this Session with the',
        'tools available to you. Do not claim to have opened or resumed a',
        'separate Session.',
      ].join(' '),
    }
  },
}
