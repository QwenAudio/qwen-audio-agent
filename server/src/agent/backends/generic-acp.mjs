import {
  baseEnvironment,
  clean,
} from './shared.mjs'

export const genericAcpBackendDriver = {
  id: 'acp',
  label: 'ACP Agent',

  createProfile({
    directory,
    cliPath,
    args = [],
    label,
    permissionMode,
  }) {
    const command = clean(cliPath)
    if (!command) {
      throw new Error('使用通用 ACP 后端时必须设置 ACP_COMMAND')
    }
    if (permissionMode === 'full') {
      throw new Error('通用 ACP 后端无法安全地统一开启最高权限模式')
    }
    return {
      label: clean(label) || this.label,
      command,
      args: Array.isArray(args) ? args.map(String) : [],
      cwd: directory,
      env: baseEnvironment(),
      externalMcp: true,
      nativeDelegation: false,
      backendUi: false,
    }
  },
}
