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
  openExternal: url => {
    if (typeof url !== 'string') return
    ipcRenderer.send('qwen-audio-agent:open-external', url)
  },
  quit: () => ipcRenderer.send('qwen-audio-agent:quit'),
})
