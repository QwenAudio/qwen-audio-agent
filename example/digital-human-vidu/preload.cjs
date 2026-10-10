const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('viduAvatarDesktop', {
  quit: () => ipcRenderer.send('vidu-avatar:quit'),
  switchToOrb: () => ipcRenderer.send('vidu-avatar:switch-to-orb'),
})
