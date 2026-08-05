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
      command: resolve(root, 'scripts/claude-code-acp'),
      args: [],
      cwd: directory,
      env: {
        ...baseEnvironment(),
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
