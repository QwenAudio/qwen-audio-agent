import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  screen,
  shell,
  systemPreferences,
  Tray,
} from 'electron'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createLogger } from '../../shared/logger.mjs'
import {
  BAILIAN_API_KEY_URL,
  desktopOrbUrl,
  isSafeExternalUrl,
  isSameOrigin,
} from './security.mjs'
import {
  startDesktopRendererServer,
} from './renderer-server.mjs'
import {
  expandProcessPath,
} from './process-path.mjs'
import {
  createDesktopUpdater,
} from './updater.mjs'
import { createDesktopRuntime } from './runtime-adapter.mjs'
import {
  parseWindowsStartupArguments,
  registerWindowsIntegrationIpc,
  WindowsDesktopIntegration,
} from './windows-integration.mjs'
import {
  applyOpenAtLogin,
  readOpenAtLogin,
  WindowsPreferencesStore,
} from './windows-preferences.mjs'
import { clampWindowBounds } from './window-placement.mjs'
import { readBundledWslRuntimeManifest } from './wsl-runtime-manifest.mjs'

// macOS / Linux 图形界面应用的 PATH 只包含系统目录。在启动最早阶段
// 将其扩充为用户登录 shell 的 PATH，让 Gateway 子进程与后台可用性
// 检测能找到通过 Homebrew、nvm 或官方脚本安装的 Agent 命令。
if (process.platform !== 'win32') expandProcessPath()

const here = dirname(fileURLToPath(import.meta.url))
const sourceRoot = resolve(here, '../..')
const runtimeRoot = app.isPackaged
  ? resolve(process.resourcesPath, 'runtime')
  : sourceRoot
const logger = createLogger({
  component: 'desktop',
  fileName: 'desktop.log',
  ...(process.platform === 'win32'
    ? { directory: resolve(app.getPath('userData'), 'logs') }
    : {}),
})
logger.info('desktop.starting', {
  version: app.getVersion(),
  packaged: app.isPackaged,
  platform: process.platform,
  arch: process.arch,
})
const fallbackPage = resolve(here, 'orb-unavailable.html')
const fallbackUrl = pathToFileURL(fallbackPage).href
const settingsPage = resolve(here, 'settings.html')
const repairPage = resolve(here, 'repair.html')
const webRoot = resolve(sourceRoot, 'web/dist')
const preloadPath = resolve(here, 'preload.cjs')
const windowsStartup = parseWindowsStartupArguments(process.argv)
const windowsPreferencesStore = process.platform === 'win32'
  ? new WindowsPreferencesStore({ app })
  : null
const windowsPayloadDirectory = app.isPackaged
  ? resolve(process.resourcesPath, 'wsl-runtime')
  : resolve(sourceRoot, 'dist/wsl-runtime')
let windowsPayload = {
  packageVersion: app.getVersion(),
  runtimeSha256: '',
  bundledTarballPath: resolve(
    windowsPayloadDirectory,
    `qwen-audio-agent-${app.getVersion()}.tgz`,
  ),
}
if (process.platform === 'win32') {
  try {
    windowsPayload = readBundledWslRuntimeManifest({
      directory: windowsPayloadDirectory,
      desktopVersion: app.getVersion(),
    })
  } catch {
    // The controller presents a fixed integrity failure without exposing paths.
  }
}

const desktopRuntime = createDesktopRuntime({
  platform: process.platform,
  architecture: process.arch,
  dependencies: {
    native: { runtimeRoot, sourceRoot, logger },
    windows: {
      desktopVersion: app.getVersion(),
      ...windowsPayload,
      preferences: windowsPreferencesStore,
    },
  },
})
let appOrigin = desktopRuntime.origin
let setupRequired = desktopRuntime.status.state === 'setup-required'

let mainWindow = null
let settingsWindow = null
let repairWindow = null
let rendererServer = null
let dragState = null
let reconnectTimer = null
let lastRuntimeError = ''
let desktopUpdater = null
let windowsIntegration = null
let runtimeWasRecovering = false
let desktopResourcesStopped = false

const unsubscribeRuntimeStatus = desktopRuntime.subscribeStatus(status => {
  const previousOrigin = appOrigin
  appOrigin = desktopRuntime.origin
  setupRequired = status.state === 'setup-required'
  lastRuntimeError = ['error', 'recovering'].includes(status.state)
    ? status.reason || 'desktop runtime is unavailable'
    : ''
  const recovered = status.state === 'ready' && runtimeWasRecovering
  runtimeWasRecovering = status.state === 'recovering'
  if (
    recovered
    && appOrigin
    && appOrigin !== previousOrigin
    && mainWindow
    && !mainWindow.isDestroyed()
  ) {
    void loadQwenAudioAgent(mainWindow)
  }
})

async function ensureDesktopUi() {
  if (!rendererServer) {
    rendererServer = await startDesktopRendererServer({
      webRoot,
      target: () => appOrigin,
    })
  }
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createWindow()
  }
}

async function startConfiguredRuntime() {
  const status = await desktopRuntime.initialize()
  appOrigin = desktopRuntime.origin
  setupRequired = status.state === 'setup-required'
  if (setupRequired) return null
  if (!['ready', 'external'].includes(status.state) || !appOrigin) {
    throw new Error(status.reason || 'desktop runtime is unavailable')
  }
  await ensureDesktopUi()
  lastRuntimeError = ''
  return appOrigin
}

async function runtimeStatus() {
  return desktopRuntime.getRuntimeStatus()
}

function windowsWindowBounds(kind) {
  return clampWindowBounds({
    kind,
    bounds: windowsIntegration?.preferences?.windowBounds?.[kind] || null,
    displays: screen.getAllDisplays(),
  })
}

async function stopDesktopResources() {
  if (desktopResourcesStopped) return
  desktopResourcesStopped = true
  unsubscribeRuntimeStatus()
  const server = rendererServer
  rendererServer = null
  await server?.close()
}

function isDesktopRendererUrl(value) {
  return Boolean(
    rendererServer
    && isSameOrigin(value, rendererServer.origin),
  )
}

function configurePermissions(window) {
  const electronSession = window.webContents.session
  electronSession.setPermissionCheckHandler((
    _webContents,
    permission,
    requestingOrigin,
    details,
  ) => {
    const origin = details?.securityOrigin || requestingOrigin
    return permission === 'media' && isDesktopRendererUrl(origin)
  })
  electronSession.setPermissionRequestHandler((
    webContents,
    permission,
    callback,
    details,
  ) => {
    const source = details?.requestingUrl
      || details?.securityOrigin
      || webContents.getURL()
    const mediaTypes = details?.mediaTypes || []
    const audioOnly = !mediaTypes.length
      || mediaTypes.every(type => type === 'audio')
    callback(
      permission === 'media'
      && audioOnly
      && isDesktopRendererUrl(source),
    )
  })
}

async function showUnavailable(window) {
  if (window.isDestroyed()) return
  await window.loadFile(fallbackPage, {
    query: { target: appOrigin },
  })
  clearTimeout(reconnectTimer)
  reconnectTimer = setTimeout(() => {
    if (mainWindow === window && !window.isDestroyed()) {
      void loadQwenAudioAgent(window)
    }
  }, 3000)
}

async function loadQwenAudioAgent(window) {
  try {
    if (!rendererServer) throw new Error('desktop renderer is unavailable')
    const settings = await desktopRuntime.readSettings()
    await window.loadURL(desktopOrbUrl(rendererServer.baseUrl, {
      orbStyle: settings.orbStyle,
    }))
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  } catch {
    await showUnavailable(window)
  }
}

function createWindow() {
  const width = 172
  const height = 170
  const bounds = process.platform === 'win32'
    ? windowsWindowBounds('orb')
    : {
        x: screen.getPrimaryDisplay().workArea.x
          + screen.getPrimaryDisplay().workArea.width - width - 24,
        y: screen.getPrimaryDisplay().workArea.y + 24,
        width,
        height,
      }
  const window = new BrowserWindow({
    ...bounds,
    minWidth: width,
    minHeight: height,
    maxWidth: width,
    maxHeight: height,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    title: 'qwen-audio-agent',
    autoHideMenuBar: true,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // The floating window is normally unfocused. Keep its renderer timers
      // aligned with Web Audio so playback receipts are not delayed and retried.
      backgroundThrottling: false,
      preload: preloadPath,
    },
  })

  window.setAlwaysOnTop(true, 'floating')
  configurePermissions(window)

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    if (isDesktopRendererUrl(url) || url.startsWith(fallbackUrl)) return
    event.preventDefault()
    if (isSafeExternalUrl(url)) void shell.openExternal(url)
  })
  if (process.platform !== 'win32') {
    window.once('ready-to-show', () => window.show())
  }
  window.on('blur', () => {
    dragState = null
  })
  window.on('closed', () => {
    if (mainWindow === window) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
      mainWindow = null
    }
  })
  if (process.platform === 'win32') {
    windowsIntegration?.attachWindow('orb', window)
  }

  loadQwenAudioAgent(window)
  return window
}

function createSettingsWindow() {
  const bounds = process.platform === 'win32'
    ? windowsWindowBounds('settings')
    : { width: 540, height: 860 }
  const window = new BrowserWindow({
    ...bounds,
    minWidth: 460,
    minHeight: 640,
    title: '设置',
    backgroundColor: '#f5f6f7',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: preloadPath,
    },
  })
  window.setMenuBarVisibility(false)
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', event => event.preventDefault())
  if (process.platform !== 'win32') {
    window.once('ready-to-show', () => window.show())
  }
  window.on('closed', () => {
    if (settingsWindow === window) settingsWindow = null
  })
  if (process.platform === 'win32') {
    windowsIntegration?.attachWindow('settings', window)
  }
  void window.loadFile(settingsPage)
  return window
}

function createRepairWindow() {
  const bounds = windowsWindowBounds('repair')
  const window = new BrowserWindow({
    ...bounds,
    minWidth: 520,
    minHeight: 600,
    title: '运行环境',
    backgroundColor: '#f3f5f6',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: preloadPath,
    },
  })
  window.setMenuBarVisibility(false)
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', event => event.preventDefault())
  window.on('closed', () => {
    if (repairWindow === window) repairWindow = null
  })
  windowsIntegration?.attachWindow('repair', window)
  void window.loadFile(repairPage)
  return window
}

function showSettings() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    if (settingsWindow.isMinimized()) settingsWindow.restore()
    settingsWindow.show()
    settingsWindow.focus()
    return settingsWindow
  }
  settingsWindow = createSettingsWindow()
  if (process.platform === 'win32') {
    settingsWindow.show()
    settingsWindow.focus()
  }
  return settingsWindow
}

function showRepair() {
  if (repairWindow && !repairWindow.isDestroyed()) {
    if (repairWindow.isMinimized()) repairWindow.restore()
    repairWindow.show()
    repairWindow.focus()
    return repairWindow
  }
  repairWindow = createRepairWindow()
  repairWindow.show()
  repairWindow.focus()
  return repairWindow
}

async function showWindowsSurface(kind) {
  if (kind === 'settings') {
    showSettings()
    return
  }
  if (kind === 'repair') {
    showRepair()
    return
  }
  if (kind !== 'orb') throw new Error(`Unsupported Windows surface: ${kind}`)
  await ensureDesktopUi()
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function windowsSurface(kind) {
  if (kind === 'orb') return mainWindow
  if (kind === 'settings') return settingsWindow
  if (kind === 'repair') return repairWindow
  return null
}

function validPoint(point) {
  return (
    Number.isFinite(point?.x)
    && Number.isFinite(point?.y)
  )
}

ipcMain.on('qwen-audio-agent:drag-start', (event, point) => {
  if (!mainWindow || event.sender !== mainWindow.webContents || !validPoint(point)) return
  const [windowX, windowY] = mainWindow.getPosition()
  dragState = {
    pointerX: point.x,
    pointerY: point.y,
    windowX,
    windowY,
  }
})

ipcMain.on('qwen-audio-agent:drag-move', (event, point) => {
  if (
    !mainWindow
    || event.sender !== mainWindow.webContents
    || !dragState
    || !validPoint(point)
  ) return
  mainWindow.setPosition(
    Math.round(dragState.windowX + point.x - dragState.pointerX),
    Math.round(dragState.windowY + point.y - dragState.pointerY),
  )
})

ipcMain.on('qwen-audio-agent:drag-end', event => {
  if (mainWindow && event.sender === mainWindow.webContents) dragState = null
})

ipcMain.on('qwen-audio-agent:open-settings', event => {
  if (mainWindow && event.sender === mainWindow.webContents) showSettings()
})

ipcMain.on('qwen-audio-agent:open-bailian-api-key-page', event => {
  if (!settingsWindow || event.sender !== settingsWindow.webContents) return
  void shell.openExternal(BAILIAN_API_KEY_URL)
})

ipcMain.handle('qwen-audio-agent:settings-load', async event => {
  if (!settingsWindow || event.sender !== settingsWindow.webContents) {
    throw new Error('无权读取设置')
  }
  const settings = await desktopRuntime.readSettings()
  return {
    settings,
    runtime: setupRequired
      ? {
          gatewayConnected: false,
          realtimeProvider: null,
          realtimeLabel: null,
          realtimeModel: null,
          voiceConfigured: false,
          realtimeConnection: null,
          backend: null,
        }
      : await runtimeStatus(),
    setupRequired,
    runtimeError: lastRuntimeError || null,
    restartRequired: false,
  }
})

ipcMain.handle('qwen-audio-agent:settings-runtime-status', async event => {
  if (!settingsWindow || event.sender !== settingsWindow.webContents) {
    throw new Error('无权读取运行状态')
  }
  return runtimeStatus()
})

ipcMain.handle('qwen-audio-agent:open-logs', async event => {
  if (!settingsWindow || event.sender !== settingsWindow.webContents) {
    throw new Error('无权打开日志目录')
  }
  logger.info('logs.opened', { directory: logger.directory })
  const failure = await shell.openPath(logger.directory)
  if (failure) throw new Error(`无法打开日志目录：${failure}`)
  return logger.directory
})

ipcMain.handle('qwen-audio-agent:settings-detect-backends', async (event, options) => {
  if (!settingsWindow || event.sender !== settingsWindow.webContents) {
    throw new Error('无权检测后台 Agent')
  }
  return desktopRuntime.inspectBackends({ force: options?.force === true })
})

ipcMain.handle('qwen-audio-agent:updater-status', event => {
  if (!settingsWindow || event.sender !== settingsWindow.webContents) {
    throw new Error('无权读取更新状态')
  }
  return desktopUpdater?.state() || null
})

ipcMain.handle('qwen-audio-agent:updater-check', async event => {
  if (!settingsWindow || event.sender !== settingsWindow.webContents) {
    throw new Error('无权检查更新')
  }
  return desktopUpdater ? desktopUpdater.check() : null
})

// 仅在安装包已下载完成时允许触发安装，避免误重启。
ipcMain.handle('qwen-audio-agent:updater-install', async event => {
  if (!settingsWindow || event.sender !== settingsWindow.webContents) {
    throw new Error('无权安装更新')
  }
  if (desktopUpdater?.state().phase === 'downloaded') {
    if (process.platform === 'win32' && windowsIntegration) {
      await windowsIntegration.installUpdate(() => desktopUpdater.install())
    } else {
      desktopUpdater.install()
    }
  }
})

ipcMain.handle('qwen-audio-agent:settings-save', async (event, settings) => {
  if (!settingsWindow || event.sender !== settingsWindow.webContents) {
    throw new Error('无权保存设置')
  }
  const result = await desktopRuntime.writeSettings(settings)
  appOrigin = desktopRuntime.origin
  setupRequired = false
  lastRuntimeError = ''
  await ensureDesktopUi()
  if (
    (result.restarted || result.orbStyleChanged)
    && mainWindow
    && !mainWindow.isDestroyed()
  ) {
    void loadQwenAudioAgent(mainWindow)
  }
  return result
})

ipcMain.on('qwen-audio-agent:quit', event => {
  if (!mainWindow || event.sender !== mainWindow.webContents) return
  if (process.platform === 'win32' && windowsIntegration) {
    void windowsIntegration.quit()
  } else {
    app.quit()
  }
})

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (process.platform === 'win32' && windowsIntegration) {
      void windowsIntegration.handleSecondInstance()
      return
    }
    if (setupRequired || !mainWindow) {
      showSettings()
      return
    }
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  app.whenReady().then(async () => {
    if (process.platform === 'darwin' && process.defaultApp) {
      app.setActivationPolicy('accessory')
      app.dock?.hide()
    }
    desktopUpdater = createDesktopUpdater({
      currentVersion: app.getVersion(),
      enabled: app.isPackaged,
      notify: status => {
        windowsIntegration?.refreshUpdaterStatus()
        if (settingsWindow && !settingsWindow.isDestroyed()) {
          settingsWindow.webContents.send(
            'qwen-audio-agent:updater-status',
            status,
          )
        }
      },
    })
    if (process.platform === 'win32') {
      windowsIntegration = new WindowsDesktopIntegration({
        app,
        runtime: desktopRuntime,
        preferencesStore: windowsPreferencesStore,
        Tray,
        Menu,
        trayIcon: app.isPackaged
          ? resolve(process.resourcesPath, 'desktop', 'icon.png')
          : resolve(here, '../build/icon.png'),
        windows: {
          get: windowsSurface,
          show: showWindowsSurface,
        },
        updater: desktopUpdater,
        readOpenAtLogin,
        applyOpenAtLogin,
        getMicrophoneAccess: () => (
          systemPreferences.getMediaAccessStatus('microphone')
        ),
        beforeQuit: stopDesktopResources,
      })
      await windowsIntegration.initialize()
      registerWindowsIntegrationIpc({
        ipcMain,
        integration: windowsIntegration,
        runtime: desktopRuntime,
        clipboard,
        shell,
      })
    }
    try {
      await startConfiguredRuntime()
      if (windowsIntegration) {
        await windowsIntegration.presentInitialState(windowsStartup)
      } else if (setupRequired) {
        showSettings()
      }
    } catch (error) {
      lastRuntimeError = error?.message || String(error)
      setupRequired = true
      logger.error('runtime.start_failed', { error })
      if (windowsIntegration) {
        await windowsIntegration.presentInitialState(windowsStartup)
      } else {
        showSettings()
      }
    }
    app.on('activate', () => {
      if (windowsIntegration) {
        void windowsIntegration.handleSecondInstance()
        return
      }
      if (setupRequired) {
        showSettings()
        return
      }
      if (!BrowserWindow.getAllWindows().length) {
        void ensureDesktopUi()
      }
    })
  }).catch(error => {
    const message = error?.stack || error?.message || String(error)
    logger.fatal('desktop.start_failed', { error, message })
    dialog.showErrorBox('Qwen Audio Agent 无法启动', message)
    app.quit()
  })

  app.on('window-all-closed', () => {
    if (process.platform === 'win32') {
      windowsIntegration?.handleWindowAllClosed()
      return
    }
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', event => {
    if (process.platform === 'win32') {
      if (windowsIntegration && !windowsIntegration.exiting) {
        logger.info('desktop.stopping')
        event.preventDefault()
        void windowsIntegration.quit()
      }
      return
    }
    logger.info('desktop.stopping')
    void stopDesktopResources()
    void desktopRuntime.stop()
  })
}
