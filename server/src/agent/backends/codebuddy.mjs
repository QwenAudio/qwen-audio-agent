import { baseEnvironment, clean } from './shared.mjs'

export const codeBuddyBackendDriver = {
  id: 'codebuddy',
  label: 'CodeBuddy',

  createProfile({
    directory,
    cliPath,
    model,
    modelUrl,
    permissionMode,
  }) {
    return {
      label: this.label,
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
        ...baseEnvironment(),
        ...(clean(modelUrl)
          ? { CODEBUDDY_MODEL_URL: clean(modelUrl) }
          : {}),
      },
      externalMcp: true,
      nativeDelegation: false,
      backendUi: false,
    }
  },
}
