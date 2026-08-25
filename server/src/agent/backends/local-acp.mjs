import { baseEnvironment, clean, processAcpConnection } from './shared.mjs'

function localAcpBackend({
  id,
  label,
  command,
  args,
  sessionConfigOptions,
  coordinatorMcpInstructions = false,
}) {
  return {
    id,
    label,
    capabilities: {
      delegation: true,
      permissions: true,
      backendUi: false,
      nativeSessionHistory: true,
      externalMcp: true,
      nativeDelegation: false,
      sessionMcp: true,
      coordinatorMcpInstructions,
    },
    createProfile(options) {
      return {
        label,
        acpConnection: processAcpConnection({
          command: clean(options.cliPath) || command,
          args: args(options),
          cwd: options.directory,
          env: baseEnvironment(id),
        }),
        sessionConfigOptions: sessionConfigOptions?.(options) || [],
        externalMcp: true,
        nativeDelegation: false,
        backendUi: false,
      }
    },
  }
}

export const localAcpBackendDrivers = [
  localAcpBackend({
    id: 'qoder',
    label: 'Qoder',
    command: 'qodercli',
    args: ({ permissionMode }) => [
      '--acp',
      ...(permissionMode === 'full'
        ? ['--dangerously-skip-permissions']
        : []),
    ],
    coordinatorMcpInstructions: true,
  }),
  localAcpBackend({
    id: 'qwen',
    label: 'Qwen Code',
    command: 'qwen',
    args: () => ['--acp'],
    coordinatorMcpInstructions: true,
  }),
  localAcpBackend({
    id: 'kimi',
    label: 'Kimi Code',
    command: 'kimi',
    args: () => ['acp'],
    sessionConfigOptions: ({ permissionMode }) => (
      permissionMode === 'full'
        ? [{ id: 'mode', value: 'auto' }]
        : []
    ),
  }),
  localAcpBackend({
    id: 'hermes',
    label: 'Hermes',
    command: 'hermes',
    args: () => ['acp', '--accept-hooks'],
  }),
]
