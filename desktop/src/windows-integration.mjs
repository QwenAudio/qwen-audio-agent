import { redactDesktopHostValue } from '../../shared/desktop-host-protocol.mjs'
import {
  getWindowsSupportUrl,
  WINDOWS_MICROPHONE_SETTINGS_URL,
} from './security.mjs'
import { createTrayMenuTemplate } from './tray-menu.mjs'
import { validateWindowsPreferences } from './windows-preferences.mjs'

const CONFIRMATION_ID = /^[a-f0-9]{32}$/
const STATUS_KEYS = new Set([
  'state',
  'reason',
  'canRepair',
  'progress',
  'retry',
  'delayMs',
  'syncAvailable',
  'missing',
])

export const WINDOWS_IPC_CHANNELS = Object.freeze({
  getDesktopContext: 'qwen-audio-agent:windows-get-desktop-context',
  getRuntimeStatus: 'qwen-audio-agent:windows-get-runtime-status',
  getRuntimeInstallPlan: 'qwen-audio-agent:windows-get-runtime-install-plan',
  retryRuntime: 'qwen-audio-agent:windows-retry-runtime',
  confirmRuntimeInstall: 'qwen-audio-agent:windows-confirm-runtime-install',
  openWindowsOrb: 'qwen-audio-agent:windows-open-orb',
  getPrivateRuntimeRemovalPlan: 'qwen-audio-agent:windows-get-private-runtime-removal-plan',
  confirmPrivateRuntimeRemoval: 'qwen-audio-agent:windows-confirm-private-runtime-removal',
  setRuntimeMode: 'qwen-audio-agent:windows-set-runtime-mode',
  setWslDistribution: 'qwen-audio-agent:windows-set-wsl-distribution',
  setExternalGatewayOrigin: 'qwen-audio-agent:windows-set-external-gateway-origin',
  setOpenAtLogin: 'qwen-audio-agent:windows-set-open-at-login',
  restartRuntime: 'qwen-audio-agent:windows-restart-runtime',
  copyRuntimeDiagnostics: 'qwen-audio-agent:windows-copy-runtime-diagnostics',
  openWindowsMicrophoneSettings: 'qwen-audio-agent:windows-open-microphone-settings',
  openWindowsSupportLink: 'qwen-audio-agent:windows-open-support-link',
  openWindowsRuntimeManager: 'qwen-audio-agent:windows-open-runtime-manager',
  runtimeStatus: 'qwen-audio-agent:runtime-status',
})

export function parseWindowsStartupArguments(argv = process.argv) {
  return { startup: argv.some(value => value === '--startup') }
}

function distributionNames(runtime) {
  const values = runtime?.context?.distributions || []
  return values.map(value => (
    typeof value === 'string' ? value : value?.name
  )).filter(value => typeof value === 'string' && value.length > 0)
}

export function createPublicDesktopContext({ runtime, preferences } = {}) {
  return {
    platform: 'win32',
    runtimeMode: preferences?.mode || 'managed',
    distribution: runtime?.context?.distribution
      || preferences?.distribution
      || '',
    distributions: distributionNames(runtime),
    openAtLogin: preferences?.openAtLogin === true,
  }
}

function publicRuntimeStatus(status, runtime) {
  const source = status?.state === 'stopping'
    ? { ...status, state: 'starting' }
    : status
  const result = {}
  for (const [key, value] of Object.entries(source || {})) {
    if (STATUS_KEYS.has(key) && value !== undefined) result[key] = value
  }
  const distribution = runtime?.context?.distribution
  if (distribution) result.distribution = distribution
  result.environment = publicRuntimeEnvironment(runtime)
  return result
}

function boundedText(value, maximum = 256) {
  const text = typeof value === 'string' ? value : ''
  return text.length <= maximum && !/[\u0000-\u001f\u007f]/.test(text)
    ? text
    : ''
}

function publicRuntimeEnvironment(runtime) {
  const rootContext = runtime?.context || {}
  const context = rootContext.mode === 'external'
    ? rootContext.managed || {}
    : rootContext
  const distribution = boundedText(context.distribution)
  const details = (context.distributions || []).find(item => (
    (typeof item === 'string' ? item : item?.name) === distribution
  ))
  const marker = context.inspect?.marker || context.inspect?.currentMarker || {}
  return {
    distribution,
    wslVersion: [1, 2].includes(details?.version) ? details.version : null,
    architecture: boundedText(context.probe?.architecture, 64),
    nodeVersion: boundedText(context.probe?.nodeVersion, 64),
    npmVersion: boundedText(context.probe?.npmVersion, 64),
    runtimeVersion: boundedText(marker.packageVersion, 64),
    protocolVersion: Number.isSafeInteger(marker.protocolVersion)
      ? marker.protocolVersion
      : Number.isSafeInteger(context.protocolVersion)
        ? context.protocolVersion
        : null,
  }
}

function publicRuntimeHealth(health) {
  const backend = health?.backend
  return {
    gatewayConnected: health?.gatewayConnected === true,
    voiceConfigured: health?.voiceConfigured === true,
    realtimeProvider: boundedText(health?.realtimeProvider, 128) || null,
    realtimeLabel: boundedText(health?.realtimeLabel, 128) || null,
    realtimeModel: boundedText(health?.realtimeModel, 256) || null,
    backend: backend ? {
      protocol: boundedText(backend.protocol, 128) || null,
      label: boundedText(backend.label, 128) || null,
      model: boundedText(backend.model, 256) || null,
      connected: backend.connected === true,
    } : null,
  }
}

function validWindow(window) {
  return Boolean(window) && !window.isDestroyed?.()
}

function safeAsync(operation, onError) {
  void Promise.resolve().then(operation).catch(onError)
}

export class WindowsDesktopIntegration {
  constructor({
    app,
    runtime,
    preferencesStore,
    Tray,
    Menu,
    trayIcon,
    windows,
    updater = null,
    readOpenAtLogin,
    applyOpenAtLogin,
    getMicrophoneAccess = () => 'unknown',
    beforeQuit = async () => {},
    onError = error => console.error('Windows desktop integration error:', error),
  } = {}) {
    if (!app || !runtime || !preferencesStore || !Tray || !Menu) {
      throw new TypeError('Windows desktop integration dependencies are required')
    }
    this.app = app
    this.runtime = runtime
    this.preferencesStore = preferencesStore
    this.Tray = Tray
    this.Menu = Menu
    this.trayIcon = trayIcon
    this.windows = windows
    this.updater = updater
    this.readOpenAtLogin = readOpenAtLogin
    this.applyOpenAtLogin = applyOpenAtLogin
    this.getMicrophoneAccess = getMicrophoneAccess
    this.beforeQuit = beforeQuit
    this.onError = onError
    this.preferences = null
    this.runtimeStatus = runtime.status
    this.tray = null
    this.attachedWindows = new Map()
    this.unsubscribeRuntimeStatus = null
    this.exiting = false
    this.shutdownPromise = null
    this.presentationStarted = false
    this.showOrbWhenSetupCompletes = false
    this.readySurfacePromise = null
  }

  async initialize() {
    this.preferences = await this.preferencesStore.read()
    const actualOpenAtLogin = this.readOpenAtLogin(this.app)
    if (actualOpenAtLogin !== this.preferences.openAtLogin) {
      this.preferences = await this.preferencesStore.write({
        openAtLogin: actualOpenAtLogin,
      })
    }
    this.runtimeStatus = this.runtime.status
    this.tray = new this.Tray(this.trayIcon)
    this.tray.setToolTip('Qwen Audio Agent')
    this.unsubscribeRuntimeStatus = this.runtime.subscribeStatus(status => {
      if (this.exiting) return
      const previousState = this.runtimeStatus?.state
      this.runtimeStatus = status
      this.broadcastRuntimeStatus()
      this.rebuildTray()
      if (this.presentationStarted) {
        if (status.state === 'setup-required') {
          this.showOrbWhenSetupCompletes = true
          safeAsync(() => this.windows.show('repair'), this.onError)
        } else if (
          ['ready', 'external'].includes(status.state)
          && (
            this.showOrbWhenSetupCompletes
            || ['setup-required', 'error'].includes(previousState)
          )
        ) {
          const showOrb = this.preferences.orbVisible
          if (showOrb) {
            safeAsync(() => this.presentReadySurface(), this.onError)
          }
        }
      }
    })
    this.rebuildTray()
    return this.preferences
  }

  attachWindow(kind, window) {
    if (!['orb', 'settings', 'repair'].includes(kind) || !window?.on) {
      throw new TypeError('A supported Windows desktop window is required')
    }
    if (this.attachedWindows.get(kind) === window) return
    this.attachedWindows.set(kind, window)
    window.on('close', event => {
      if (this.exiting) return
      event.preventDefault()
      const bounds = window.getBounds?.()
      if (bounds) {
        safeAsync(() => this.updatePreferences({
          windowBounds: { [kind]: bounds },
        }), this.onError)
      }
      window.hide()
    })
  }

  ownsWebContents(sender) {
    for (const kind of ['orb', 'settings', 'repair']) {
      const window = this.windows?.get?.(kind) || this.attachedWindows.get(kind)
      if (validWindow(window) && window.webContents === sender) return true
    }
    return false
  }

  handleWindowAllClosed() {
    return true
  }

  async presentReadySurface({ ensureVisible = false } = {}) {
    if (!['ready', 'external'].includes(this.runtimeStatus?.state)) {
      throw new Error('Windows runtime is not ready')
    }
    if (this.readySurfacePromise) return this.readySurfacePromise
    this.readySurfacePromise = (async () => {
      if (ensureVisible && !this.preferences.orbVisible) {
        await this.updatePreferences({ orbVisible: true })
      }
      if (!this.preferences.orbVisible) return this.runtimeStatus
      await this.windows.show('orb')
      const repair = this.windows.get('repair')
      if (validWindow(repair)) repair.hide()
      this.showOrbWhenSetupCompletes = false
      return this.runtimeStatus
    })()
    try {
      return await this.readySurfacePromise
    } finally {
      this.readySurfacePromise = null
    }
  }

  async handleSecondInstance() {
    if (this.runtimeStatus?.state === 'setup-required') {
      await this.windows.show('repair')
      return
    }
    if (!this.preferences.orbVisible) {
      await this.updatePreferences({ orbVisible: true })
    }
    await this.windows.show('orb')
  }

  async presentInitialState() {
    this.presentationStarted = true
    for (const kind of ['orb', 'settings', 'repair']) {
      const window = this.windows.get(kind)
      if (validWindow(window)) window.hide()
    }
    if (['setup-required', 'error'].includes(this.runtimeStatus?.state)) {
      this.showOrbWhenSetupCompletes = true
      await this.windows.show('repair')
      return
    }
    if (this.preferences.orbVisible) await this.windows.show('orb')
  }

  getDesktopContext() {
    return createPublicDesktopContext({
      runtime: this.runtime,
      preferences: this.preferences,
    })
  }

  getRuntimeStatus() {
    const status = publicRuntimeStatus(this.runtimeStatus, this.runtime)
    status.environment.externalGatewayOrigin =
      this.preferences?.externalGatewayOrigin || ''
    const microphoneAccess = this.getMicrophoneAccess()
    status.microphoneAccess = [
      'not-determined',
      'granted',
      'denied',
      'restricted',
      'unknown',
    ].includes(microphoneAccess) ? microphoneAccess : 'unknown'
    return status
  }

  async readRuntimeStatus() {
    const status = this.getRuntimeStatus()
    let health = null
    if (['ready', 'recovering', 'external'].includes(status.state)) {
      health = await this.runtime.getRuntimeStatus().catch(() => null)
    }
    return {
      ...status,
      health: publicRuntimeHealth(health),
    }
  }

  openRuntimeManager() {
    return this.windows.show('repair')
  }

  broadcastRuntimeStatus() {
    const status = this.getRuntimeStatus()
    const seen = new Set()
    for (const kind of ['orb', 'settings', 'repair']) {
      const window = this.windows?.get?.(kind) || this.attachedWindows.get(kind)
      if (!validWindow(window) || seen.has(window.webContents)) continue
      seen.add(window.webContents)
      window.webContents.send(WINDOWS_IPC_CHANNELS.runtimeStatus, status)
    }
  }

  refreshUpdaterStatus() {
    if (!this.exiting) this.rebuildTray()
  }

  async updatePreferences(update) {
    this.preferences = await this.preferencesStore.write(update)
    this.rebuildTray()
    return this.preferences
  }

  async setRuntimePreference(update) {
    await this.updatePreferences(update)
    return this.runtime.retry()
  }

  async setOpenAtLogin(enabled) {
    const actual = this.applyOpenAtLogin(this.app, enabled)
    await this.updatePreferences({ openAtLogin: actual })
    return actual
  }

  async toggleOrb() {
    const window = this.windows.get('orb')
    const visible = !this.preferences.orbVisible
    if (visible) await this.windows.show('orb')
    else if (validWindow(window)) window.hide()
    await this.updatePreferences({ orbVisible: visible })
  }

  rebuildTray() {
    if (!this.tray || this.exiting || !this.preferences) return
    const run = operation => () => safeAsync(operation, this.onError)
    const template = createTrayMenuTemplate({
      runtimeStatus: publicRuntimeStatus(this.runtimeStatus, this.runtime),
      preferences: this.preferences,
      updaterStatus: this.updater?.state?.() || null,
      actions: {
        toggleOrb: run(() => this.toggleOrb()),
        openSettings: run(() => this.windows.show('settings')),
        manageRuntime: run(() => this.windows.show('repair')),
        restartRuntime: run(() => this.runtime.restartRuntime()),
        setOpenAtLogin: enabled => safeAsync(
          () => this.setOpenAtLogin(enabled),
          this.onError,
        ),
        checkForUpdates: run(() => this.updater?.check?.()),
        quit: run(() => this.quit()),
      },
    })
    this.tray.setContextMenu(this.Menu.buildFromTemplate(template))
  }

  async shutdown() {
    if (this.shutdownPromise) return this.shutdownPromise
    this.exiting = true
    this.unsubscribeRuntimeStatus?.()
    this.unsubscribeRuntimeStatus = null
    this.shutdownPromise = (async () => {
      await this.runtime.stop()
      await this.beforeQuit()
      this.tray?.destroy()
      this.tray = null
    })()
    return this.shutdownPromise
  }

  async quit() {
    await this.shutdown()
    this.app.quit()
  }

  async installUpdate(install) {
    if (typeof install !== 'function') throw new TypeError('install is required')
    await this.shutdown()
    install()
  }
}

function noArguments(args) {
  if (args.length) throw new TypeError('This desktop command accepts no arguments')
  return []
}

function oneString(args, label) {
  if (args.length !== 1 || typeof args[0] !== 'string') {
    throw new TypeError(`${label} must be a string`)
  }
  return args[0]
}

function confirmationId(args) {
  const value = oneString(args, 'Confirmation ID')
  if (!CONFIRMATION_ID.test(value)) throw new Error('Invalid confirmation ID')
  return [value]
}

function oneBoolean(args, label) {
  if (args.length !== 1 || typeof args[0] !== 'boolean') {
    throw new TypeError(`${label} must be a boolean`)
  }
  return [args[0]]
}

export function registerWindowsIntegrationIpc({
  ipcMain,
  integration,
  runtime,
  clipboard,
  shell,
  isAuthorizedSender = sender => integration.ownsWebContents(sender),
} = {}) {
  if (!ipcMain?.handle || !integration || !runtime || !clipboard || !shell) {
    throw new TypeError('Windows IPC dependencies are required')
  }
  const register = (channel, validate, operation) => {
    ipcMain.handle(channel, async (event, ...args) => {
      if (!isAuthorizedSender(event?.sender)) {
        throw new Error('Unauthorized Windows desktop IPC sender')
      }
      const values = validate(args)
      return operation(...values)
    })
  }
  register(WINDOWS_IPC_CHANNELS.getDesktopContext, noArguments, async () => (
    integration.getDesktopContext()
  ))
  register(WINDOWS_IPC_CHANNELS.getRuntimeStatus, noArguments, async () => (
    integration.readRuntimeStatus()
  ))
  register(WINDOWS_IPC_CHANNELS.getRuntimeInstallPlan, noArguments, () => (
    runtime.getRuntimeInstallPlan()
  ))
  register(WINDOWS_IPC_CHANNELS.retryRuntime, noArguments, () => runtime.retry())
  register(
    WINDOWS_IPC_CHANNELS.confirmRuntimeInstall,
    confirmationId,
    async value => {
      await runtime.installRuntime(value)
      try {
        await integration.presentReadySurface({ ensureVisible: true })
        return { orbPresented: true }
      } catch {
        return { orbPresented: false }
      }
    },
  )
  register(WINDOWS_IPC_CHANNELS.openWindowsOrb, noArguments, () => (
    integration.presentReadySurface({ ensureVisible: true })
  ))
  register(WINDOWS_IPC_CHANNELS.getPrivateRuntimeRemovalPlan, noArguments, () => (
    runtime.getPrivateRuntimeRemovalPlan()
  ))
  register(
    WINDOWS_IPC_CHANNELS.confirmPrivateRuntimeRemoval,
    confirmationId,
    value => runtime.removePrivateRuntime(value),
  )
  register(WINDOWS_IPC_CHANNELS.setRuntimeMode, args => {
    const value = oneString(args, 'Runtime mode')
    if (!['managed', 'external'].includes(value)) {
      throw new Error('Invalid Windows runtime mode')
    }
    return [value]
  }, value => integration.setRuntimePreference({ mode: value }))
  register(WINDOWS_IPC_CHANNELS.setWslDistribution, args => {
    const value = oneString(args, 'WSL distribution')
    const available = integration.getDesktopContext().distributions
    if (value && !available.includes(value)) {
      throw new Error('Invalid WSL distribution')
    }
    return [value]
  }, value => integration.setRuntimePreference({ distribution: value }))
  register(WINDOWS_IPC_CHANNELS.setExternalGatewayOrigin, args => {
    const value = oneString(args, 'External Gateway origin')
    const validated = validateWindowsPreferences({
      ...integration.preferences,
      externalGatewayOrigin: value,
    })
    return [validated.externalGatewayOrigin]
  }, value => integration.preferences.mode === 'external'
    ? integration.setRuntimePreference({ externalGatewayOrigin: value })
    : integration.updatePreferences({ externalGatewayOrigin: value }))
  register(
    WINDOWS_IPC_CHANNELS.setOpenAtLogin,
    args => oneBoolean(args, 'Start with Windows'),
    value => integration.setOpenAtLogin(value),
  )
  register(WINDOWS_IPC_CHANNELS.restartRuntime, noArguments, () => (
    runtime.restartRuntime()
  ))
  register(WINDOWS_IPC_CHANNELS.copyRuntimeDiagnostics, noArguments, async () => {
    const raw = await runtime.tailDiagnostics({ limit: 200 })
    const lines = (Array.isArray(raw) ? raw : [])
      .slice(-200)
      .map(line => String(redactDesktopHostValue(String(line))).slice(0, 4096))
    clipboard.writeText(lines.join('\n'))
    return { lineCount: lines.length }
  })
  register(
    WINDOWS_IPC_CHANNELS.openWindowsMicrophoneSettings,
    noArguments,
    async () => {
      await shell.openExternal(WINDOWS_MICROPHONE_SETTINGS_URL)
      return null
    },
  )
  register(WINDOWS_IPC_CHANNELS.openWindowsSupportLink, args => {
    const id = oneString(args, 'Support link ID')
    const target = getWindowsSupportUrl(id)
    if (!target) throw new Error('Invalid Windows support link ID')
    return [target]
  }, async target => {
    await shell.openExternal(target)
    return null
  })
  register(
    WINDOWS_IPC_CHANNELS.openWindowsRuntimeManager,
    noArguments,
    () => integration.openRuntimeManager(),
  )
}
