import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import {
  DefaultWslRuntimeAdapter,
  validateExternalGatewayOrigin,
  WslRuntimeController,
} from '../src/wsl-runtime-controller.mjs'

const SHA256 = 'ab'.repeat(32)
const NOW = '2026-08-03T08:00:00.000Z'

function marker(overrides = {}) {
  return {
    desktopVersion: '1.2.0',
    packageVersion: '1.2.0',
    protocolVersion: 1,
    sha256: SHA256,
    installedAt: NOW,
    ...overrides,
  }
}

class FakeHostClient extends EventEmitter {
  constructor({
    hello = {
      protocol: 1,
      packageVersion: '1.2.0',
      nodeVersion: '22.22.2',
      distribution: 'Ubuntu',
    },
    origin = 'http://127.0.0.1:43101',
    helloError = null,
    startError = null,
  } = {}) {
    super()
    this.hello = hello
    this.origin = origin
    this.helloError = helloError
    this.startError = startError
    this.requests = []
    this.shutdowns = 0
    this.closed = false
  }

  async waitForHello() {
    if (this.helloError) throw this.helloError
    return this.hello
  }

  async request(method, params) {
    this.requests.push({ method, params })
    if (method === 'gateway.start') {
      if (this.startError) throw this.startError
      return { origin: this.origin }
    }
    if (method === 'settings.read') {
      return { settings: { gatewayUrl: 'http://127.0.0.1:3101' } }
    }
    if (method === 'settings.write') {
      return { settings: params.settings, origin: this.origin }
    }
    if (method === 'backends.inspect') {
      return {
        selected: 'none',
        backends: [{
          id: 'none',
          label: 'Voice only',
          ready: true,
          selected: true,
          issues: [],
          privatePath: '/must/not/escape',
        }],
      }
    }
    return {}
  }

  async shutdown() {
    this.shutdowns += 1
    this.closed = true
  }

  tailDiagnostics() {
    return ['diagnostic line']
  }
}

function createHarness({
  preferences = {
    mode: 'managed',
    distribution: '',
    externalGatewayOrigin: '',
  },
  probe = {},
  inspect = {},
  adapterOverrides = {},
  clientOptions = {},
  clientFactory = null,
  now = () => Date.parse(NOW),
  controllerOptions = {},
} = {}) {
  const calls = []
  let currentInspect = {
    marker: marker(),
    executableExists: true,
    currentMarker: null,
    ...inspect,
  }
  const adapter = {
    async discover({ configured }) {
      calls.push(['discover', configured])
      return {
        selected: 'Ubuntu',
        distributions: [
          { name: 'Ubuntu', state: 'Running', version: 2, isDefault: true },
        ],
        probe: {
          home: '/home/tester',
          distribution: 'Ubuntu',
          architecture: 'x86_64',
          nodeVersion: 'v22.22.2',
          npmVersion: '10.9.4',
          ...probe,
        },
      }
    },
    async inspectRuntime(context) {
      calls.push(['inspect', context.layout.versionDirectory])
      return currentInspect
    },
    async prepareInstallPlan(context) {
      calls.push(['plan', context.distribution])
      return {
        displayCommand: 'npm install --prefix ~/.local/share/qwaudio/windows-client/runtime/1.2.0 payload.tgz',
        opaque: 'exact-plan',
      }
    },
    async verifyRuntimePayload(context) {
      calls.push(['verify-payload', context.sha256])
      return true
    },
    async installRuntime(plan, { marker: nextMarker, onProgress }) {
      calls.push(['install', plan.opaque])
      onProgress({ phase: 'installing', completed: 2, total: 3 })
      currentInspect = {
        ...currentInspect,
        marker: nextMarker,
        executableExists: true,
      }
    },
    async spawnHost(context) {
      calls.push(['spawn', context.sessionToken, context.runtimeEntry])
      return { fake: true }
    },
    async readGatewayHealth(origin) {
      calls.push(['health', origin])
      return { backend: { ok: true } }
    },
    async promoteCurrent(context) {
      calls.push(['promote', context.marker.desktopVersion])
    },
    async resolveLastKnownGood() {
      calls.push(['fallback'])
      return null
    },
    async validateRemovalTarget(context) {
      calls.push(['validate-removal', context.layout.privateRoot])
      return {
        root: context.layout.privateRoot,
        marker: marker(),
      }
    },
    async removePrivateRuntime(context) {
      calls.push(['remove', context.root])
    },
    ...adapterOverrides,
  }
  const clients = []
  const tokens = []
  const controller = new WslRuntimeController({
    desktopVersion: '1.2.0',
    packageVersion: '1.2.0',
    protocolVersion: 1,
    runtimeSha256: SHA256,
    bundledTarballPath: 'C:\\Program Files\\Qwen Audio\\payload.tgz',
    preferences: { read: async () => preferences },
    adapter,
    createClient(options) {
      tokens.push(options.sessionToken)
      const client = clientFactory
        ? clientFactory(options, clients.length)
        : new FakeHostClient(clientOptions)
      clients.push(client)
      return client
    },
    randomBytes: size => Buffer.alloc(size, clients.length + 1),
    now,
    healthTimeoutMs: 100,
    healthPollIntervalMs: 1,
    recoveryDelaysMs: [1, 2, 4],
    ...controllerOptions,
  })
  return {
    adapter,
    calls,
    clients,
    controller,
    tokens,
    setInspect(value) {
      currentInspect = value
    },
  }
}

test('requires explicit confirmation before installing and follows the normal state path', async () => {
  const target = createHarness({
    inspect: { marker: null, executableExists: false },
  })
  const states = []
  target.controller.on('status', status => states.push(status))

  await target.controller.initialize()
  assert.equal(target.controller.status.state, 'setup-required')
  assert.equal(target.calls.some(call => call[0] === 'install'), false)

  const plan = await target.controller.getRuntimeInstallPlan()
  assert.match(plan.displayCommand, /^npm install /)
  assert.match(plan.confirmationId, /^[a-f\d]{32}$/)
  await target.controller.installRuntime(plan.confirmationId)
  assert.equal(target.controller.status.state, 'ready')
  assert.equal(target.controller.origin, 'http://127.0.0.1:43101')
  assert.deepEqual(
    [...new Set(states.map(status => status.state))],
    ['checking', 'setup-required', 'starting', 'ready'],
  )
  const progress = states.find(status => status.progress?.phase === 'installing')
  assert.deepEqual(progress.progress, {
    phase: 'installing',
    completed: 2,
    total: 3,
  })
  assert.equal(target.tokens[0].length, 64)
  assert.deepEqual(target.clients[0].requests[0], {
    method: 'gateway.start',
    params: { sessionToken: target.tokens[0] },
  })
  assert.equal(target.calls.at(-1)[0], 'promote')
  assert.ok(
    target.calls.findIndex(call => call[0] === 'verify-payload')
      < target.calls.findIndex(call => call[0] === 'install'),
  )

  await target.controller.stop()
  assert.equal(target.controller.status.state, 'stopping')
  assert.equal(target.clients[0].shutdowns, 1)
})

test('stops before WSL installation when the bundled payload hash mismatches', async () => {
  const target = createHarness({
    inspect: { marker: null, executableExists: false },
    adapterOverrides: {
      async verifyRuntimePayload(context) {
        target.calls.push(['verify-payload', context.sha256])
        return false
      },
    },
  })
  await target.controller.initialize()
  const plan = await target.controller.getRuntimeInstallPlan()

  await assert.rejects(
    target.controller.installRuntime(plan.confirmationId),
    error => error.reason === 'runtime-integrity-failed' && error.canRepair,
  )

  assert.equal(target.controller.status.state, 'error')
  assert.equal(target.controller.status.reason, 'runtime-integrity-failed')
  assert.equal(target.calls.some(call => call[0] === 'install'), false)
})

test('reports invalid bundled payload metadata before probing managed WSL', async () => {
  const target = createHarness({
    controllerOptions: { runtimeSha256: '' },
  })

  await target.controller.initialize()

  assert.equal(target.controller.status.state, 'error')
  assert.equal(target.controller.status.reason, 'runtime-integrity-failed')
  assert.equal(target.controller.status.canRepair, true)
  assert.equal(target.calls.some(call => call[0] === 'discover'), false)
})

test('exposes the shared settings, health, backend, and status subscription interface', async () => {
  const target = createHarness()
  const statuses = []
  const unsubscribe = target.controller.subscribeStatus(status => statuses.push(status))
  await target.controller.initialize()
  assert.deepEqual(await target.controller.readSettings(), {
    gatewayUrl: 'http://127.0.0.1:3101',
  })
  const saved = await target.controller.writeSettings({
    gatewayUrl: 'http://127.0.0.1:3101',
  })
  assert.equal(saved.runtime.gatewayConnected, true)
  assert.deepEqual(await target.controller.inspectBackends(), {
    selected: 'none',
    backends: [{
      id: 'none',
      label: 'Voice only',
      ready: true,
      selected: true,
      issues: [],
    }],
  })
  const subscribedCount = statuses.length
  unsubscribe()
  target.clients[0].emit('status', { state: 'recovering', retry: 1 })
  assert.equal(statuses.length, subscribedCount)
})

test('rejects missing, expired, reused, and stale install confirmations', async () => {
  let clock = Date.parse(NOW)
  const target = createHarness({
    inspect: { marker: null, executableExists: false },
    now: () => clock,
  })
  await target.controller.initialize()
  await assert.rejects(
    target.controller.installRuntime('missing'),
    error => error.reason === 'confirmation-required',
  )
  const expired = await target.controller.getRuntimeInstallPlan()
  clock += 3 * 60_000
  await assert.rejects(
    target.controller.installRuntime(expired.confirmationId),
    error => error.reason === 'confirmation-expired',
  )

  clock = Date.parse(NOW)
  const usable = await target.controller.getRuntimeInstallPlan()
  await target.controller.installRuntime(usable.confirmationId)
  await assert.rejects(
    target.controller.installRuntime(usable.confirmationId),
    error => error.reason === 'confirmation-required',
  )

  const staleTarget = createHarness({
    inspect: { marker: null, executableExists: false },
  })
  await staleTarget.controller.initialize()
  const stale = await staleTarget.controller.getRuntimeInstallPlan()
  await staleTarget.controller.initialize()
  await assert.rejects(
    staleTarget.controller.installRuntime(stale.confirmationId),
    error => error.reason === 'confirmation-required',
  )
})

test('exposes actionable setup and discovery failures without leaking command output', async () => {
  const cases = [
    {
      target: createHarness({ probe: { nodeVersion: '', npmVersion: '' } }),
      state: 'setup-required',
      reason: 'node-required',
      canRepair: false,
    },
    {
      target: createHarness({ probe: { architecture: 'aarch64' } }),
      state: 'error',
      reason: 'unsupported-architecture',
      canRepair: false,
    },
    {
      target: createHarness({ probe: { npmVersion: '' } }),
      state: 'setup-required',
      reason: 'node-required',
      canRepair: false,
    },
    {
      target: createHarness({
        adapterOverrides: {
          async discover() {
            const error = new Error('token=super-secret')
            error.reason = 'wsl-unavailable'
            throw error
          },
        },
      }),
      state: 'error',
      reason: 'wsl-unavailable',
      canRepair: true,
    },
    ...['wsl2-required', 'no-distributions'].map(reason => ({
      target: createHarness({
        adapterOverrides: {
          async discover() {
            const error = new Error('localized command output')
            error.reason = reason
            throw error
          },
        },
      }),
      state: 'error',
      reason,
      canRepair: true,
    })),
  ]

  for (const item of cases) {
    await item.target.controller.initialize()
    assert.equal(item.target.controller.status.state, item.state)
    assert.equal(item.target.controller.status.reason, item.reason)
    assert.equal(item.target.controller.status.canRepair, item.canRepair)
    assert.doesNotMatch(JSON.stringify(item.target.controller.status), /super-secret/)
  }
})

test('distinguishes Gateway start failure from localhost health timeout', async () => {
  const startFailure = createHarness({
    clientOptions: { startError: new Error('start failed token=secret') },
  })
  await startFailure.controller.initialize()
  assert.equal(startFailure.controller.status.reason, 'gateway-start-failed')

  const healthFailure = createHarness({
    adapterOverrides: {
      async readGatewayHealth() {
        return null
      },
    },
    controllerOptions: {
      healthTimeoutMs: 3,
      healthPollIntervalMs: 1,
    },
  })
  await healthFailure.controller.initialize()
  assert.equal(healthFailure.controller.status.reason, 'gateway-health-timeout')
})

test('reports install and handshake failures and falls back to last-known-good runtime', async () => {
  const installFailure = createHarness({
    inspect: { marker: null, executableExists: false },
    adapterOverrides: {
      async installRuntime() {
        throw new Error('npm token=super-secret failed')
      },
    },
  })
  await installFailure.controller.initialize()
  const installPlan = await installFailure.controller.getRuntimeInstallPlan()
  await assert.rejects(
    installFailure.controller.installRuntime(installPlan.confirmationId),
    error => (
      error.reason === 'runtime-install-failed'
      && !error.message.includes('super-secret')
    ),
  )
  assert.equal(installFailure.controller.status.reason, 'runtime-install-failed')

  const fallbackMarker = marker({
    desktopVersion: '1.1.0',
    packageVersion: '1.1.0',
  })
  let spawnedFallback = false
  let fallbackAvailable = false
  const handshakeFailure = createHarness({
    inspect: { marker: null, executableExists: false },
    clientFactory: (_options, index) => index === 0
      ? new FakeHostClient({ helloError: new Error('hello timeout') })
      : new FakeHostClient({
          hello: {
            protocol: 1,
            packageVersion: '1.1.0',
            nodeVersion: '22.22.2',
            distribution: 'Ubuntu',
          },
        }),
    adapterOverrides: {
      async resolveLastKnownGood() {
        return fallbackAvailable ? {
          marker: fallbackMarker,
          runtimeEntry: '/home/tester/.local/share/qwaudio/windows-client/runtime/1.1.0/node_modules/.bin/qwenaudio',
        } : null
      },
      async spawnHost(context) {
        if (context.marker.desktopVersion === '1.1.0') spawnedFallback = true
        return { fake: true }
      },
    },
  })
  await handshakeFailure.controller.initialize()
  const handshakePlan = await handshakeFailure.controller.getRuntimeInstallPlan()
  fallbackAvailable = true
  await handshakeFailure.controller.installRuntime(handshakePlan.confirmationId)
  assert.equal(spawnedFallback, true)
  assert.equal(handshakeFailure.controller.status.state, 'ready')
  assert.equal(handshakeFailure.controller.status.syncAvailable, true)
})

test('keeps a compatible old runtime live until an explicitly confirmed sync switches it', async () => {
  const fallbackMarker = marker({
    desktopVersion: '1.1.0',
    packageVersion: '1.1.0',
  })
  const target = createHarness({
    inspect: { marker: null, executableExists: false },
    clientFactory: (_options, index) => new FakeHostClient(index === 0 ? {
      hello: {
        protocol: 1,
        packageVersion: '1.1.0',
        nodeVersion: '22.22.2',
        distribution: 'Ubuntu',
      },
    } : {}),
    adapterOverrides: {
      async resolveLastKnownGood() {
        return {
          marker: fallbackMarker,
          runtimeEntry: '/home/tester/.local/share/qwaudio/windows-client/runtime/1.1.0/node_modules/.bin/qwenaudio',
        }
      },
    },
  })
  await target.controller.initialize()
  assert.equal(target.controller.status.state, 'ready')
  assert.equal(target.controller.status.syncAvailable, true)
  const plan = await target.controller.getRuntimeInstallPlan()
  await target.controller.installRuntime(plan.confirmationId)
  assert.equal(target.clients[0].shutdowns, 1)
  assert.equal(target.clients.length, 2)
  assert.equal(target.controller.status.state, 'ready')
})

test('mirrors Gateway recovery status and performs bounded bridge recovery', async () => {
  const target = createHarness()
  await target.controller.initialize()
  target.clients[0].emit('status', { state: 'recovering', retry: 1, delayMs: 1000 })
  assert.equal(target.controller.status.state, 'recovering')
  target.clients[0].emit('status', {
    state: 'ready',
    origin: 'http://127.0.0.1:43101',
  })
  assert.equal(target.controller.status.state, 'ready')

  target.clients[0].closed = true
  target.clients[0].emit('closed', new Error('bridge crashed'))
  await new Promise(resolve => setTimeout(resolve, 15))
  assert.equal(target.clients.length >= 2, true)
  assert.equal(target.controller.status.state, 'ready')
  await target.controller.stop()
})

test('stops automatic bridge recovery after the 1/2/4 retry budget', async () => {
  const target = createHarness({
    clientFactory: (_options, index) => index === 0
      ? new FakeHostClient()
      : new FakeHostClient({ helloError: new Error('bridge unavailable') }),
  })
  await target.controller.initialize()
  target.clients[0].closed = true
  target.clients[0].emit('closed', new Error('bridge crashed'))
  await new Promise(resolve => setTimeout(resolve, 35))
  assert.equal(target.clients.length, 4)
  assert.equal(target.controller.status.state, 'error')
  assert.equal(target.controller.status.reason, 'bridge-recovery-exhausted')
})

test('supports user cancellation without promoting or leaking an install error', async () => {
  let installStarted
  const started = new Promise(resolve => {
    installStarted = resolve
  })
  const target = createHarness({
    inspect: { marker: null, executableExists: false },
    adapterOverrides: {
      installRuntime(_plan, { signal }) {
        installStarted()
        return new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => {
            const error = new Error('cancelled')
            error.name = 'AbortError'
            reject(error)
          }, { once: true })
        })
      },
    },
  })
  await target.controller.initialize()
  const plan = await target.controller.getRuntimeInstallPlan()
  const install = target.controller.installRuntime(plan.confirmationId)
  await started
  await target.controller.cancelRuntimeSetup()
  await assert.rejects(install, error => error.reason === 'cancelled')
  assert.equal(target.controller.status.state, 'setup-required')
  assert.equal(target.controller.status.reason, 'cancelled')
})

test('validates and reconnects external loopback mode without owning a Gateway', async () => {
  assert.equal(
    validateExternalGatewayOrigin('http://localhost:3101'),
    'http://localhost:3101',
  )
  for (const invalid of [
    'https://localhost:3101',
    'http://192.168.1.2:3101',
    'http://localhost/path',
    'http://localhost:3101/?token=secret',
  ]) {
    assert.throws(() => validateExternalGatewayOrigin(invalid), /loopback/i)
  }

  const target = createHarness({
    preferences: {
      mode: 'external',
      distribution: '',
      externalGatewayOrigin: 'http://localhost:3101',
    },
  })
  await target.controller.initialize()
  assert.equal(target.controller.status.state, 'external')
  assert.equal(target.controller.origin, 'http://localhost:3101')
  assert.equal(target.calls.some(call => call[0] === 'spawn'), false)

  let healthChecks = 0
  const reconnecting = createHarness({
    preferences: {
      mode: 'external',
      distribution: '',
      externalGatewayOrigin: 'http://127.0.0.1:3101',
    },
    adapterOverrides: {
      async readGatewayHealth() {
        healthChecks += 1
        return healthChecks === 1 ? null : { backend: { ok: true } }
      },
    },
  })
  await reconnecting.controller.initialize()
  assert.equal(reconnecting.controller.status.reason, 'external-unavailable')
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(reconnecting.controller.status.state, 'external')
  assert.equal(reconnecting.controller.status.reason, null)
  assert.equal(reconnecting.controller.origin, 'http://127.0.0.1:3101')
  await reconnecting.controller.stop()
})

test('removes only a twice-validated private root after fresh confirmation', async () => {
  const target = createHarness()
  await target.controller.initialize()
  const plan = await target.controller.getPrivateRuntimeRemovalPlan()
  assert.equal(
    plan.root,
    '/home/tester/.local/share/qwaudio/windows-client',
  )
  await target.controller.removePrivateRuntime(plan.confirmationId)
  assert.deepEqual(
    target.calls.filter(call => call[0] === 'validate-removal').length,
    2,
  )
  assert.deepEqual(target.calls.find(call => call[0] === 'remove'), [
    'remove',
    '/home/tester/.local/share/qwaudio/windows-client',
  ])
  assert.equal(target.controller.status.state, 'setup-required')
  assert.equal(target.controller.status.reason, 'runtime-required')
})

test('removes the inactive managed runtime while preserving external mode', async () => {
  const preferences = {
    mode: 'managed',
    distribution: '',
    externalGatewayOrigin: '',
  }
  const target = createHarness({ preferences })
  await target.controller.initialize()
  preferences.mode = 'external'
  preferences.externalGatewayOrigin = 'http://127.0.0.1:3101'
  await target.controller.retry()
  assert.equal(target.controller.status.state, 'external')

  const plan = await target.controller.getPrivateRuntimeRemovalPlan()
  assert.equal(
    plan.root,
    '/home/tester/.local/share/qwaudio/windows-client',
  )
  await target.controller.removePrivateRuntime(plan.confirmationId)
  assert.equal(target.controller.status.state, 'external')
  assert.equal(target.controller.origin, 'http://127.0.0.1:3101')
  assert.equal(target.controller.context.mode, 'external')
  assert.equal(target.controller.context.managed, null)
  assert.equal(target.calls.filter(call => call[0] === 'remove').length, 1)
  await target.controller.stop()
})

test('default adapter stages, installs, marks, and spawns through structured WSL argv', async () => {
  const commands = []
  const spawns = []
  const adapter = new DefaultWslRuntimeAdapter({
    env: { PATH: 'C:\\Windows', WSLENV: 'EXISTING/u' },
    randomBytes: size => Buffer.alloc(size, 7),
    runCommand: async command => {
      commands.push(command)
      if (command.args.includes('wslpath')) {
        return { stdout: Buffer.from('/mnt/c/Program Files/Qwen/payload.tgz\n') }
      }
      return { stdout: Buffer.alloc(0), code: 0 }
    },
    spawnImpl(file, args, options) {
      spawns.push({ file, args, options })
      return { stdin: {}, stdout: {}, stderr: {} }
    },
  })
  const layout = {
    homeDirectory: '/home/tester',
    privateRoot: '/home/tester/.local/share/qwaudio/windows-client',
    runtimeRoot: '/home/tester/.local/share/qwaudio/windows-client/runtime',
    versionDirectory: '/home/tester/.local/share/qwaudio/windows-client/runtime/1.2.0',
    executablePath: '/home/tester/.local/share/qwaudio/windows-client/runtime/1.2.0/node_modules/.bin/qwenaudio',
    versionMarkerPath: '/home/tester/.local/share/qwaudio/windows-client/runtime/1.2.0/runtime.json',
    currentMarkerPath: '/home/tester/.local/share/qwaudio/windows-client/current.json',
  }
  const context = {
    distribution: 'Ubuntu',
    layout,
    bundledTarballPath: 'C:\\Program Files\\Qwen\\payload.tgz',
  }
  const plan = await adapter.prepareInstallPlan(context)
  const progress = []
  await adapter.installRuntime(plan, {
    distribution: 'Ubuntu',
    layout,
    marker: marker(),
    signal: new AbortController().signal,
    onProgress: value => progress.push(value),
  })
  adapter.spawnHost({
    distribution: 'Ubuntu',
    runtimeEntry: layout.executablePath,
    sessionToken: 'cd'.repeat(32),
  })

  assert.deepEqual(progress.at(-1), {
    phase: 'verifying',
    completed: 4,
    total: 4,
  })
  assert.deepEqual(commands.map(command => command.args.find(value => (
    ['wslpath', 'mkdir', 'cp', 'npm', 'node', 'rm', 'rmdir'].includes(value)
  ))), [
    'wslpath', 'mkdir', 'cp', 'npm', 'node', 'rm', 'rmdir',
  ])
  assert.equal(commands.every(command => command.options.shell === false), true)
  assert.equal(commands[2].args.includes('--'), true)
  assert.equal(spawns[0].file, 'wsl.exe')
  assert.equal(spawns[0].options.shell, false)
  assert.equal(
    spawns[0].options.env.QWEN_AUDIO_DESKTOP_SESSION_TOKEN,
    'cd'.repeat(32),
  )
  assert.match(
    spawns[0].options.env.WSLENV,
    /QWEN_AUDIO_DESKTOP_SESSION_TOKEN/,
  )
})

test('default adapter hashes the Windows payload without invoking WSL', async () => {
  const payload = Buffer.from('bundled runtime payload')
  const sha256 = createHash('sha256').update(payload).digest('hex')
  let wslInvoked = false
  const adapter = new DefaultWslRuntimeAdapter({
    readFile: async path => {
      assert.equal(path, 'C:\\Program Files\\Qwen\\payload.tgz')
      return payload
    },
    runCommand: async () => {
      wslInvoked = true
      throw new Error('must not run')
    },
  })

  assert.equal(await adapter.verifyRuntimePayload({
    path: 'C:\\Program Files\\Qwen\\payload.tgz',
    sha256,
  }), true)
  assert.equal(await adapter.verifyRuntimePayload({
    path: 'C:\\Program Files\\Qwen\\payload.tgz',
    sha256: 'cd'.repeat(32),
  }), false)
  assert.equal(wslInvoked, false)
})

test('default adapter refuses removal targets outside the fixed private root', async () => {
  let executed = false
  const adapter = new DefaultWslRuntimeAdapter({
    runCommand: async () => {
      executed = true
      return { stdout: Buffer.alloc(0), code: 0 }
    },
  })
  await assert.rejects(adapter.removePrivateRuntime({
    distribution: 'Ubuntu',
    root: '/home/tester/.config/qwaudio',
  }), /private runtime root/i)
  assert.equal(executed, false)
})
