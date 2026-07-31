import { baseEnvironment, clean } from './shared.mjs'

export const kimiBackendDriver = {
  id: 'kimi',
  label: 'Kimi Code',

  resolveOptions(options) {
    return {
      baseUrl: '',
      model: options.kimiModel,
      directory: options.kimiDirectory,
      cliPath: options.kimiCliPath,
      coordinatorAgent: options.coordinatorAgent,
    }
  },

  createProfile({
    directory,
    cliPath,
    permissionMode,
  }) {
    return {
      label: this.label,
      command: clean(cliPath) || 'kimi',
      args: ['acp'],
      cwd: directory,
      env: baseEnvironment(),
      sessionConfigOptions: permissionMode === 'full'
        ? [{ id: 'mode', value: 'auto' }]
        : [],
      externalMcp: true,
      nativeDelegation: false,
      backendUi: false,
    }
  },
}
