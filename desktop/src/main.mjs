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
import { mergeSearchPath } from '../../shared/path-environment.mjs'
import { createLogger } from '../../shared/logger.mjs'
import {
  desktopOrbUrl,
  isLoopbackUrl,
  isSafeExternalUrl,
  isSameOrigin,
  validateAppUrl,
} from './security.mjs'
import {
  desktopTranslator,
  effectiveDesktopLanguage,
} from './i18n.mjs'
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
  resolveBorrowedGatewayAttachment,
} from './gateway-process.mjs'
import { remoteRealtimeModelOutcome } from './realtime-status.mjs'
import {
  detectBackendSetups,
} from './backend-detection.mjs'
import {
  backendDefinition,
} from '../../shared/backend-catalog.mjs'
import {
  DESKTOP_ORB_HEIGHT,
  DESKTOP_ORB_WIDTH,
  desktopOrbBounds,
  desktopSurfaceLayout,
} from './desktop-surface-layout.mjs'
import { createOrbPlacement } from './orb-placement.mjs'
import { bindOrbShell, configureOrbWindow } from './orb-shell.mjs'
import { createSettingsStore } from './settings-store.mjs'
import {
  withBackendLifecycle,
} from '../../shared/backend-install.mjs'
import {
  createBackendInstaller,
} from './backend-installer.mjs'
import { openBackendConfiguration } from './backend-configuration.mjs'
import {
  parseSettings,
  realtimeSettingsConfigured,
  updateSettingsContent,
  applySettingsEnvironment,
} from './settings-config.mjs'
import {
  effectiveOrbSkin as resolveEffectiveOrbSkin,
  importSkin,
  listSkins,
  removeSkin,
  skinsDirectory,
} from './skin-store.mjs'
import {
  BUILTIN_ORB_SKINS,
} from '../../shared/orb-skin-catalog.mjs'
import {
  startDesktopRendererServer,
} from './renderer-server.mjs'
import {
  expandProcessPath,
} from './process-path.mjs'
import {
  backfillSharedAssets,
  resolveDesktopConfigDirectory,
} from './config-migration.mjs'
import {
  createDesktopUpdater,
} from './updater.mjs'
import { createGracefulShutdown } from './graceful-shutdown.mjs'
import { DesktopPresence } from './desktop-presence.mjs'
import {
  NativeInputHost,
  nativeInputBridgePath,
} from './native-input-host.mjs'
import { NativeInputFeature } from './native-input-feature.mjs'
import { NativeInputLifecycle } from './native-input-lifecycle.mjs'

// macOS / Linux 图形界面应用的 PATH 只包含系统目录。在启动最早阶段
// 将其扩充为用户登录 shell 的 PATH，让 Gateway 子进程与后台可用性
// 检测能找到通过 Homebrew、nvm 或官方脚本安装的 Agent 命令。
expandProcessPath()

// 桌面版与 CLI 的运行时状态（Gateway、锁、日志、皮肤）互相独立：桌面版
// 默认走 Electron 应用数据目录；QWAUDIO_CONFIG_DIR 仍优先（高级用户 /
// Profile 场景）。资产层（配置、身份、记忆、清单、workspace）则共享 CLI
// 的用户数据目录（QWAUDIO_DATA_DIR），两种形态是同一个助手。
// 统一应用名，让开发模式与打包版共用同一个 userData 目录（打包版
// 的 productName 与单实例锁都基于它；开发模式默认会落到包名目录）。
app.setName('Qwen Audio Agent')
const legacyConfigDirectory = userConfigDirectory(process.env)
process.env.QWAUDIO_CONFIG_DIR = resolveDesktopConfigDirectory({
  env: process.env,
  userDataDirectory: app.getPath('userData'),
})
if (!process.env.QWAUDIO_DATA_DIR) {
  // legacyConfigDirectory 在覆写 QWAUDIO_CONFIG_DIR 之前解析，显式配置的
  // 目录（Profile 场景）会让资产与运行时落在同一处，保持完全隔离。
  process.env.QWAUDIO_DATA_DIR = legacyConfigDirectory
}
// 旧版本桌面版持有各自演化的资产副本，切到共享资产层前先一次性回填。
const assetBackfill = backfillSharedAssets({
  desktopDir: process.env.QWAUDIO_CONFIG_DIR,
  dataDir: process.env.QWAUDIO_DATA_DIR,
})

const here = dirname(fileURLToPath(import.meta.url))
const sourceRoot = resolve(here, '../..')
const runtimeRoot = app.isPackaged
  ? resolve(process.resourcesPath, 'runtime')
  : sourceRoot
const expectedConfigPath = resolve(
  process.env.QWAUDIO_DATA_DIR,
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
const skinsRoot = skinsDirectory(runtimeEnvironment.configDirectory)
// 设置表单读写共享资产层的 config.env（与 CLI 同一份）；悬浮球摆位等
// 窗口状态是桌面专属，经 ui-state.json 留在桌面版自己的数据目录。
const desktopSettingsStore = createSettingsStore({
  configDir: runtimeEnvironment.dataDirectory,
  uiStateDir: runtimeEnvironment.configDirectory,
})
const orbPlacement = createOrbPlacement({
  getDisplays: () => screen.getAllDisplays(),
  orbSize: { width: DESKTOP_ORB_WIDTH, height: DESKTOP_ORB_HEIGHT },
  loadState: () => desktopSettingsStore.orbPosition.load(),
  saveState: state => desktopSettingsStore.orbPosition.save(state),
})

// 生效皮肤：内置 id 直接用；导入皮肤缺包时回退 fluid（skin-store 单一实现）。
function effectiveOrbSkin(orbSkin) {
  return resolveEffectiveOrbSkin(orbSkin, { skinsRoot })
}
logger.info('desktop.starting', {
  version: app.getVersion(),
  packaged: app.isPackaged,
  platform: process.platform,
  arch: process.arch,
})
if (assetBackfill.backfilled) {
  logger.info('desktop.assets_backfilled', {
    dataDir: process.env.QWAUDIO_DATA_DIR,
    files: assetBackfill.copied,
    skipped: assetBackfill.skipped,
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
let desktopLanguage = initialSettings.language
const desktopText = (text, params) => desktopTranslator(
  desktopLanguage,
  app.getLocale(),
)(text, params)
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
let desktopTaskCount = 0
let desktopTaskPlacement = 'below'
let desktopOrbOffsetX = 0
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
const nativeInputDevelopmentTools = (
  process.defaultApp
  && process.env.QWEN_AUDIO_NATIVE_INPUT_DEVTOOLS === 'true'
)
const nativeInputHost = new NativeInputHost({
  resolveArtifact: () => nativeInputBridgePath({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
  }),
  onEmergencyStop: reason => {
    logger.error('native_input.emergency_stop', { reason })
  },
})
const nativeInputFeature = new NativeInputFeature({
  enabled: process.platform === 'darwin' && initialSettings.nativeInputEnabled,
  accelerator: initialSettings.nativeInputShortcut,
  globalShortcut,
  host: nativeInputHost,
  onSessionRequest: request => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    desktopPresence.wake()
    mainWindow.webContents.send(
      'qwen-audio-agent:native-input-session-request',
      request,
    )
  },
})
const nativeInputLifecycle = new NativeInputLifecycle({ host: nativeInputHost })

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
  const raw = readFileSync(runtimeEnvironment.configPath, 'utf8')
  const configured = parseEnv(raw)
  // 滤掉空值：config 文件中 KEY=（无值）会解析出 KEY: ''，
  // 展开为 desktopGatewayEnvironment.merged 时会覆盖 process.env 的同名变量。
  const configuredNonEmpty = {}
  for (const [key, value] of Object.entries(configured)) {
    if (value !== '') configuredNonEmpty[key] = value
  }
  // 自动休眠超时必须与 orb 前端一致：config.env 可能缺省（首次安装），
  // 这里总是注入经 parseSettings 归一化后的有效值，避免前端 60 秒隐藏
  // 而网关 sleepTimeoutMs=0 永不休眠的分歧。
  const settings = parseSettings(raw, process.env)
  return desktopGatewayEnvironment({
    env: process.env,
    configured: {
      ...configuredNonEmpty,
      QWEN_AUDIO_DESKTOP_AUTO_HIDE_SECONDS: String(settings.autoHideSeconds),
    },
    runtimeRoot,
    sourceRoot,
  })
}

function gatewayPort(origin) {
  const port = Number(new URL(origin).port)
  return Number.isInteger(port) && port > 0 ? port : 3101
}

function attachRunningGateway(active, environment, event = 'gateway.reused') {
  const attachment = resolveBorrowedGatewayAttachment(active, environment)
  borrowedGatewayOrigin = attachment.origin
  const fields = {
    origin: attachment.origin,
    instanceId: active.lease.instanceId,
    owner: active.lease.owner,
    configurationMatch: attachment.compatibility.compatible,
  }
  if (attachment.compatibility.compatible) {
    logger.info(event, fields)
  } else {
    logger.warn(`${event}_with_runtime_configuration`, {
      ...fields,
      mismatch: attachment.compatibility.code,
      reason: attachment.compatibility.reason,
    })
  }
  return attachment.origin
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
      skinsRoot,
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
  process.env.QWEN_AUDIO_ORB_SKIN = settings.orbSkin
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
    realtimeModelProfile: health?.realtimeModelProfile || null,
    voiceConfigured: health?.voiceConfigured === true,
    realtimeConnection: health?.voiceClients?.realtime || null,
    backend: health?.backend
      ? {
          protocol: health.backend.kind || health.backend.protocol || null,
          label: health.backend.label || null,
          baseUrl: health.backend.baseUrl || null,
          model: health.backend.model || null,
          connected: health.backend.ok === true,
          status: health.backend.status || null,
          code: health.backend.code || null,
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
      orbSkin: effectiveOrbSkin(settings.orbSkin),
      autoHideSeconds: settings.autoHideSeconds,
      wakeWordEnabled: settings.wakeWordEnabled,
      language: effectiveDesktopLanguage(settings.language, app.getLocale()),
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
  if (!tray) {
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
  }
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: desktopText('显示悬浮球'),
      click: () => showDesktop('tray'),
    },
    {
      label: desktopText('设置…'),
      click: () => showSettings(),
    },
    { type: 'separator' },
    {
      label: desktopText('退出 Qwen Audio Agent'),
      click: () => app.quit(),
    },
  ]))
  return tray
}

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay()
  const width = DESKTOP_ORB_WIDTH
  const height = DESKTOP_ORB_HEIGHT
  const initialPosition = orbPlacement.initialPosition()
  const window = new BrowserWindow({
    width,
    height,
    minWidth: width,
    minHeight: height,
    maxWidth: workArea.width,
    maxHeight: workArea.height,
    x: initialPosition.x,
    y: initialPosition.y,
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

  // 悬浮层级与全屏空间可见性统一走 orb-shell 契约（与嵌入宿主同一配方）。
  configureOrbWindow(window)
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
  window.webContents.on('render-process-gone', () => {
    nativeInputFeature.rendererLost()
  })
  window.once('ready-to-show', () => window.show())
  window.on('blur', () => {
    orbShell.cancelDrag()
  })
  window.on('closed', () => {
    if (mainWindow === window) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
      mainWindow = null
      desktopTaskCount = 0
      desktopTaskPlacement = 'below'
      desktopOrbOffsetX = 0
    }
  })

  loadQwenAudioAgent(window)
  return window
}

function createSettingsWindow() {
  const { width: workAreaWidth, height: workAreaHeight } = screen
    .getDisplayNearestPoint(screen.getCursorScreenPoint())
    .workAreaSize
  const settingsWindowWidth = Math.max(
    460,
    Math.min(600, workAreaWidth - 48),
  )
  const settingsWindowHeight = Math.max(
    600,
    Math.min(800, workAreaHeight - 48),
  )
  const window = new BrowserWindow({
    width: settingsWindowWidth,
    height: settingsWindowHeight,
    minWidth: 460,
    minHeight: 600,
    title: desktopText('设置'),
    backgroundColor: '#f4f5f6',
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

// 悬浮球 IPC（拖拽、生命周期、打开设置、请求退出）统一走 orb-shell 契约
// 绑定：桌面版与嵌入宿主共用同一份实现，防止两个外壳漂移。
const orbShell = bindOrbShell({
  ipc: ipcMain,
  getWindow: () => mainWindow,
  presence: desktopPresence,
  logger,
  onOpenSettings: () => showSettings(),
  onQuit: () => app.quit(),
  onDragEnd: () => {
    const [x, y] = mainWindow.getPosition()
    orbPlacement.recordPosition({ x, y })
    updateDesktopTaskSurface(desktopTaskCount)
  },
})

function updateDesktopTaskSurface(value) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const taskCount = Math.min(100, Math.max(0, Math.floor(Number(value) || 0)))
  const bounds = mainWindow.getBounds()
  const orbBounds = desktopOrbBounds(bounds, {
    taskCount: desktopTaskCount,
    placement: desktopTaskPlacement,
    orbOffsetX: desktopOrbOffsetX,
  })
  const workArea = screen.getDisplayMatching(orbBounds).workArea
  const layout = desktopSurfaceLayout({
    bounds,
    currentTaskCount: desktopTaskCount,
    taskCount,
    placement: desktopTaskPlacement,
    orbOffsetX: desktopOrbOffsetX,
    workArea,
  })
  desktopTaskCount = taskCount
  desktopTaskPlacement = layout.placement
  desktopOrbOffsetX = layout.orbOffsetX
  mainWindow.webContents.send(
    'qwen-audio-agent:task-card-placement',
    {
      placement: desktopTaskPlacement,
      orbOffsetX: desktopOrbOffsetX,
    },
  )
  const next = layout.bounds
  if (
    bounds.x !== next.x
    || bounds.y !== next.y
    || bounds.width !== next.width
    || bounds.height !== next.height
  ) {
    // The orb is the visual anchor. Animating the transparent window bounds
    // makes the orb appear to slide before the renderer applies its offset.
    mainWindow.setBounds(next, false)
  }
}

ipcMain.on('qwen-audio-agent:task-card-count', (event, value) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) return
  updateDesktopTaskSurface(value)
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

function assertNativeInputDevelopmentSender(event) {
  if (
    !nativeInputDevelopmentTools
    || !mainWindow
    || event.sender !== mainWindow.webContents
  ) {
    throw new Error('Native input development controls are unavailable')
  }
}

ipcMain.handle('qwen-audio-agent:native-input-status', event => {
  if (
    (!mainWindow || event.sender !== mainWindow.webContents)
    && (!settingsWindow || event.sender !== settingsWindow.webContents)
  ) throw new Error('Native input status is unavailable')
  return {
    ...nativeInputFeature.snapshot(),
    lifecycle: nativeInputLifecycle.snapshot(),
  }
})

ipcMain.handle('qwen-audio-agent:native-input-operation', async (event, value) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) {
    throw new Error('Native input operation is unavailable')
  }
  const type = String(value?.type || '')
  if (![
    'session.arm', 'session.partial', 'session.final', 'session.operation',
    'session.cancel', 'session.pause', 'session.resume',
  ].includes(type)) throw new Error('Native input operation is not allowed')
  return nativeInputHost.request({
    type,
    operationId: String(value?.operationId || ''),
    ...(typeof value?.text === 'string' ? { text: value.text.slice(0, 4096) } : {}),
    ...(Number.isInteger(value?.revision) ? { revision: value.revision } : {}),
    ...(Number.isInteger(value?.seq) ? { seq: value.seq } : {}),
    ...(value?.operation ? { operation: String(value.operation) } : {}),
    ...(value?.target ? { target: String(value.target) } : {}),
    ...(value?.replacement ? { replacement: String(value.replacement) } : {}),
    ...(value?.reason ? { reason: String(value.reason) } : {}),
    statusVisible: mainWindow.isVisible(),
  })
})

ipcMain.handle('qwen-audio-agent:native-input-lifecycle', async (event, value) => {
  if (!settingsWindow || event.sender !== settingsWindow.webContents) {
    throw new Error('Native input lifecycle controls are unavailable')
  }
  const action = String(value || '')
  if (!['status', 'install', 'repair', 'uninstall'].includes(action)) {
    throw new Error('Native input lifecycle action is not allowed')
  }
  if (action !== 'status') {
    const { response } = await dialog.showMessageBox(settingsWindow, {
      type: action === 'uninstall' ? 'warning' : 'question',
      buttons: [desktopText('继续'), desktopText('取消')],
      defaultId: 1,
      cancelId: 1,
      title: desktopText('管理 Qwen Input'),
      message: action === 'uninstall'
        ? desktopText('将停用并移除当前用户的 Qwen Input。')
        : desktopText('将为当前用户安装并注册 Qwen Input；系统不会自动启用或切换输入法。'),
    })
    if (response !== 0) return { cancelled: true }
  }
  const startedTemporarily = nativeInputHost.state === 'idle'
  if (startedTemporarily || nativeInputHost.state === 'starting') {
    await nativeInputHost.start()
  }
  try {
    const status = await nativeInputLifecycle[action]()
    nativeInputFeature.applyLifecycleStatus(status)
    return status
  } finally {
    if (startedTemporarily) await nativeInputHost.stop('lifecycle_complete')
  }
})

ipcMain.on('qwen-audio-agent:native-input-open-settings', event => {
  if (!settingsWindow || event.sender !== settingsWindow.webContents) return
  void shell.openExternal(
    'x-apple.systempreferences:com.apple.Keyboard-Settings.extension',
  )
})

ipcMain.handle('qwen-audio-agent:native-input-start', event => {
  assertNativeInputDevelopmentSender(event)
  nativeInputFeature.sendOperation({ type: 'session.arm' })
  return true
})

ipcMain.handle('qwen-audio-agent:native-input-stop', event => {
  assertNativeInputDevelopmentSender(event)
  nativeInputFeature.sendOperation({ type: 'session.cancel' })
  return true
})

for (const [channel, type] of [
  ['qwen-audio-agent:native-input-fake-partial', 'session.partial'],
  ['qwen-audio-agent:native-input-fake-final', 'session.final'],
]) {
  ipcMain.handle(channel, (event, value) => {
    assertNativeInputDevelopmentSender(event)
    const text = String(value || '')
    if (!text || text.length > 4_096) {
      throw new Error('Native input test text must be 1–4096 characters')
    }
    nativeInputFeature.sendOperation({ type, text })
    return true
  })
}

ipcMain.on('qwen-audio-agent:open-external', async (event, value) => {
  if (!settingsWindow || event.sender !== settingsWindow.webContents) return
  let target
  try {
    target = new URL(String(value))
  } catch {
    return
  }
  if (target.protocol !== 'https:') return
  const { response } = await dialog.showMessageBox(settingsWindow, {
    type: 'question',
    buttons: [desktopText('打开'), desktopText('取消')],
    defaultId: 0,
    cancelId: 1,
    title: desktopText('打开外部链接'),
    message: desktopText('即将在浏览器中打开：{url}', { url: target.href }),
  })
  if (response === 0) void shell.openExternal(target.href)
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
    skins: [...BUILTIN_ORB_SKINS, ...listSkins(skinsRoot)],
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

ipcMain.handle('qwen-audio-agent:set-node-path', async (event, nodePath) => {
  if (!settingsWindow || event.sender !== settingsWindow.webContents) {
    throw new Error('无权设置 Node.js 路径')
  }
  const trimmed = String(nodePath || '').trim()
  if (!trimmed) throw new Error('路径不能为空')

  if (!existsSync(trimmed)) {
    throw new Error(`目录不存在：${trimmed}`)
  }

  // 写入配置文件
  const current = readFileSync(runtimeEnvironment.configPath, 'utf8')
  const lines = current.split(/\r?\n/)
  const key = 'QWEN_AUDIO_AGENT_NODE_PATH'
  let found = false
  const updated = lines.map(line => {
    if (line.startsWith(`${key}=`)) {
      found = true
      return `${key}=${trimmed}`
    }
    return line
  })
  if (!found) updated.push(`${key}=${trimmed}`)
  const content = updated.join('\n').replace(/\n+$/, '') + '\n'
  writeFileSync(runtimeEnvironment.configPath, content, {
    encoding: 'utf8',
    mode: 0o600,
  })
  // Windows 上 chmodSync 基本是 no-op，但保留兼容性
  try {
    chmodSync(runtimeEnvironment.configPath, 0o600)
  } catch {
    // Windows 上忽略
  }

  // 立即生效：直接操作 PATH，不依赖 spawnSync（打包后可能不可用）
  process.env.QWEN_AUDIO_AGENT_NODE_PATH = trimmed
  process.env.PATH = mergeSearchPath(process.env.PATH, trimmed, {
    platform: process.platform,
    prepend: false,
  })

  // 再跑 expandProcessPath 利用 where/reg 补充其他路径（失败不影响已设置的路径）
  try {
    expandProcessPath()
  } catch {
    logger.warn('node-path.expand-failed', { path: trimmed })
  }

  logger.info('node-path.set', { path: trimmed })
  return { ok: true }
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
  // 滤掉空值：config 文件中 KEY=（无值）会解析出 KEY: ''，
  // 展开时会覆盖 process.env 的同名变量（如 PATH）。
  const filtered = {}
  for (const [key, value] of Object.entries(configured)) {
    if (value !== '') filtered[key] = value
  }
  // Windows 上 npm 设置的是 Path（首字母大写）而非 PATH，
  // { ...process.env } 展开会保留原始键名，导致 result.PATH 为 undefined。
  // 归一化：将 Path 转为 PATH。
  const result = {
    ...process.env,
    ...filtered,
    QWEN_AUDIO_AGENT_DESKTOP_INSTALLED_ONLY: '1',
  }
  if (result.Path && !result.PATH) {
    result.PATH = result.Path
  }
  delete result.Path
  return result
}

// 执行一次完整检测：主进程沿用 Worker 读取到的登录 shell PATH（只赋值，
// 不再执行任何阻塞命令），并为每个后台附加一键安装能力——渲染层无法
// 访问 Node 环境，安装规格只能由主进程查询后随报告一起下发。
function runBackendDetection() {
  return detectBackendSetups({ env: backendDetectionEnvironment() })
    .then(result => {
      if (result.path) {
        // 合并 Worker 检测到的 PATH 到进程环境，只添加新目录，
        // 不替换已有目录（保留 System32 等系统路径）。
        process.env.PATH = mergeSearchPath(
          process.env.PATH,
          result.path,
          { platform: process.platform },
        )
      }
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
      message: desktopText('即将执行官方安装脚本'),
      detail: desktopText(
        '该后台 Agent 没有 npm 安装包，主进程将执行官方安装脚本：\n\n{command}\n\n请确认你信任该脚本来源后再继续。',
        { command: step.command },
      ),
      buttons: [desktopText('执行'), desktopText('取消')],
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

ipcMain.handle('qwen-audio-agent:backend-configure', async (event, payload) => {
  if (!settingsWindow || event.sender !== settingsWindow.webContents) {
    throw new Error('无权启动后台 Agent 配置')
  }
  const id = typeof payload === 'string' ? payload : payload?.backend
  const definition = backendDefinition(id)
  if (!definition) throw new Error(`不支持的后台：${String(id || '')}`)
  const result = await openBackendConfiguration(definition.id, {
    env: backendDetectionEnvironment(),
  })
  logger.info('backend.configuration_opened', {
    backend: definition.id,
    action: result.action?.kind,
  })
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
    const modelOutcome = remoteRealtimeModelOutcome(remoteRuntime, normalized)
    if (modelOutcome) {
      return {
        ...modelOutcome,
        settings: previous,
        restarted: false,
        restartRequired: false,
        runtime: remoteRuntime,
        wakeShortcutRegistered: desktopPresence.shortcutRegistered,
      }
    }
  }
  const gatewayChanged = nextOrigin !== configuredGatewayOrigin
  const apiKeyChanged = previous.dashscopeApiKey !== normalized.dashscopeApiKey
  const realtimeBaseUrlChanged = (
    previous.realtimeBaseUrl !== normalized.realtimeBaseUrl
  )
  const realtimeProviderChanged = (
    previous.realtimeProvider !== normalized.realtimeProvider
  )
  const backendChanged = previous.agentProtocol !== normalized.agentProtocol
  const realtimeModelChanged = previous.realtimeModel !== normalized.realtimeModel
  const realtimeVoiceChanged = (
    previous.audioRealtimeVoice !== normalized.audioRealtimeVoice
    || previous.omniRealtimeVoice !== normalized.omniRealtimeVoice
  )
  const speechToSpeechChanged = (
    previous.speechToSpeechRealtimeUrl
      !== normalized.speechToSpeechRealtimeUrl
    || previous.speechToSpeechAuthToken
      !== normalized.speechToSpeechAuthToken
  )
  const backendModelChanged = previous.backendModel !== normalized.backendModel
  const backendConnectionChanged = (
    previous.backendOwnership !== normalized.backendOwnership
    || previous.backendUrl !== normalized.backendUrl
    || previous.backendCredential !== normalized.backendCredential
  )
  const orbSkinChanged = previous.orbSkin !== normalized.orbSkin
  const autoHideChanged = (
    previous.autoHideSeconds !== normalized.autoHideSeconds
  )
  const wakeShortcutChanged = previous.wakeShortcut !== normalized.wakeShortcut
  const wakeWordChanged = (
    previous.wakeWordEnabled !== normalized.wakeWordEnabled
  )
  const languageChanged = previous.language !== normalized.language
  const gatewayRuntimeChanged = (
    gatewayChanged
    || apiKeyChanged
    || realtimeBaseUrlChanged
    || realtimeProviderChanged
    || backendChanged
    || realtimeModelChanged
    || realtimeVoiceChanged
    || speechToSpeechChanged
    || backendModelChanged
    || backendConnectionChanged
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
  desktopLanguage = normalized.language
  createTray()
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.setTitle(desktopText('设置'))
  }
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
      backendConnection: backendConnectionChanged,
      orbSkin: orbSkinChanged,
      autoHide: autoHideChanged,
      wakeShortcut: wakeShortcutChanged,
      wakeWord: wakeWordChanged,
      language: languageChanged,
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
  // 把刚保存的设置同步进本进程环境：config.env 只填充未设置的槽位，
  // 不写回的话本进程会继续沿用首次加载的旧值（如兼容性检查用的旧 Key）。
  applySettingsEnvironment(settings)
  process.env.QWEN_AUDIO_AGENT_URL = appOrigin
  process.env.QWEN_AUDIO_ORB_STYLE = normalized.orbStyle
  process.env.QWEN_AUDIO_ORB_SKIN = normalized.orbSkin
  await ensureDesktopUi()
  const desktopRendererChanged = (
    (restarted || gatewayChanged || orbSkinChanged || autoHideChanged || languageChanged)
    && mainWindow
    && !mainWindow.isDestroyed()
  )
  if (desktopRendererChanged) {
    // Applying runtime settings is an explicit desktop interaction. A
    // previously auto-hidden orb must rejoin the new Gateway as an active
    // client instead of carrying its wake-word-only sleep state across the
    // restart.
    desktopPresence.wake('settings')
    void loadQwenAudioAgent(mainWindow)
  }
  const runtime = await runtimeStatus(appOrigin)
  return {
    settings: normalized,
    restarted,
    restartRequired: false,
    runtime,
    wakeShortcutRegistered: desktopPresence.shortcutRegistered,
  }
})

ipcMain.handle('qwen-audio-agent:skin-import', async event => {
  if (!settingsWindow || event.sender !== settingsWindow.webContents) {
    throw new Error('无权导入皮肤')
  }
  const selection = await dialog.showOpenDialog(settingsWindow, {
    title: desktopText('导入皮肤'),
    // macOS 支持同时选文件与文件夹；其余平台选 zip 或皮肤包里的 pet.json。
    properties: process.platform === 'darwin'
      ? ['openFile', 'openDirectory']
      : ['openFile'],
    filters: [{ name: desktopText('皮肤包'), extensions: ['zip', 'json'] }],
  })
  if (selection.canceled || !selection.filePaths.length) return null
  const imported = await importSkin({
    source: selection.filePaths[0],
    skinsRoot,
  })
  logger.info('skin.imported', { id: imported.id })
  return imported
})

ipcMain.handle('qwen-audio-agent:skin-remove', async (event, id) => {
  if (!settingsWindow || event.sender !== settingsWindow.webContents) {
    throw new Error('无权删除皮肤')
  }
  const removed = removeSkin({ id, skinsRoot })
  if (removed) logger.info('skin.removed', { id: String(id) })
  return { removed }
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
    const refreshDesktopTaskSurface = () => {
      updateDesktopTaskSurface(desktopTaskCount)
    }
    screen.on('display-added', refreshDesktopTaskSurface)
    screen.on('display-removed', refreshDesktopTaskSurface)
    screen.on('display-metrics-changed', refreshDesktopTaskSurface)
    if (!desktopPresence.registerShortcut(initialSettings.wakeShortcut)) {
      logger.warn('desktop.wake_shortcut_unavailable', {
        accelerator: initialSettings.wakeShortcut,
      })
    }
    try {
      await nativeInputFeature.initialize()
      nativeInputFeature.applyLifecycleStatus(
        await nativeInputLifecycle.status(),
      )
    } catch (error) {
      lastRuntimeError = error?.message || String(error)
      logger.error('native_input.start_failed', { error })
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
      await nativeInputFeature.shutdown()
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
