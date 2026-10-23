const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('viduAvatarDesktop', {
  canSwitchToOrb: process.argv.includes('--digital-human-orb-switch'),
  startDrag: point => ipcRenderer.send('vidu-avatar:drag-start', point),
  moveDrag: point => ipcRenderer.send('vidu-avatar:drag-move', point),
  endDrag: () => ipcRenderer.send('vidu-avatar:drag-end'),
  quit: () => ipcRenderer.send('vidu-avatar:quit'),
  switchToOrb: () => ipcRenderer.send('vidu-avatar:switch-to-orb'),
})
