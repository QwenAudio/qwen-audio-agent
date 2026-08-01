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
  detectBackends: () => ipcRenderer.invoke(
    'qwen-audio-agent:settings-detect-backends',
  ),
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
