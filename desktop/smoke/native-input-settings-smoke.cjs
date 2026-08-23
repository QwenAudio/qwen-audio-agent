const { app, BrowserWindow, ipcMain } = require('electron')
const { resolve } = require('node:path')

const root = resolve(__dirname, '../..')
const lifecycle = {
  installed: true,
  registered: true,
  enabled: false,
  version: '1.11.0',
  state: 'needs-enable',
}
const runtime = {
  gatewayConnected: false,
  backend: null,
  realtimeProvider: 'dashscope',
  realtimeModel: 'qwen3-omni-flash-realtime',
  voiceConfigured: false,
}
let lifecycleStatusCalls = 0
let openSettingsRequests = 0

app.commandLine.appendSwitch('lang', 'en-US')

function waitFor(probe, timeoutMs = 5_000, describe = () => '') {
  const started = Date.now()
  return new Promise((resolveWait, rejectWait) => {
    const check = async () => {
      try {
        const value = await probe()
        if (value) return resolveWait(value)
      } catch {
        // The renderer can be between navigation and module initialization.
      }
      if (Date.now() - started >= timeoutMs) {
        Promise.resolve(describe()).then(description => rejectWait(new Error(
          `Timed out waiting for native input settings UI: ${description}`,
        )))
        return
      }
      setTimeout(check, 20)
    }
    void check()
  })
}

app.whenReady().then(async () => {
  const { parseSettings } = await import(
    resolve(root, 'desktop/src/settings-config.mjs')
  )
  ipcMain.handle('qwen-audio-agent:settings-load', () => ({
    settings: parseSettings('AGENT_PROTOCOL=none\n'),
    skins: [{ id: 'fluid', type: 'theme', displayName: 'Fluid' }],
    runtime,
    wakeShortcutRegistered: true,
  }))
  ipcMain.handle('qwen-audio-agent:settings-runtime-status', () => runtime)
  ipcMain.handle('qwen-audio-agent:settings-detect-backends', () => ({
    backends: [],
  }))
  ipcMain.handle('qwen-audio-agent:updater-status', () => ({
    phase: 'idle',
    currentVersion: '1.11.0',
  }))
  ipcMain.handle('qwen-audio-agent:native-input-lifecycle', (_event, action) => {
    if (action !== 'status') throw new Error('Unexpected lifecycle action')
    lifecycleStatusCalls += 1
    return { ...lifecycle }
  })
  ipcMain.on('qwen-audio-agent:native-input-open-settings', () => {
    openSettingsRequests += 1
  })

  const window = new BrowserWindow({
    width: 600,
    height: 800,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: resolve(root, 'desktop/src/preload.cjs'),
    },
  })
  await window.loadFile(resolve(root, 'desktop/src/settings.html'))
  const readNativeInputControls = () => window.webContents.executeJavaScript(`({
    language: document.documentElement.lang,
    status: document.querySelector('#native-input-status')?.textContent,
    buttonText: document.querySelector('#native-input-system-settings')?.textContent,
    buttonVisible: !document.querySelector('#native-input-system-settings')?.hidden,
  })`)
  const initial = await waitFor(async () => {
    const value = await readNativeInputControls()
    return value.status === 'Installed. Enable Qwen Input in System Settings.'
      ? value
      : null
  }, 5_000, async () => JSON.stringify({
    controls: await readNativeInputControls(),
    lifecycleStatusCalls,
  }))

  await window.webContents.executeJavaScript(
    "document.querySelector('#native-input-system-settings').click()",
  )
  await waitFor(() => openSettingsRequests === 1)

  const callsBeforeFocus = lifecycleStatusCalls
  Object.assign(lifecycle, { enabled: true, state: 'ready' })
  await window.webContents.executeJavaScript(
    "window.dispatchEvent(new Event('focus'))",
  )
  const refreshedStatus = await waitFor(async () => {
    const text = await window.webContents.executeJavaScript(
      "document.querySelector('#native-input-status')?.textContent",
    )
    return text === 'Installed and enabled. Select Qwen Input from the input menu.'
      ? text
      : null
  })

  process.stdout.write(`NATIVE_INPUT_SETTINGS_PROBE:${JSON.stringify({
    ...initial,
    openSettingsRequests,
    callsBeforeFocus,
    callsAfterFocus: lifecycleStatusCalls,
    refreshedStatus,
  })}\n`)
  window.destroy()
  app.quit()
}).catch(error => {
  process.stderr.write(`${error?.stack || error}\n`)
  app.exit(1)
})

app.on('window-all-closed', () => {})
