import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  screen,
  shell,
} from 'electron'
import {
  chmodSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseEnv } from 'node:util'
import {
  loadRuntimeEnvironment,
  userConfigDirectory,
} from '../../shared/runtime-environment.mjs'
import {
  desktopOrbUrl,
  isLoopbackUrl,
  isSafeExternalUrl,
  isSameOrigin,
  validateAppUrl,
} from './security.mjs'
import {
  readGatewayHealth,
} from '../../shared/gateway-client.mjs'
import {
  inspectBackendSetups,
} from '../../shared/backend-setup.mjs'
import {
  desktopGatewayEnvironment,
  EmbeddedGateway,
} from './gateway-process.mjs'
import {
  parseSettings,
  updateSettingsContent,
} from './settings-config.mjs'
import {
  startDesktopRendererServer,
} from './renderer-server.mjs'
import {
  expandProcessPath,
  refreshProcessPath,
} from './process-path.mjs'
import {
  createDesktopUpdater,
} from './updater.mjs'

// macOS / Linux 图形界面应用的 PATH 只包含系统目录。在启动最早阶段
// 将其扩充为用户登录 shell 的 PATH，让 Gateway 子进程与后台可用性
// 检测能找到通过 Homebrew、nvm 或官方脚本安装的 Agent 命令。
expandProcessPath()

const here = dirname(fileURLToPath(import.meta.url))
const sourceRoot = resolve(here, '../..')
const runtimeRoot = app.isPackaged
  ? resolve(process.resourcesPath, 'runtime')
  : sourceRoot
const expectedConfigPath = resolve(
  userConfigDirectory(process.env),
  'config.env',
)
const configExistedAtLaunch = existsSync(expectedConfigPath)
const runtimeEnvironment = loadRuntimeEnvironment({
  root: runtimeRoot,
  prepareBackendRuntime: false,
  generateSecret: false,
})
const fallbackPage = resolve(here, 'orb-unavailable.html')
const fallbackUrl = pathToFileURL(fallbackPage).href
const settingsPage = resolve(here, 'settings.html')
const webRoot = resolve(sourceRoot, 'web/dist')
const initialSettings = parseSettings(
  readFileSync(runtimeEnvironment.configPath, 'utf8'),
  process.env,
)
let configuredGatewayOrigin = validateAppUrl(initialSettings.gatewayUrl)
let appOrigin = configuredGatewayOrigin
let setupRequired = (
  !configExistedAtLaunch
  || (
    isLoopbackUrl(configuredGatewayOrigin)
    && !initialSettings.dashscopeApiKey
  )
)
const preloadPath = resolve(here, 'preload.cjs')

let mainWindow = null
let settingsWindow = null
let rendererServer = null
let dragState = null
let reconnectTimer = null
let embeddedGateway = null
let gatewayCrashCount = 0
let lastRuntimeError = ''
let desktopUpdater = null

const MAX_GATEWAY_CRASH_RESTARTS = 3

function configuredOrigin() {
  const settings = parseSettings(
    readFileSync(runtimeEnvironment.configPath, 'utf8'),
    process.env,
  )
  return {
    origin: validateAppUrl(settings.gatewayUrl),
    settings,
  }
}

function configuredGatewayEnvironment() {
  const configured = parseEnv(
    readFileSync(runtimeEnvironment.configPath, 'utf8'),
  )
  return desktopGatewayEnvironment({
    env: process.env,
    configured,
    runtimeRoot,
    sourceRoot,
  })
}

function gatewayPort(origin) {
  const port = Number(new URL(origin).port)
  return Number.isInteger(port) && port > 0 ? port : 3101
}

// The desktop always owns its loopback Gateway. If the configured port is
// already occupied, EmbeddedGateway selects another loopback port instead of
// adopting a process that the desktop cannot safely manage.
async function startLocalGateway(origin) {
  if (!isLoopbackUrl(origin)) return origin
  if (!embeddedGateway) {
    embeddedGateway = new EmbeddedGateway({
      preferredPort: gatewayPort(origin),
      envFactory: configuredGatewayEnvironment,
    })
    embeddedGateway.onUnexpectedExit = () => {
      lastRuntimeError = '内置 Gateway 意外退出'
      if (gatewayCrashCount >= MAX_GATEWAY_CRASH_RESTARTS) return
      gatewayCrashCount += 1
      const gateway = embeddedGateway
      setTimeout(() => {
        if (embeddedGateway !== gateway || gateway.running) return
        gateway.start().then(restarted => {
          lastRuntimeError = ''
          appOrigin = restarted
          process.env.QWEN_AUDIO_AGENT_URL = restarted
          if (mainWindow && !mainWindow.isDestroyed()) {
            void loadQwenAudioAgent(mainWindow)
          }
        }).catch(error => {
          lastRuntimeError = error?.message || String(error)
          console.error('Failed to restart embedded gateway:', error)
        })
      }, 1000)
    }
  }
  const started = await embeddedGateway.start({
    preferredPort: gatewayPort(origin),
  })
  gatewayCrashCount = 0
  return started
}

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

async function startConfiguredRuntime(settings = configuredOrigin().settings) {
  configuredGatewayOrigin = validateAppUrl(settings.gatewayUrl)
  appOrigin = isLoopbackUrl(configuredGatewayOrigin)
    ? await startLocalGateway(configuredGatewayOrigin)
    : configuredGatewayOrigin
  process.env.QWEN_AUDIO_AGENT_URL = appOrigin
  process.env.QWEN_AUDIO_ORB_STYLE = settings.orbStyle
  await ensureDesktopUi()
  lastRuntimeError = ''
  return appOrigin
}

async function runtimeStatus(target = appOrigin) {
  const health = await readGatewayHealth(target)
  return {
    gatewayConnected: Boolean(health),
    realtimeProvider: health?.realtimeProvider || null,
    realtimeModel: health?.realtimeModel || null,
    voiceConfigured: health?.voiceConfigured === true,
    backend: health?.backend
      ? {
          protocol: health.backend.kind || health.backend.protocol || null,
          label: health.backend.label || null,
          baseUrl: health.backend.baseUrl || null,
          model: health.backend.model || null,
          connected: health.backend.ok === true,
          error: health.backend.error || null,
        }
      : null,
  }
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
    const settings = parseSettings(
      readFileSync(runtimeEnvironment.configPath, 'utf8'),
      process.env,
    )
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
  const { workArea } = screen.getPrimaryDisplay()
  const width = 172
  const height = 170
  const window = new BrowserWindow({
    width,
    height,
    minWidth: width,
    minHeight: height,
    maxWidth: width,
    maxHeight: height,
    x: workArea.x + workArea.width - width - 24,
    y: workArea.y + 24,
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
  window.once('ready-to-show', () => window.show())
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

  loadQwenAudioAgent(window)
  return window
}

function createSettingsWindow() {
  const window = new BrowserWindow({
    width: 540,
    height: 730,
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
  window.once('ready-to-show', () => window.show())
  window.on('closed', () => {
    if (settingsWindow === window) settingsWindow = null
  })
  void window.loadFile(settingsPage)
  return window
}

function showSettings() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    if (settingsWindow.isMinimized()) settingsWindow.restore()
    settingsWindow.show()
    settingsWindow.focus()
    return
  }
  settingsWindow = createSettingsWindow()
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

const ALLOWED_EXTERNAL_HOSTS = new Set(['bailian.console.aliyun.com'])

ipcMain.on('qwen-audio-agent:open-external', (event, value) => {
  if (!settingsWindow || event.sender !== settingsWindow.webContents) return
  let target
  try {
    target = new URL(String(value))
  } catch {
    return
  }
  if (target.protocol !== 'https:' || !ALLOWED_EXTERNAL_HOSTS.has(target.hostname)) {
    return
  }
  void shell.openExternal(target.href)
})

ipcMain.handle('qwen-audio-agent:settings-load', async event => {
  if (!settingsWindow || event.sender !== settingsWindow.webContents) {
    throw new Error('无权读取设置')
  }
  const settings = parseSettings(
    readFileSync(runtimeEnvironment.configPath, 'utf8'),
    process.env,
  )
  return {
    settings,
    runtime: setupRequired
      ? {
          gatewayConnected: false,
          realtimeProvider: null,
          realtimeModel: null,
          voiceConfigured: false,
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

// 与 `qwenaudio setup --json` 同款的只读检测，供设置页标注各后台
// Agent 在本机的可用状态。合并 config.env 是因为检测需要其中的
// AGENT_PROTOCOL / DASHSCOPE_API_KEY / ACP_COMMAND 等配置。
// INSTALLED_ONLY 与 gateway-process.mjs 保持一致：桌面版运行时禁止
// npx 按需回退，检测口径必须与运行时一致，只认已安装的组件。
// 检测结果按会话缓存：重复打开设置页直接复用；“刷新”按钮（force）
// 或缓存过期才真正重跑。真正检测前同步刷新登录 shell PATH，
// 保证刚安装的命令立即可见。
const BACKEND_REPORT_TTL_MS = 10 * 60 * 1000
let backendReportCache = null

ipcMain.handle('qwen-audio-agent:settings-detect-backends', async (event, options) => {
  if (!settingsWindow || event.sender !== settingsWindow.webContents) {
    throw new Error('无权检测后台 Agent')
  }
  const now = Date.now()
  if (
    options?.force !== true
    && backendReportCache
    && now - backendReportCache.time < BACKEND_REPORT_TTL_MS
  ) {
    return backendReportCache.report
  }
  refreshProcessPath()
  const configured = existsSync(runtimeEnvironment.configPath)
    ? parseEnv(readFileSync(runtimeEnvironment.configPath, 'utf8'))
    : {}
  const report = inspectBackendSetups({
    env: {
      ...process.env,
      ...configured,
      QWEN_AUDIO_AGENT_DESKTOP_INSTALLED_ONLY: '1',
    },
  })
  const result = {
    selected: report.selected,
    backends: report.backends.map(item => ({
      id: item.id,
      label: item.label,
      ready: item.ready,
      selected: item.selected,
      issues: item.issues,
    })),
  }
  backendReportCache = { report: result, time: now }
  return result
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
ipcMain.handle('qwen-audio-agent:updater-install', event => {
  if (!settingsWindow || event.sender !== settingsWindow.webContents) {
    throw new Error('无权安装更新')
  }
  if (desktopUpdater?.state().phase === 'downloaded') {
    desktopUpdater.install()
  }
})

ipcMain.handle('qwen-audio-agent:settings-save', async (event, settings) => {
  if (!settingsWindow || event.sender !== settingsWindow.webContents) {
    throw new Error('无权保存设置')
  }
  const current = readFileSync(runtimeEnvironment.configPath, 'utf8')
  const previous = parseSettings(current, process.env)
  const content = updateSettingsContent(current, settings)
  const normalized = parseSettings(content)
  const nextOrigin = validateAppUrl(normalized.gatewayUrl)
  const remote = !isLoopbackUrl(nextOrigin)
  if (!remote && !normalized.dashscopeApiKey) {
    throw new Error('请先填写 DashScope API Key')
  }
  if (remote) {
    const remoteRuntime = await runtimeStatus(nextOrigin)
    if (!remoteRuntime.gatewayConnected) {
      throw new Error(`无法连接 Gateway：${nextOrigin}`)
    }
  }
  writeFileSync(runtimeEnvironment.configPath, content, {
    encoding: 'utf8',
    mode: 0o600,
  })
  chmodSync(runtimeEnvironment.configPath, 0o600)
  const gatewayChanged = nextOrigin !== configuredGatewayOrigin
  const apiKeyChanged = previous.dashscopeApiKey !== normalized.dashscopeApiKey
  const backendChanged = previous.agentProtocol !== normalized.agentProtocol
  const realtimeModelChanged = previous.realtimeModel !== normalized.realtimeModel
  const backendModelChanged = previous.backendModel !== normalized.backendModel
  const orbStyleChanged = previous.orbStyle !== normalized.orbStyle
  let restarted = false
  configuredGatewayOrigin = nextOrigin
  if (remote) {
    if (embeddedGateway) {
      await embeddedGateway.stop()
      embeddedGateway = null
    }
    appOrigin = nextOrigin
  } else if (
    embeddedGateway?.running
    && (
      gatewayChanged
      || apiKeyChanged
      || backendChanged
      || realtimeModelChanged
      || backendModelChanged
    )
  ) {
    appOrigin = await embeddedGateway.restart({
      preferredPort: gatewayPort(nextOrigin),
    })
    restarted = true
  } else if (!embeddedGateway?.running) {
    appOrigin = await startLocalGateway(nextOrigin)
    restarted = true
  }
  setupRequired = false
  lastRuntimeError = ''
  process.env.QWEN_AUDIO_AGENT_URL = appOrigin
  process.env.QWEN_AUDIO_ORB_STYLE = normalized.orbStyle
  await ensureDesktopUi()
  const runtime = await runtimeStatus(appOrigin)
  if (
    (restarted || gatewayChanged || orbStyleChanged)
    && mainWindow
    && !mainWindow.isDestroyed()
  ) {
    void loadQwenAudioAgent(mainWindow)
  }
  return {
    settings: normalized,
    restarted,
    restartRequired: false,
    runtime,
  }
})

ipcMain.on('qwen-audio-agent:quit', event => {
  if (mainWindow && event.sender === mainWindow.webContents) app.quit()
})

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
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
        if (settingsWindow && !settingsWindow.isDestroyed()) {
          settingsWindow.webContents.send(
            'qwen-audio-agent:updater-status',
            status,
          )
        }
      },
    })
    if (setupRequired) {
      showSettings()
    } else {
      try {
        await startConfiguredRuntime(initialSettings)
      } catch (error) {
        lastRuntimeError = error?.message || String(error)
        setupRequired = true
        console.error('Failed to start configured desktop runtime:', error)
        showSettings()
      }
    }
    app.on('activate', () => {
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
    console.error('Failed to start Qwen Audio Agent:', message)
    dialog.showErrorBox('Qwen Audio Agent 无法启动', message)
    app.quit()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => {
    void rendererServer?.close()
    rendererServer = null
    const gateway = embeddedGateway
    embeddedGateway = null
    void gateway?.stop()
  })
}
