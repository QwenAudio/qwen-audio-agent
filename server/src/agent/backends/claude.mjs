import { resolve } from 'node:path'
import { baseEnvironment, clean } from './shared.mjs'

export const claudeBackendDriver = {
  id: 'claude',
  label: 'Claude Code',

  createProfile({
    root,
    directory,
    cliPath,
    claudeExecutable,
    configDirectory,
  }) {
    return {
      label: this.label,
      command: process.execPath,
      args: [resolve(root, 'scripts/claude-code-acp.mjs')],
      cwd: directory,
      env: {
        ...baseEnvironment(),
        ELECTRON_RUN_AS_NODE: '1',
        ...(clean(cliPath)
          ? { CLAUDE_CODE_ACP_BIN: clean(cliPath) }
          : {}),
        ...(clean(claudeExecutable)
          ? { CLAUDE_CODE_EXECUTABLE: clean(claudeExecutable) }
          : {}),
        ...(clean(configDirectory)
          ? { CLAUDE_CONFIG_DIR: clean(configDirectory) }
          : {}),
      },
      externalMcp: true,
      nativeDelegation: false,
      backendUi: false,
    }
  },
}
