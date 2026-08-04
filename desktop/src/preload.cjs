const { contextBridge, ipcRenderer } = require('electron')

function sendPoint(channel, x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return
  ipcRenderer.send(channel, { x, y })
}

const WINDOWS_CHANNELS = Object.freeze({
  getDesktopContext: 'qwen-audio-agent:windows-get-desktop-context',
  getRuntimeStatus: 'qwen-audio-agent:windows-get-runtime-status',
  getRuntimeInstallPlan: 'qwen-audio-agent:windows-get-runtime-install-plan',
  retryRuntime: 'qwen-audio-agent:windows-retry-runtime',
  confirmRuntimeInstall: 'qwen-audio-agent:windows-confirm-runtime-install',
  openWindowsOrb: 'qwen-audio-agent:windows-open-orb',
  getPrivateRuntimeRemovalPlan: 'qwen-audio-agent:windows-get-private-runtime-removal-plan',
  confirmPrivateRuntimeRemoval: 'qwen-audio-agent:windows-confirm-private-runtime-removal',
  setRuntimeMode: 'qwen-audio-agent:windows-set-runtime-mode',
  setWslDistribution: 'qwen-audio-agent:windows-set-wsl-distribution',
  setExternalGatewayOrigin: 'qwen-audio-agent:windows-set-external-gateway-origin',
  setOpenAtLogin: 'qwen-audio-agent:windows-set-open-at-login',
  restartRuntime: 'qwen-audio-agent:windows-restart-runtime',
  copyRuntimeDiagnostics: 'qwen-audio-agent:windows-copy-runtime-diagnostics',
  openWindowsMicrophoneSettings: 'qwen-audio-agent:windows-open-microphone-settings',
  openWindowsSupportLink: 'qwen-audio-agent:windows-open-support-link',
  openWindowsRuntimeManager: 'qwen-audio-agent:windows-open-runtime-manager',
  runtimeStatus: 'qwen-audio-agent:runtime-status',
})

function invokeWindows(name, ...args) {
  return ipcRenderer.invoke(WINDOWS_CHANNELS[name], ...args)
}

const windowsApi = process.platform === 'win32' ? {
  getDesktopContext: () => invokeWindows('getDesktopContext'),
  getRuntimeStatus: () => invokeWindows('getRuntimeStatus'),
  getRuntimeInstallPlan: () => invokeWindows('getRuntimeInstallPlan'),
  retryRuntime: () => invokeWindows('retryRuntime'),
  confirmRuntimeInstall: confirmationId => invokeWindows(
    'confirmRuntimeInstall',
    confirmationId,
  ),
  openWindowsOrb: () => invokeWindows('openWindowsOrb'),
  getPrivateRuntimeRemovalPlan: () => invokeWindows(
    'getPrivateRuntimeRemovalPlan',
  ),
  confirmPrivateRuntimeRemoval: confirmationId => invokeWindows(
    'confirmPrivateRuntimeRemoval',
    confirmationId,
  ),
  setRuntimeMode: mode => invokeWindows('setRuntimeMode', mode),
  setWslDistribution: distribution => invokeWindows(
    'setWslDistribution',
    distribution,
  ),
  setExternalGatewayOrigin: origin => invokeWindows(
    'setExternalGatewayOrigin',
    origin,
  ),
  setOpenAtLogin: enabled => invokeWindows('setOpenAtLogin', enabled),
  restartRuntime: () => invokeWindows('restartRuntime'),
  copyRuntimeDiagnostics: () => invokeWindows('copyRuntimeDiagnostics'),
  openWindowsMicrophoneSettings: () => invokeWindows(
    'openWindowsMicrophoneSettings',
  ),
  openWindowsSupportLink: id => invokeWindows('openWindowsSupportLink', id),
  openWindowsRuntimeManager: () => invokeWindows('openWindowsRuntimeManager'),
  subscribeRuntimeStatus: callback => {
    if (typeof callback !== 'function') return () => {}
    const listener = (_event, status) => callback(status)
    ipcRenderer.on(WINDOWS_CHANNELS.runtimeStatus, listener)
    return () => ipcRenderer.removeListener(
      WINDOWS_CHANNELS.runtimeStatus,
      listener,
    )
  },
} : {}

contextBridge.exposeInMainWorld('qwenAudioAgentDesktop', {
  dragStart: (x, y) => sendPoint('qwen-audio-agent:drag-start', x, y),
  dragMove: (x, y) => sendPoint('qwen-audio-agent:drag-move', x, y),
  dragEnd: () => ipcRenderer.send('qwen-audio-agent:drag-end'),
  openSettings: () => ipcRenderer.send('qwen-audio-agent:open-settings'),
  loadSettings: () => ipcRenderer.invoke('qwen-audio-agent:settings-load'),
  loadRuntimeStatus: () => ipcRenderer.invoke(
    'qwen-audio-agent:settings-runtime-status',
  ),
  detectBackends: options => ipcRenderer.invoke(
    'qwen-audio-agent:settings-detect-backends',
    { force: options?.force === true },
  ),
  loadUpdaterStatus: () => ipcRenderer.invoke(
    'qwen-audio-agent:updater-status',
  ),
  checkUpdates: () => ipcRenderer.invoke('qwen-audio-agent:updater-check'),
  installUpdate: () => ipcRenderer.invoke('qwen-audio-agent:updater-install'),
  openLogs: () => ipcRenderer.invoke('qwen-audio-agent:open-logs'),
  onUpdaterStatus: callback => {
    if (typeof callback !== 'function') return () => {}
    const listener = (_event, status) => callback(status)
    ipcRenderer.on('qwen-audio-agent:updater-status', listener)
    return () => ipcRenderer.removeListener(
      'qwen-audio-agent:updater-status',
      listener,
    )
  },
  saveSettings: settings => ipcRenderer.invoke(
    'qwen-audio-agent:settings-save',
    settings,
  ),
  openBailianApiKeyPage: () => ipcRenderer.send(
    'qwen-audio-agent:open-bailian-api-key-page',
  ),
  quit: () => ipcRenderer.send('qwen-audio-agent:quit'),
  ...windowsApi,
})
