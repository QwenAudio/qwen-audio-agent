const { contextBridge, ipcRenderer } = require('electron')

function sendPoint(channel, x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return
  ipcRenderer.send(channel, { x, y })
}

contextBridge.exposeInMainWorld('qwenAudioAgentDesktop', {
  dragStart: (x, y) => sendPoint('qwen-audio-agent:drag-start', x, y),
  dragMove: (x, y) => sendPoint('qwen-audio-agent:drag-move', x, y),
  dragEnd: () => ipcRenderer.send('qwen-audio-agent:drag-end'),
  openSettings: () => ipcRenderer.send('qwen-audio-agent:open-settings'),
  enterHide: () => ipcRenderer.invoke('qwen-audio-agent:enter-hide'),
  wake: () => ipcRenderer.send('qwen-audio-agent:wake'),
  lifecycleReady: () => ipcRenderer.send('qwen-audio-agent:lifecycle-ready'),
  loadLifecycle: () => ipcRenderer.invoke('qwen-audio-agent:lifecycle-load'),
  pauseWakeShortcut: () => ipcRenderer.invoke(
    'qwen-audio-agent:wake-shortcut-pause',
  ),
  resumeWakeShortcut: () => ipcRenderer.invoke(
    'qwen-audio-agent:wake-shortcut-resume',
  ),
  onLifecycle: callback => {
    if (typeof callback !== 'function') return () => {}
    const listener = (_event, lifecycle) => callback(lifecycle)
    ipcRenderer.on('qwen-audio-agent:lifecycle', listener)
    return () => ipcRenderer.removeListener(
      'qwen-audio-agent:lifecycle',
      listener,
    )
  },
  loadSettings: () => ipcRenderer.invoke('qwen-audio-agent:settings-load'),
  loadRuntimeStatus: () => ipcRenderer.invoke(
    'qwen-audio-agent:settings-runtime-status',
  ),
  detectBackends: options => ipcRenderer.invoke(
    'qwen-audio-agent:settings-detect-backends',
    { force: options?.force === true },
  ),
  installBackend: backend => ipcRenderer.invoke(
    'qwen-audio-agent:backend-install',
    { backend },
  ),
  authenticateBackend: backend => ipcRenderer.invoke(
    'qwen-audio-agent:backend-authenticate',
    { backend },
  ),
  onBackendInstallProgress: callback => {
    if (typeof callback !== 'function') return () => {}
    const listener = (_event, progress) => callback(progress)
    ipcRenderer.on('qwen-audio-agent:backend-install-progress', listener)
    return () => ipcRenderer.removeListener(
      'qwen-audio-agent:backend-install-progress',
      listener,
    )
  },
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
  importSkin: () => ipcRenderer.invoke('qwen-audio-agent:skin-import'),
  removeSkin: id => ipcRenderer.invoke('qwen-audio-agent:skin-remove', id),
  setNodePath: nodePath => ipcRenderer.invoke(
    'qwen-audio-agent:set-node-path',
    nodePath,
  ),
  openExternal: url => {
    if (typeof url !== 'string') return
    ipcRenderer.send('qwen-audio-agent:open-external', url)
  },
  quit: () => ipcRenderer.send('qwen-audio-agent:quit'),
})
