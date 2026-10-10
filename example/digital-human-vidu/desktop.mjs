import { app, BrowserWindow, ipcMain, screen, session } from 'electron'
import { once } from 'node:events'
import { mkdirSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { configureOrbWindow } from '../../desktop/src/orb-shell.mjs'
import { overlayWindowBounds, overlayWindowOptions } from './desktop-window.mjs'

const pageOrigin = 'http://127.0.0.1:5181'
const devScript = fileURLToPath(new URL('./dev.mjs', import.meta.url))
const preload = fileURLToPath(new URL('./preload.cjs', import.meta.url))
const desktopApp = fileURLToPath(new URL('../../desktop', import.meta.url))
let runtime
let overlay
let closing = false
app.setName('Qwen Audio Agent · Vidu')
// Keep the alternative host separate from the stock desktop singleton.
const userData = fileURLToPath(new URL('./.desktop', import.meta.url))
mkdirSync(userData, { recursive: true })
app.setPath('userData', userData)
if (!app.requestSingleInstanceLock()) app.exit(0)
app.on('second-instance', () => { overlay?.show(); overlay?.focus() })

function trustedRenderer(webContents, requestingUrl = '') {
  try { return new URL(requestingUrl || webContents?.getURL()).origin === pageOrigin } catch { return false }
}

function configureMicrophonePermission() {
  const allowed = (webContents, permission, requestingUrl) => (
    permission === 'media' && trustedRenderer(webContents, requestingUrl)
  )
  session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin) => (
    allowed(webContents, permission, requestingOrigin)
  ))
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(allowed(webContents, permission, details.requestingUrl))
  })
}

async function startRuntime() {
  // An already-running browser demo owns its server; attach without spawning a
  // second Vite/RTC proxy on the same ports or stopping that server on quit.
  try {
    const response = await fetch(`${pageOrigin}/vidu/api/config`, { signal: AbortSignal.timeout(1_000) })
    const config = response.ok ? await response.json() : null
    if (config?.example === 'digital-human-vidu') return
  } catch { /* start our own runtime */ }
  const environment = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  runtime = spawn(process.execPath, ['--env-file-if-exists=.env.local', devScript], {
    cwd: fileURLToPath(new URL('./', import.meta.url)),
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const child = runtime
  child.stderr.pipe(process.stderr)
  child.stdout.pipe(process.stdout)
  const ready = new Promise((resolve, reject) => {
    let output = ''
    let settled = false
    const timer = setTimeout(() => failed(new Error('Vidu Agent startup timed out')), 25_000)
    const finish = callback => value => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.off('error', failed)
      child.off('exit', exited)
      child.stdout.off('data', onData)
      callback(value)
    }
    const failed = finish(reject)
    const exited = finish((code, signal) => reject(new Error(
      `Vidu Agent exited before startup (${signal || code})`,
    )))
    child.once('error', failed)
    child.once('exit', exited)
    const onData = chunk => {
      output = (output + chunk).slice(-2048)
      if (output.includes('Vidu digital human: http://127.0.0.1:5181')) finish(resolve)()
    }
    child.stdout.on('data', onData)
  })
  runtime.on('exit', (code, signal) => {
    if (closing) return
    console.error(`Vidu Agent runtime stopped unexpectedly (${signal || code})`)
    overlay?.destroy()
    app.quit()
  })
  return ready
}

async function closeRuntime() {
  if (closing) return
  closing = true
  const child = runtime
  runtime = null
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM')
    let timer
    await Promise.race([once(child, 'exit'), new Promise(resolve => { timer = setTimeout(resolve, 5_000) })])
    clearTimeout(timer)
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
}

async function start() {
  await app.whenReady()
  if (process.platform === 'darwin') app.dock?.hide()
  configureMicrophonePermission()
  await startRuntime()
  overlay = new BrowserWindow({
    ...overlayWindowOptions(overlayWindowBounds(screen.getPrimaryDisplay().workArea), preload),
  })
  configureOrbWindow(overlay)
  overlay.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  overlay.webContents.on('will-navigate', (event, url) => {
    if (!trustedRenderer(null, url)) event.preventDefault()
  })
  overlay.once('ready-to-show', () => overlay.showInactive())
  overlay.on('closed', () => { overlay = null; app.quit() })
  await overlay.loadURL(`${pageOrigin}/?overlay=1`)
  console.log('Vidu Avatar overlay: running at the bottom-right of the primary display')
}

ipcMain.on('vidu-avatar:quit', event => {
  if (overlay && event.sender === overlay.webContents) app.quit()
})

ipcMain.on('vidu-avatar:switch-to-orb', async event => {
  if (!overlay || event.sender !== overlay.webContents) return
  await closeRuntime()
  const environment = { ...process.env }
  delete environment.ELECTRON_RUN_AS_NODE
  const settings = spawn(process.execPath, [desktopApp], {
    detached: true, env: environment, stdio: 'ignore',
  })
  settings.on('error', error => console.error(`Settings: ${error.message}`))
  settings.unref()
  app.quit()
})

app.on('window-all-closed', () => app.quit())
app.on('before-quit', event => {
  if (closing) return
  event.preventDefault()
  closeRuntime().finally(() => app.quit())
})

start().catch(async error => {
  console.error(`Vidu Avatar overlay: ${error.message}`)
  await closeRuntime()
  app.exit(1)
})
