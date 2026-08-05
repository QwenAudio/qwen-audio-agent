const { app, BrowserWindow, Menu, nativeImage, Tray } = require('electron')
const { resolve } = require('node:path')

let tray

app.whenReady().then(async () => {
  app.dock?.hide()
  const window = new BrowserWindow({
    width: 120,
    height: 120,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  await window.loadURL('data:text/html,<title>qwen-audio-agent smoke</title>')
  const icon = nativeImage.createFromPath(resolve(
    __dirname,
    '../build/trayTemplate.png',
  ))
  icon.setTemplateImage(true)
  tray = new Tray(icon)
  tray.setContextMenu(Menu.buildFromTemplate([{ label: 'Qwen Audio Agent' }]))
  window.showInactive()
  window.hide()
  window.showInactive()
  process.stdout.write('QWEN_AUDIO_DESKTOP_SMOKE_OK\n')
  tray.destroy()
  tray = null
  window.destroy()
  app.quit()
}).catch(error => {
  process.stderr.write(`${error?.stack || error}\n`)
  app.exit(1)
})

app.on('window-all-closed', () => {})
