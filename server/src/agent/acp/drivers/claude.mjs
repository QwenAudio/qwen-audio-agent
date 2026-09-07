import { resolve } from 'node:path'
import { baseEnvironment, clean, processAcpConnection } from './shared.mjs'

export const claudeBackendDriver = {
  id: 'claude',
  label: 'Claude Code',
  capabilities: {
    delegation: true,
    permissions: true,
    backendUi: false,
    nativeSessionHistory: true,
    externalMcp: true,
    nativeDelegation: false,
    sessionMcp: true,
    // Claude Code projects MCP server instructions into the main model
    // context. Keep the shared coordinator payload within its 2 KB budget.
    coordinatorMcpInstructions: true,
  },

  createProfile({
    root,
    directory,
    cliPath,
    claudeExecutable,
  }) {
    return {
      label: this.label,
      acpConnection: processAcpConnection({
        command: process.execPath,
        args: [resolve(root, 'scripts/claude-code-acp.mjs')],
        cwd: directory,
        env: {
          ...baseEnvironment('claude'),
          ELECTRON_RUN_AS_NODE: '1',
          ...(clean(cliPath)
            ? { CLAUDE_CODE_ACP_BIN: clean(cliPath) }
            : {}),
          ...(clean(claudeExecutable)
            ? { CLAUDE_CODE_EXECUTABLE: clean(claudeExecutable) }
            : {}),
        },
      }),
      externalMcp: true,
      nativeDelegation: false,
      backendUi: false,
    }
  },
}
