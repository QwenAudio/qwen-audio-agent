import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import {
  createPublicDesktopContext,
  parseWindowsStartupArguments,
  registerWindowsIntegrationIpc,
  WINDOWS_IPC_CHANNELS,
  WindowsDesktopIntegration,
} from '../src/windows-integration.mjs'

function fakeWindow(kind) {
  const listeners = new Map()
  const calls = []
  const webContents = {
    kind,
    send: (...args) => calls.push(['send', ...args]),
  }
  return {
    calls,
    webContents,
    on(name, listener) {
      listeners.set(name, listener)
    },
    emit(name, ...args) {
      return listeners.get(name)?.(...args)
    },
    getBounds: () => ({ x: 10, y: 20, width: kind === 'orb' ? 172 : 540, height: kind === 'orb' ? 170 : 860 }),
    hide: () => calls.push(['hide']),
    show: () => calls.push(['show']),
    focus: () => calls.push(['focus']),
    isDestroyed: () => false,
    isMinimized: () => false,
  }
}

function harness({
  state = 'ready',
  preferences: initialPreferences,
  showWindow,
} = {}) {
  const calls = []
  const writes = []
  const windows = {
    orb: fakeWindow('orb'),
    settings: fakeWindow('settings'),
    repair: fakeWindow('repair'),
  }
  let statusListener = null
  const runtime = {
    status: { state, reason: null },
    context: {
      distribution: 'Ubuntu',
      distributions: [
        { name: 'Ubuntu', version: 2, state: 'Running', isDefault: true },
      ],
      layout: { privateRoot: '/home/test/.private' },
      probe: { home: '/home/test', nodeVersion: 'v22.22.2' },
      inspect: {
        marker: { packageVersion: '1.2.0', protocolVersion: 1 },
      },
      protocolVersion: 1,
    },
    subscribeStatus(listener) {
      statusListener = listener
      return () => calls.push(['unsubscribe'])
    },
    async stop() {
      calls.push(['runtime.stop'])
    },
    async retry() {
      calls.push(['runtime.retry'])
      return runtime.status
    },
    async restartRuntime() {
      calls.push(['runtime.restart'])
      return runtime.status
    },
    async getRuntimeStatus() {
      return {
        gatewayConnected: true,
        voiceConfigured: true,
        backend: {
          label: 'Codex',
          connected: true,
          baseUrl: 'http://127.0.0.1:65530',
          error: 'token=super-secret',
        },
      }
    },
  }
  const preferences = {
    mode: 'managed',
    distribution: '',
    externalGatewayOrigin: '',
    openAtLogin: false,
    orbVisible: true,
    windowBounds: { orb: null, settings: null, repair: null },
    ...initialPreferences,
  }
  const preferencesStore = {
    async read() {
      return structuredClone(preferences)
    },
    async write(update) {
      writes.push(structuredClone(update))
      Object.assign(preferences, update)
      if (update.windowBounds) {
        preferences.windowBounds = {
          ...preferences.windowBounds,
          ...update.windowBounds,
        }
      }
      return structuredClone(preferences)
    },
  }
  class Tray {
    constructor(icon) {
      calls.push(['tray.create', icon])
      this.destroyed = false
    }
    setToolTip(value) {
      calls.push(['tray.tooltip', value])
    }
    setContextMenu(value) {
      calls.push(['tray.menu', value])
    }
    destroy() {
      this.destroyed = true
      calls.push(['tray.destroy'])
    }
  }
  const Menu = {
    buildFromTemplate(template) {
      calls.push(['menu.build', template])
      return template
    },
  }
  const app = {
    quit() {
      calls.push(['app.quit'])
    },
  }
  const integration = new WindowsDesktopIntegration({
    app,
    runtime,
    preferencesStore,
    Tray,
    Menu,
    trayIcon: 'C:\\Program Files\\Qwen Audio Agent\\resources\\icon.ico',
    readOpenAtLogin: () => false,
    applyOpenAtLogin: (_app, enabled) => enabled,
    getMicrophoneAccess: () => 'granted',
    windows: {
      get: kind => windows[kind],
      show: kind => {
        if (showWindow) return showWindow(kind, { calls, windows })
        calls.push(['window.show', kind])
        windows[kind].show()
        windows[kind].focus()
      },
    },
    updater: {
      state: () => ({ phase: 'idle' }),
      check: async () => calls.push(['updater.check']),
    },
    beforeQuit: async () => calls.push(['beforeQuit']),
  })
  return {
    app,
    calls,
    emitStatus(value) {
      runtime.status = value
      statusListener(value)
    },
    integration,
    preferences,
    preferencesStore,
    runtime,
    windows,
    writes,
  }
}

test('parses only the exact Windows startup switch', () => {
  assert.deepEqual(parseWindowsStartupArguments(['app.exe', '--startup']), {
    startup: true,
  })
  assert.deepEqual(parseWindowsStartupArguments([
    'app.exe',
    '--startup=true',
    '--arbitrary',
  ]), { startup: false })
})

test('returns a strict public context without WSL paths or probe details', () => {
  const target = harness()
  assert.deepEqual(createPublicDesktopContext({
    runtime: target.runtime,
    preferences: target.preferences,
  }), {
    platform: 'win32',
    runtimeMode: 'managed',
    distribution: 'Ubuntu',
    distributions: ['Ubuntu'],
    openAtLogin: false,
  })
})

test('creates and rebuilds the durable tray while broadcasting runtime state', async () => {
  const target = harness()
  await target.integration.initialize()
  assert.deepEqual(target.calls.slice(0, 3).map(call => call[0]), [
    'tray.create',
    'tray.tooltip',
    'menu.build',
  ])
  target.emitStatus({ state: 'recovering', reason: 'bridge-exited', retry: 2 })
  assert.equal(
    target.calls.some(call => call[0] === 'menu.build' && call[1][0].label.includes('2/3')),
    true,
  )
  assert.equal(
    target.windows.orb.calls.some(call => call[0] === 'send' && call[1] === 'qwen-audio-agent:runtime-status'),
    true,
  )
})

test('keeps internal stopping transitions within the public tray state model', async () => {
  const target = harness()
  await target.integration.initialize()
  assert.doesNotThrow(() => target.emitStatus({ state: 'stopping' }))
  assert.equal(target.integration.getRuntimeStatus().state, 'starting')
})

test('returns safe environment and health details without private paths or errors', async () => {
  const target = harness()
  await target.integration.initialize()
  const status = await target.integration.readRuntimeStatus()
  assert.deepEqual(status.environment, {
    distribution: 'Ubuntu',
    wslVersion: 2,
    architecture: '',
    nodeVersion: 'v22.22.2',
    npmVersion: '',
    runtimeVersion: '1.2.0',
    protocolVersion: 1,
    externalGatewayOrigin: '',
  })
  assert.deepEqual(status.health, {
    gatewayConnected: true,
    voiceConfigured: true,
    realtimeProvider: null,
    realtimeLabel: null,
    realtimeModel: null,
    backend: {
      protocol: null,
      label: 'Codex',
      model: null,
      connected: true,
    },
  })
  assert.equal(status.microphoneAccess, 'granted')
  assert.doesNotMatch(JSON.stringify(status), /privateRoot|home\/test|baseUrl|super-secret/)
})

test('hides every Windows surface on close and persists its bounds', async () => {
  const target = harness()
  await target.integration.initialize()
  for (const kind of ['orb', 'settings', 'repair']) {
    const window = target.windows[kind]
    target.integration.attachWindow(kind, window)
    let prevented = false
    window.emit('close', { preventDefault: () => { prevented = true } })
    assert.equal(prevented, true)
    assert.deepEqual(window.calls.at(-1), ['hide'])
  }
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(
    target.writes.slice(-3).map(value => Object.keys(value.windowBounds)[0]),
    ['orb', 'settings', 'repair'],
  )
  target.integration.handleWindowAllClosed()
  assert.equal(target.calls.some(call => call[0] === 'app.quit'), false)
})

test('second-instance activation chooses repair during setup and orb when ready', async () => {
  const target = harness({ state: 'setup-required' })
  await target.integration.initialize()
  await target.integration.handleSecondInstance()
  assert.equal(target.calls.some(call => call[0] === 'window.show' && call[1] === 'repair'), true)
  target.emitStatus({ state: 'ready', reason: null })
  await target.integration.handleSecondInstance()
  assert.equal(target.calls.some(call => call[0] === 'window.show' && call[1] === 'orb'), true)
})

test('initial presentation hides normal surfaces and honors orb visibility', async () => {
  const hidden = harness({ preferences: { orbVisible: false } })
  await hidden.integration.initialize()
  await hidden.integration.presentInitialState({ startup: true })
  assert.deepEqual(hidden.windows.orb.calls.at(-1), ['hide'])
  assert.deepEqual(hidden.windows.settings.calls.at(-1), ['hide'])
  assert.deepEqual(hidden.windows.repair.calls.at(-1), ['hide'])
  assert.equal(hidden.calls.some(call => call[0] === 'window.show'), false)

  const setup = harness({ state: 'setup-required' })
  await setup.integration.initialize()
  await setup.integration.presentInitialState({ startup: true })
  assert.equal(setup.calls.at(-1)[0], 'window.show')
  assert.equal(setup.calls.at(-1)[1], 'repair')
})

test('waits for the orb before hiding repair and serializes duplicate ready states', async () => {
  let resolveOrb
  const orbReady = new Promise(resolve => { resolveOrb = resolve })
  const target = harness({
    state: 'setup-required',
    showWindow: async (kind, { calls, windows }) => {
      calls.push(['window.show', kind])
      if (kind === 'orb') await orbReady
      windows[kind].show()
      windows[kind].focus()
    },
  })
  await target.integration.initialize()
  await target.integration.presentInitialState({ startup: false })
  const initialRepairHides = target.windows.repair.calls
    .filter(call => call[0] === 'hide').length
  target.emitStatus({ state: 'starting', reason: null })
  target.emitStatus({ state: 'ready', reason: null })
  target.emitStatus({ state: 'ready', reason: null })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(
    target.calls.filter(call => (
      call[0] === 'window.show' && call[1] === 'orb'
    )).length,
    1,
  )
  assert.equal(
    target.windows.repair.calls.filter(call => call[0] === 'hide').length,
    initialRepairHides,
  )
  resolveOrb()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(
    target.windows.repair.calls.filter(call => call[0] === 'hide').length,
    initialRepairHides + 1,
  )
})

test('keeps a failed ready presentation visible and retryable', async () => {
  let orbAttempts = 0
  const errors = []
  const target = harness({
    state: 'setup-required',
    showWindow: async (kind, { calls, windows }) => {
      calls.push(['window.show', kind])
      if (kind === 'orb' && orbAttempts++ === 0) {
        throw new Error('renderer failed')
      }
      windows[kind].show()
      windows[kind].focus()
    },
  })
  target.integration.onError = error => errors.push(error)
  await target.integration.initialize()
  await target.integration.presentInitialState({ startup: false })
  const initialRepairHides = target.windows.repair.calls
    .filter(call => call[0] === 'hide').length
  target.emitStatus({ state: 'ready', reason: null })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(errors.length, 1)
  assert.equal(
    target.windows.repair.calls.filter(call => call[0] === 'hide').length,
    initialRepairHides,
  )

  await target.integration.presentReadySurface({ ensureVisible: true })

  assert.equal(orbAttempts, 2)
  assert.equal(
    target.windows.repair.calls.filter(call => call[0] === 'hide').length,
    initialRepairHides + 1,
  )
})

test('explicit quit and update installation await runtime shutdown first', async () => {
  const quitTarget = harness()
  await quitTarget.integration.initialize()
  await quitTarget.integration.quit()
  assert.deepEqual(
    quitTarget.calls.filter(call => [
      'runtime.stop', 'beforeQuit', 'tray.destroy', 'app.quit',
    ].includes(call[0])),
    [
      ['runtime.stop'],
      ['beforeQuit'],
      ['tray.destroy'],
      ['app.quit'],
    ],
  )

  const updateTarget = harness()
  await updateTarget.integration.initialize()
  await updateTarget.integration.installUpdate(() => {
    updateTarget.calls.push(['updater.install'])
  })
  assert.deepEqual(
    updateTarget.calls.filter(call => [
      'runtime.stop', 'beforeQuit', 'tray.destroy', 'updater.install',
    ].includes(call[0])),
    [
      ['runtime.stop'],
      ['beforeQuit'],
      ['tray.destroy'],
      ['updater.install'],
    ],
  )
})

function fakeIpcMain() {
  const handlers = new Map()
  return {
    handlers,
    handle(channel, handler) {
      handlers.set(channel, handler)
    },
    invoke(channel, event, ...args) {
      return handlers.get(channel)(event, ...args)
    },
  }
}

test('registers validated Windows IPC without exposing arbitrary commands or URLs', async () => {
  const target = harness()
  await target.integration.initialize()
  const ipcMain = fakeIpcMain()
  const clipboardWrites = []
  const externalTargets = []
  const runtimeCalls = []
  const handoffCalls = []
  target.integration.presentReadySurface = async options => {
    handoffCalls.push(['present', options])
  }
  Object.assign(target.runtime, {
    getRuntimeInstallPlan: async () => ({ confirmationId: 'a'.repeat(32), displayCommand: 'npm install payload.tgz' }),
    installRuntime: async value => {
      runtimeCalls.push(['install', value])
      handoffCalls.push('install')
      return { state: 'ready' }
    },
    getPrivateRuntimeRemovalPlan: async () => ({ confirmationId: 'b'.repeat(32), root: '/home/test/.private' }),
    removePrivateRuntime: async value => runtimeCalls.push(['remove', value]),
    tailDiagnostics: () => ['token=super-secret', 'bridge ready'],
  })
  const authorizedSender = target.windows.settings.webContents
  registerWindowsIntegrationIpc({
    ipcMain,
    integration: target.integration,
    runtime: target.runtime,
    clipboard: { writeText: value => clipboardWrites.push(value) },
    shell: { openExternal: async value => externalTargets.push(value) },
    isAuthorizedSender: sender => sender === authorizedSender,
  })
  assert.deepEqual(
    [...ipcMain.handlers.keys()].sort(),
    Object.entries(WINDOWS_IPC_CHANNELS)
      .filter(([name]) => name !== 'runtimeStatus')
      .map(([, channel]) => channel)
      .sort(),
  )
  const event = { sender: authorizedSender }
  await assert.rejects(
    ipcMain.invoke('qwen-audio-agent:windows-confirm-runtime-install', event, '../bad'),
    /confirmation/i,
  )
  await assert.rejects(
    ipcMain.invoke('qwen-audio-agent:windows-set-wsl-distribution', event, 'Missing'),
    /distribution/i,
  )
  await assert.rejects(
    ipcMain.invoke('qwen-audio-agent:windows-set-external-gateway-origin', event, 'http://192.168.1.2:3101'),
    /loopback/i,
  )
  await assert.rejects(
    ipcMain.invoke('qwen-audio-agent:windows-get-desktop-context', { sender: {} }),
    /unauthorized/i,
  )

  const installResult = await ipcMain.invoke(
    'qwen-audio-agent:windows-confirm-runtime-install',
    event,
    'a'.repeat(32),
  )
  assert.deepEqual(installResult, { orbPresented: true })
  await ipcMain.invoke(WINDOWS_IPC_CHANNELS.openWindowsOrb, event)
  await ipcMain.invoke('qwen-audio-agent:windows-set-runtime-mode', event, 'external')
  await ipcMain.invoke('qwen-audio-agent:windows-set-wsl-distribution', event, 'Ubuntu')
  await ipcMain.invoke(
    'qwen-audio-agent:windows-set-external-gateway-origin',
    event,
    'http://localhost:3101',
  )
  const copied = await ipcMain.invoke(
    'qwen-audio-agent:windows-copy-runtime-diagnostics',
    event,
  )
  await ipcMain.invoke(
    'qwen-audio-agent:windows-open-microphone-settings',
    event,
  )
  await ipcMain.invoke(
    'qwen-audio-agent:windows-open-support-link',
    event,
    'wsl-install',
  )
  await assert.rejects(
    ipcMain.invoke(
      'qwen-audio-agent:windows-open-support-link',
      event,
      'https://attacker.example',
    ),
    /support link/i,
  )

  assert.deepEqual(runtimeCalls, [['install', 'a'.repeat(32)]])
  assert.deepEqual(handoffCalls, [
    'install',
    ['present', { ensureVisible: true }],
    ['present', { ensureVisible: true }],
  ])
  assert.equal(target.calls.filter(call => call[0] === 'runtime.retry').length, 3)
  assert.equal(copied.lineCount, 2)
  assert.doesNotMatch(clipboardWrites[0], /super-secret/)
  assert.deepEqual(externalTargets, [
    'ms-settings:privacy-microphone',
    'https://learn.microsoft.com/windows/wsl/install',
  ])
  await ipcMain.invoke(
    'qwen-audio-agent:windows-open-runtime-manager',
    event,
  )
  assert.equal(
    target.calls.some(call => call[0] === 'window.show' && call[1] === 'repair'),
    true,
  )
  assert.equal(
    [...ipcMain.handlers.keys()].some(channel => channel.includes('open-external')),
    false,
  )

  target.integration.presentReadySurface = async () => {
    throw new Error('renderer failed')
  }
  assert.deepEqual(
    await ipcMain.invoke(
      WINDOWS_IPC_CHANNELS.confirmRuntimeInstall,
      event,
      'a'.repeat(32),
    ),
    { orbPresented: false },
  )
  target.runtime.installRuntime = async () => {
    throw new Error('runtime install failed')
  }
  await assert.rejects(
    ipcMain.invoke(
      WINDOWS_IPC_CHANNELS.confirmRuntimeInstall,
      event,
      'a'.repeat(32),
    ),
    /runtime install failed/,
  )
})

test('preload exposes the narrow Windows API with matching channels', async () => {
  const source = await readFile(new URL('../src/preload.cjs', import.meta.url), 'utf8')
  const invokes = []
  let exposed = null
  const ipcRenderer = {
    invoke(channel, ...args) {
      invokes.push([channel, ...args])
      return Promise.resolve(null)
    },
    on() {},
    removeListener() {},
    send() {},
  }
  vm.runInNewContext(source, {
    process: { platform: 'win32' },
    require(name) {
      assert.equal(name, 'electron')
      return {
        contextBridge: {
          exposeInMainWorld(_name, api) {
            exposed = api
          },
        },
        ipcRenderer,
      }
    },
  })
  const required = [
    'getDesktopContext',
    'getRuntimeStatus',
    'getRuntimeInstallPlan',
    'retryRuntime',
    'confirmRuntimeInstall',
    'openWindowsOrb',
    'getPrivateRuntimeRemovalPlan',
    'confirmPrivateRuntimeRemoval',
    'setRuntimeMode',
    'setWslDistribution',
    'setExternalGatewayOrigin',
    'setOpenAtLogin',
    'restartRuntime',
    'copyRuntimeDiagnostics',
    'openWindowsMicrophoneSettings',
    'openWindowsSupportLink',
    'openWindowsRuntimeManager',
    'subscribeRuntimeStatus',
  ]
  for (const name of required) assert.equal(typeof exposed[name], 'function')
  assert.equal('openExternal' in exposed, false)
  await exposed.confirmRuntimeInstall('a'.repeat(32))
  await exposed.openWindowsOrb()
  await exposed.openWindowsSupportLink('wsl-networking')
  assert.deepEqual(invokes, [
    [WINDOWS_IPC_CHANNELS.confirmRuntimeInstall, 'a'.repeat(32)],
    [WINDOWS_IPC_CHANNELS.openWindowsOrb],
    [WINDOWS_IPC_CHANNELS.openWindowsSupportLink, 'wsl-networking'],
  ])
})
