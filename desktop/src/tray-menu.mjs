const STATUS_LABELS = Object.freeze({
  checking: () => 'Checking WSL...',
  'setup-required': () => 'WSL setup required',
  starting: () => 'Starting WSL runtime...',
  ready: status => `WSL ready - ${status.distribution || 'automatic'}`,
  recovering: status => `Reconnecting to WSL (${status.retry || 1}/3)...`,
  external: status => status.reason === 'external-unavailable'
    ? 'External Gateway unavailable'
    : 'External Gateway connected',
  error: () => 'WSL runtime error',
})

function action(actions, name) {
  if (typeof actions?.[name] !== 'function') {
    throw new TypeError(`Tray action is required: ${name}`)
  }
  return actions[name]
}

export function createTrayMenuTemplate({
  runtimeStatus,
  preferences,
  updaterStatus = null,
  actions,
} = {}) {
  const state = runtimeStatus?.state
  const statusLabel = STATUS_LABELS[state]
  if (!statusLabel) throw new Error(`Unsupported runtime tray state: ${state}`)
  const runtimeUsable = ['ready', 'recovering', 'external', 'error'].includes(state)
  const managedRestart = preferences?.mode === 'managed'
    && ['ready', 'recovering', 'error'].includes(state)
  return [
    {
      id: 'runtime-status',
      label: statusLabel(runtimeStatus),
      enabled: false,
    },
    { type: 'separator' },
    {
      id: 'toggle-orb',
      label: preferences?.orbVisible
        ? 'Hide floating orb'
        : 'Show floating orb',
      enabled: runtimeUsable,
      click: action(actions, 'toggleOrb'),
    },
    {
      id: 'settings',
      label: 'Settings',
      click: action(actions, 'openSettings'),
    },
    {
      id: 'manage-runtime',
      label: 'Manage WSL runtime...',
      click: action(actions, 'manageRuntime'),
    },
    { type: 'separator' },
    {
      id: 'restart-runtime',
      label: 'Restart WSL runtime',
      enabled: managedRestart,
      click: action(actions, 'restartRuntime'),
    },
    {
      id: 'open-at-login',
      label: 'Start with Windows',
      type: 'checkbox',
      checked: preferences?.openAtLogin === true,
      click: menuItem => action(actions, 'setOpenAtLogin')(
        menuItem?.checked === true,
      ),
    },
    {
      id: 'check-updates',
      label: 'Check for updates',
      enabled: updaterStatus?.phase !== 'checking',
      click: action(actions, 'checkForUpdates'),
    },
    { type: 'separator' },
    {
      id: 'quit',
      label: 'Quit',
      click: action(actions, 'quit'),
    },
  ]
}
