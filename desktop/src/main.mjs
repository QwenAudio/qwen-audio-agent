import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  screen,
  shell,
  Tray,
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
import { createLogger } from '../../shared/logger.mjs'
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
  findRunningGateway,
} from '../../shared/gateway-instance-lock.mjs'
import {
  desktopGatewayCompatibility,
  desktopGatewayEnvironment,
  EmbeddedGateway,
} from './gateway-process.mjs'
import {
  detectBackendSetups,
} from './backend-detection.mjs'
import {
  backendDefinition,
} from '../../shared/backend-catalog.mjs'
import {
  withBackendLifecycle,
} from '../../shared/backend-install.mjs'
import {
  createBackendInstaller,
} from './backend-installer.mjs'
import { openBackendAuthentication } from './backend-authentication.mjs'
import {
  parseSettings,
  realtimeSettingsConfigured,
  updateSettingsContent,
} from './settings-config.mjs'
import {
  startDesktopRendererServer,
} from './renderer-server.mjs'
import {
  expandProcessPath,
} from './process-path.mjs'
import {
  migrateLegacyConfig,
  resolveDesktopConfigDirectory,
} from './config-migration.mjs'
import {
  createDesktopUpdater,
} from './updater.mjs'
import { createGracefulShutdown } from './graceful-shutdown.mjs'
import { DesktopPresence } from './desktop-presence.mjs'

// macOS / Linux 图形界面应用的 PATH 只包含系统目录。在启动最早阶段
// 将其扩充为用户登录 shell 的 PATH，让 Gateway 子进程与后台可用性
// 检测能找到通过 Homebrew、nvm 或官方脚本安装的 Agent 命令。
expandProcessPath()

// 桌面版与 CLI（~/.config/qwaudio）使用相互独立的数据目录：桌面版默认走
// Electron 应用数据目录，两者的 Gateway、锁、日志与设置互不干扰；
// QWAUDIO_CONFIG_DIR 仍优先（高级用户 / Profile 场景）。
// 统一应用名，让开发模式与打包版共用同一个 userData 目录（打包版
// 的 productName 与单实例锁都基于它；开发模式默认会落到包名目录）。
app.setName('Qwen Audio Agent')
const legacyConfigDirectory = userConfigDirectory(process.env)
process.env.QWAUDIO_CONFIG_DIR = resolveDesktopConfigDirectory({
  env: process.env,
  userDataDirectory: app.getPath('userData'),
})
const configMigration = migrateLegacyConfig({
  legacyDir: legacyConfigDirectory,
  targetDir: process.env.QWAUDIO_CONFIG_DIR,
})

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
const logger = createLogger({
  component: 'desktop',
  fileName: 'desktop.log',
})
logger.info('desktop.starting', {
  version: app.getVersion(),
  packaged: app.isPackaged,
  platform: process.platform,
  arch: process.arch,
})
if (configMigration.migrated) {
  logger.info('desktop.config_migrated', {
    legacyDir: configMigration.legacyDir,
    files: configMigration.copied,
  })
}
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
    && !realtimeSettingsConfigured(initialSettings)
  )
)
const preloadPath = resolve(here, 'preload.cjs')

let mainWindow = null
let settingsWindow = null
let rendererServer = null
let dragState = null
let reconnectTimer = null
let embeddedGateway = null
let borrowedGatewayOrigin = ''
let gatewayCrashCount = 0
let lastRuntimeError = ''
let desktopUpdater = null
let tray = null

const desktopPresence = new DesktopPresence({
  getWindow: () => mainWindow,
  globalShortcut,
  logger,
})

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

function attachRunningGateway(active, environment, event = 'gateway.reused') {
  const compatibility = desktopGatewayCompatibility(active.health, environment)
  borrowedGatewayOrigin = active.origin
  const fields = {
    origin: active.origin,
    instanceId: active.lease.instanceId,
    owner: active.lease.owner,
    configurationMatch: compatibility.compatible,
  }
  if (compatibility.compatible) {
    logger.info(event, fields)
  } else {
    logger.warn(`${event}_with_runtime_configuration`, {
      ...fields,
      mismatch: compatibility.code,
      reason: compatibility.reason,
    })
  }
  return active.origin
}

async function startLocalGateway(origin) {
  if (!isLoopbackUrl(origin)) return origin
  if (embeddedGateway?.running) return embeddedGateway.start()
  const environment = configuredGatewayEnvironment()
  const active = await findRunningGateway(runtimeEnvironment.configDirectory, {
    readHealth: readGatewayHealth,
  })
  if (active) {
    return attachRunningGateway(active, environment)
  }
  borrowedGatewayOrigin = ''
  if (!embeddedGateway) {
    embeddedGateway = new EmbeddedGateway({
      preferredPort: gatewayPort(origin),
      envFactory: configuredGatewayEnvironment,
      logger: logger.child({ subsystem: 'embedded_gateway' }),
    })
    embeddedGateway.onGatewayMessage = message => {
      if (message?.type !== 'qwen-audio-agent:offline-notification') return
      const task = message.task || {}
      new Notification({
        title: '千问 Audio 提醒',
        body: String(task.result || task.objective || ''),
      }).show()
    }
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
          if (
            mainWindow
            && !mainWindow.isDestroyed()
            && desktopPresence.state !== 'hidden'
          ) {
            void loadQwenAudioAgent(mainWindow)
          }
        }).catch(error => {
          lastRuntimeError = error?.message || String(error)
          logger.error('gateway.restart_failed', { error })
        })
      }, 1000)
    }
  }
  let started
  try {
    started = await embeddedGateway.start({
      preferredPort: gatewayPort(origin),
    })
  } catch (error) {
    const winner = await findRunningGateway(
      runtimeEnvironment.configDirectory,
      {
        readHealth: readGatewayHealth,
        timeoutMs: 3000,
      },
    )
    if (!winner) throw error
    embeddedGateway = null
    return attachRunningGateway(
      winner,
      environment,
      'gateway.reused_after_race',
    )
  }
  borrowedGatewayOrigin = ''
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
    realtimeLabel: health?.realtimeLabel || null,
    realtimeModel: health?.realtimeModel || null,
    voiceConfigured: health?.voiceConfigured === true,
    realtimeConnection: health?.voiceClients?.realtime || null,
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
      autoHideSeconds: settings.autoHideSeconds,
    }))
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  } catch {
    await showUnavailable(window)
  }
}

function showDesktop(reason = 'tray') {
  if (setupRequired) {
    showSettings()
    return
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    desktopPresence.wake(reason)
    return
  }
  startConfiguredRuntime().then(() => {
    desktopPresence.wake(reason)
  }).catch(error => {
    lastRuntimeError = error?.message || String(error)
    logger.error('runtime.show_failed', { error })
    showSettings()
  })
}

function createTray() {
  if (tray) return tray
  const iconPath = resolve(
    sourceRoot,
    process.platform === 'darwin'
      ? 'desktop/build/trayTemplate.png'
      : 'desktop/build/icon.png',
  )
  let icon = nativeImage.createFromPath(iconPath)
  if (process.platform !== 'darwin' && !icon.isEmpty()) {
    icon = icon.resize({ width: 18, height: 18 })
  }
  if (process.platform === 'darwin') icon.setTemplateImage(true)
  tray = new Tray(icon)
  tray.setToolTip('Qwen Audio Agent')
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: '显示悬浮球',
      click: () => showDesktop('tray'),
    },
    {
      label: '设置…',
      click: () => showSettings(),
    },
    { type: 'separator' },
    {
      label: '退出 Qwen Audio Agent',
      click: () => app.quit(),
    },
  ]))
  return tray
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
    height: 760,
    minWidth: 460,
    minHeight: 620,
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
    if (settingsWindow === window) {
      settingsWindow = null
      if (desktopPresence.shortcutPaused) desktopPresence.resumeShortcut()
    }
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

ipcMain.handle('qwen-audio-agent:lifecycle-load', event => {
  if (!mainWindow || event.sender !== mainWindow.webContents) {
    throw new Error('无权读取桌面状态')
  }
  return { state: desktopPresence.state }
})

ipcMain.handle('qwen-audio-agent:wake-shortcut-pause', event => {
  if (!settingsWindow || event.sender !== settingsWindow.webContents) {
    throw new Error('无权修改显示快捷键')
  }
  desktopPresence.pauseShortcut()
  return true
})

ipcMain.handle('qwen-audio-agent:wake-shortcut-resume', event => {
  if (!settingsWindow || event.sender !== settingsWindow.webContents) {
    throw new Error('无权修改显示快捷键')
  }
  return desktopPresence.resumeShortcut()
})

ipcMain.handle('qwen-audio-agent:enter-hide', event => {
  if (!mainWindow || event.sender !== mainWindow.webContents) {
    throw new Error('无权修改桌面状态')
  }
  return { state: desktopPresence.hide('inactivity') }
})

ipcMain.on('qwen-audio-agent:wake', event => {
  if (mainWindow && event.sender === mainWindow.webContents) {
    desktopPresence.wake('orb')
  }
})

ipcMain.on('qwen-audio-agent:lifecycle-ready', event => {
  if (
    mainWindow
    && event.sender === mainWindow.webContents
    && desktopPresence.state === 'waking'
  ) {
    desktopPresence.ready()
  }
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
          realtimeLabel: null,
          realtimeModel: null,
          voiceConfigured: false,
          realtimeConnection: null,
          backend: null,
        }
      : await runtimeStatus(),
    setupRequired,
    runtimeError: lastRuntimeError || null,
    wakeShortcutRegistered: desktopPresence.shortcutRegistered,
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

// 与 `qwenaudio setup --json` 同款的只读检测，供设置页标注各后台
// Agent 在本机的可用状态。合并 config.env 是因为检测需要其中的
// AGENT_PROTOCOL / DASHSCOPE_API_KEY / ACP_COMMAND 等配置。
// INSTALLED_ONLY 与 gateway-process.mjs 保持一致：桌面版运行时禁止
// npx 按需回退，检测口径必须与运行时一致，只认已安装的组件。
// 检测结果按会话缓存：重复打开设置页直接复用；“刷新”按钮（force）
// 或缓存过期才真正重跑。登录 shell 与版本命令都在 Worker 中执行，
// 避免设置页首次打开时阻塞 Electron 主进程。
const BACKEND_REPORT_TTL_MS = 10 * 60 * 1000
let backendReportCache = null
let backendReportPending = null

// 检测环境：config.env 叠加在进程环境之上，与 Gateway 运行时口径一致。
function backendDetectionEnvironment() {
  const configured = existsSync(runtimeEnvironment.configPath)
    ? parseEnv(readFileSync(runtimeEnvironment.configPath, 'utf8'))
    : {}
  return {
    ...process.env,
    ...configured,
    QWEN_AUDIO_AGENT_DESKTOP_INSTALLED_ONLY: '1',
  }
}

// 执行一次完整检测：主进程沿用 Worker 读取到的登录 shell PATH（只赋值，
// 不再执行任何阻塞命令），并为每个后台附加一键安装能力——渲染层无法
// 访问 Node 环境，安装规格只能由主进程查询后随报告一起下发。
function runBackendDetection() {
  return detectBackendSetups({ env: backendDetectionEnvironment() })
    .then(result => {
      if (result.path) process.env.PATH = result.path
      return withBackendLifecycle(result.report, {
        env: backendDetectionEnvironment(),
      })
    })
}

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
  if (backendReportPending) return backendReportPending
  backendReportPending = runBackendDetection().then(report => {
    backendReportCache = { report, time: Date.now() }
    return report
  }).finally(() => {
    backendReportPending = null
  })
  return backendReportPending
})

// 后台 Agent 一键安装：规格与执行逻辑在 shared/backend-install.mjs，
// 与 CLI `qwenaudio install` 同一份；这里只负责原生确认框、进度推送
// 与安装后的整体重检。脚本类步骤的确认发生在可信主进程（原生对话框
// 展示完整命令文本），渲染层无法绕过。
const backendInstaller = createBackendInstaller({
  env: backendDetectionEnvironment,
  confirmScript: async step => {
    if (!settingsWindow || settingsWindow.isDestroyed()) return false
    const { response } = await dialog.showMessageBox(settingsWindow, {
      type: 'warning',
      message: '即将执行官方安装脚本',
      detail: `该后台 Agent 没有 npm 安装包，主进程将执行官方安装脚本：\n\n${step.command}\n\n请确认你信任该脚本来源后再继续。`,
      buttons: ['执行', '取消'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    })
    return response === 0
  },
})

ipcMain.handle('qwen-audio-agent:backend-install', async (event, payload) => {
  if (!settingsWindow || event.sender !== settingsWindow.webContents) {
    throw new Error('无权安装后台 Agent')
  }
  // 渲染层只能传后台 id；安装规格从主进程目录白名单查询，
  // 命令不拼接任何用户输入。
  const id = typeof payload === 'string' ? payload : payload?.backend
  const definition = backendDefinition(id)
  if (!definition) {
    throw new Error(`不支持的后台：${String(id || '')}`)
  }
  const support = backendInstaller.support(definition.id)
  if (!support.supported) {
    return {
      ok: false,
      error: { code: 'UNSUPPORTED', message: support.reason },
    }
  }
  // 业务失败（含用户取消、npm 缺失、安装失败）以结构化结果返回，
  // 保留 error.code 供渲染层区分提示；同一后台并发重入由 installer
  // 守卫直接抛错拒绝。
  return backendInstaller.install(definition.id, {
    onProgress: progress => {
      if (settingsWindow && !settingsWindow.isDestroyed()) {
        settingsWindow.webContents.send(
          'qwen-audio-agent:backend-install-progress',
          { backend: definition.id, ...progress },
        )
      }
    },
    // 安装完成后整体重检：Worker 读取最新登录 shell PATH（主进程沿用），
    // 并刷新设置页缓存，让报告立刻反映新安装的后台。
    inspect: async () => {
      const report = await runBackendDetection()
      backendReportCache = { report, time: Date.now() }
      return report
    },
  })
})

ipcMain.handle('qwen-audio-agent:backend-authenticate', async (event, payload) => {
  if (!settingsWindow || event.sender !== settingsWindow.webContents) {
    throw new Error('无权启动后台 Agent 登录')
  }
  const id = typeof payload === 'string' ? payload : payload?.backend
  const definition = backendDefinition(id)
  if (!definition) throw new Error(`不支持的后台：${String(id || '')}`)
  await openBackendAuthentication(definition.id, {
    env: backendDetectionEnvironment(),
  })
  logger.info('backend.authentication_opened', { backend: definition.id })
  return { ok: true }
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
  if (!remote && !realtimeSettingsConfigured(normalized)) {
    throw new Error(normalized.realtimeProvider === 'dashscope'
      ? '请先填写 DashScope API Key'
      : '请先填写 Speech-to-Speech 服务地址')
  }
  if (remote) {
    const remoteRuntime = await runtimeStatus(nextOrigin)
    if (!remoteRuntime.gatewayConnected) {
      throw new Error(`无法连接 Gateway：${nextOrigin}`)
    }
  }
  const gatewayChanged = nextOrigin !== configuredGatewayOrigin
  const apiKeyChanged = previous.dashscopeApiKey !== normalized.dashscopeApiKey
  const realtimeProviderChanged = (
    previous.realtimeProvider !== normalized.realtimeProvider
  )
  const backendChanged = previous.agentProtocol !== normalized.agentProtocol
  const realtimeModelChanged = previous.realtimeModel !== normalized.realtimeModel
  const speechToSpeechChanged = (
    previous.speechToSpeechRealtimeUrl
      !== normalized.speechToSpeechRealtimeUrl
    || previous.speechToSpeechAuthToken
      !== normalized.speechToSpeechAuthToken
  )
  const backendModelChanged = previous.backendModel !== normalized.backendModel
  const orbStyleChanged = previous.orbStyle !== normalized.orbStyle
  const autoHideChanged = (
    previous.autoHideSeconds !== normalized.autoHideSeconds
  )
  const wakeShortcutChanged = previous.wakeShortcut !== normalized.wakeShortcut
  const wakeWordChanged = (
    previous.wakeWordEnabled !== normalized.wakeWordEnabled
    || previous.sleepTimeoutSeconds !== normalized.sleepTimeoutSeconds
  )
  const gatewayRuntimeChanged = (
    gatewayChanged
    || apiKeyChanged
    || realtimeProviderChanged
    || backendChanged
    || realtimeModelChanged
    || speechToSpeechChanged
    || backendModelChanged
    || wakeWordChanged
  )
  if (!remote && borrowedGatewayOrigin && gatewayRuntimeChanged) {
    const borrowedHealth = await readGatewayHealth(borrowedGatewayOrigin)
    if (borrowedHealth) {
      const nextEnvironment = desktopGatewayEnvironment({
        env: process.env,
        configured: parseEnv(content),
        runtimeRoot,
        sourceRoot,
      })
      const compatibility = desktopGatewayCompatibility(
        borrowedHealth,
        nextEnvironment,
      )
      if (!compatibility.compatible) {
        throw new Error(
          `${compatibility.reason}；当前 Gateway 由其他进程管理，请先停止它再应用该设置`,
        )
      }
    }
    if (!borrowedHealth) borrowedGatewayOrigin = ''
  }
  if (
    wakeShortcutChanged
    && !desktopPresence.registerShortcut(normalized.wakeShortcut)
  ) {
    throw new Error('这个显示快捷键已被其他应用占用，请选择另一个')
  }
  try {
    writeFileSync(runtimeEnvironment.configPath, content, {
      encoding: 'utf8',
      mode: 0o600,
    })
  } catch (error) {
    if (wakeShortcutChanged) desktopPresence.registerShortcut(previous.wakeShortcut)
    throw error
  }
  chmodSync(runtimeEnvironment.configPath, 0o600)
  logger.info('settings.applied', {
    realtimeProvider: normalized.realtimeProvider,
    backend: normalized.agentProtocol,
    remoteGateway: remote,
    changes: {
      gateway: gatewayChanged,
      apiKey: apiKeyChanged,
      realtimeProvider: realtimeProviderChanged,
      backend: backendChanged,
      realtimeModel: realtimeModelChanged,
      speechToSpeech: speechToSpeechChanged,
      backendModel: backendModelChanged,
      orbStyle: orbStyleChanged,
      autoHide: autoHideChanged,
      wakeShortcut: wakeShortcutChanged,
      wakeWord: wakeWordChanged,
    },
  })
  let restarted = false
  configuredGatewayOrigin = nextOrigin
  if (remote) {
    if (embeddedGateway) {
      await embeddedGateway.stop()
      embeddedGateway = null
    }
    borrowedGatewayOrigin = ''
    appOrigin = nextOrigin
  } else if (
    embeddedGateway?.running
    && gatewayRuntimeChanged
  ) {
    appOrigin = await embeddedGateway.restart({
      preferredPort: gatewayPort(nextOrigin),
    })
    restarted = true
  } else if (!embeddedGateway?.running) {
    appOrigin = await startLocalGateway(nextOrigin)
    restarted = !borrowedGatewayOrigin
  }
  setupRequired = false
  lastRuntimeError = ''
  process.env.QWEN_AUDIO_AGENT_URL = appOrigin
  process.env.QWEN_AUDIO_ORB_STYLE = normalized.orbStyle
  await ensureDesktopUi()
  const runtime = await runtimeStatus(appOrigin)
  if (
    (restarted || gatewayChanged || orbStyleChanged || autoHideChanged)
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
    wakeShortcutRegistered: desktopPresence.shortcutRegistered,
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
    desktopPresence.wake('second-instance')
  })

  app.whenReady().then(async () => {
    if (process.platform === 'darwin' && process.defaultApp) {
      app.setActivationPolicy('accessory')
      app.dock?.hide()
    }
    createTray()
    if (!desktopPresence.registerShortcut(initialSettings.wakeShortcut)) {
      logger.warn('desktop.wake_shortcut_unavailable', {
        accelerator: initialSettings.wakeShortcut,
      })
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
        logger.error('runtime.start_failed', { error })
        showSettings()
      }
    }
    app.on('activate', () => {
      if (setupRequired) {
        showSettings()
        return
      }
      if (!BrowserWindow.getAllWindows().length) {
        void ensureDesktopUi().then(() => desktopPresence.wake('activate'))
        return
      }
      desktopPresence.wake('activate')
    })
  }).catch(error => {
    const message = error?.stack || error?.message || String(error)
    logger.fatal('desktop.start_failed', { error, message })
    dialog.showErrorBox('Qwen Audio Agent 无法启动', message)
    app.quit()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', createGracefulShutdown({
    app,
    cleanup: async () => {
      logger.info('desktop.stopping')
      desktopPresence.destroy()
      tray?.destroy()
      tray = null
      const server = rendererServer
      rendererServer = null
      const gateway = embeddedGateway
      embeddedGateway = null
      await Promise.allSettled([
        server?.close(),
        gateway?.stop(),
      ])
      await logger.flush?.()
    },
    onError: error => logger.error('desktop.stop_failed', { error }),
  }))
}
