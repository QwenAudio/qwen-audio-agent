// Optional window shell for the SAME client. No Gateway, renderer or receipt
// state machine here; it opens the already-running example host.
import { app, BrowserWindow, ipcMain, session, screen } from 'electron'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { bindWindowDrag } from './window-drag.mjs'

const page = new URL(process.env.DH_DESKTOP_URL || 'http://127.0.0.1:5273')
if (page.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(page.hostname)
  || page.username || page.password || page.pathname !== '/' || page.search || page.hash) throw new Error('DH_DESKTOP_URL must be a loopback HTTP origin')
const orbCommand = process.env.DH_ORB_LAUNCH ? JSON.parse(process.env.DH_ORB_LAUNCH) : null
if (orbCommand && (!Array.isArray(orbCommand) || !orbCommand.length || orbCommand.some(value => typeof value !== 'string' || !value))) throw new Error('DH_ORB_LAUNCH must be a JSON argv array')
app.setName('Qwen Audio Agent · Digital human example')
const userData = fileURLToPath(new URL('../.desktop/', import.meta.url))
mkdirSync(userData, { recursive: true })
app.setPath('userData', userData)
if (!app.requestSingleInstanceLock()) app.exit(0)
let window
const owned = event => event.sender === window?.webContents
app.on('second-instance', () => { window?.show(); window?.focus() })
app.whenReady().then(async () => {
  const trusted = contents => {
    try { return new URL(contents?.getURL()).origin === page.origin } catch { return false }
  }
  session.defaultSession.setPermissionCheckHandler((contents, permission) => permission === 'media' && trusted(contents))
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => callback(permission === 'media' && trusted(contents)))
  const area = screen.getPrimaryDisplay().workArea
  const width = Math.min(390, area.width), height = Math.min(620, area.height)
  window = new BrowserWindow({ width, height, x: area.x + area.width - width, y: area.y + area.height - height,
    frame: false, resizable: false, alwaysOnTop: false, backgroundColor: '#0c0d14',
    webPreferences: { preload: fileURLToPath(new URL('./preload.cjs', import.meta.url)),
      contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false,
      additionalArguments: orbCommand ? ['--digital-human-orb-switch'] : [] },
  })
  const drag = bindWindowDrag({ ipc: ipcMain, getWindow: () => window })
  window.on('blur', drag.cancel)
  window.on('closed', () => { drag.dispose(); window = null; app.quit() })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => { if (new URL(url).origin !== page.origin) event.preventDefault() })
  ipcMain.handle('vidu-avatar:set-always-on-top', (event, value) => {
    if (!owned(event) || typeof value !== 'boolean') return false
    window.setAlwaysOnTop(value)
    return window.isAlwaysOnTop()
  })
  ipcMain.on('vidu-avatar:quit', event => { if (owned(event)) app.quit() })
  ipcMain.on('vidu-avatar:switch-to-orb', event => {
    if (!owned(event) || !orbCommand) return
    const environment = { ...process.env }
    delete environment.ELECTRON_RUN_AS_NODE
    const child = spawn(orbCommand[0], orbCommand.slice(1), { env: environment, shell: false, detached: true, stdio: 'ignore' })
    child.once('spawn', () => { child.unref(); app.quit() })
    child.once('error', () => { /* leave this window open for retry */ })
  })
  page.searchParams.set('overlay', '1')
  await window.loadURL(page.href)
}).catch(error => { console.error(`Digital-human window: ${error.message}`); app.exit(1) })
