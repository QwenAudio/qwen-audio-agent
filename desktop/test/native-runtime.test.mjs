import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { NativeDesktopRuntime } from '../src/native-runtime.mjs'

const CONFIG_PATH = '/home/tester/.config/qwaudio/config.env'
const INITIAL_CONFIG = [
  'QWEN_AUDIO_AGENT_URL=http://127.0.0.1:3101',
  'QWEN_AUDIO_ORB_STYLE=fluid',
  'DASHSCOPE_API_KEY=initial-key',
  'QWEN_AUDIO_REALTIME_PROVIDER=dashscope',
  'AGENT_PROTOCOL=none',
  '',
].join('\n')

class FakeGateway extends EventEmitter {
  constructor() {
    super()
    this.running = false
    this.status = 'idle'
    this.starts = []
    this.restarts = []
    this.stops = 0
    this.origin = null
    this.onUnexpectedExit = null
  }

  async start(options) {
    this.starts.push(options)
    this.running = true
    this.origin = 'http://127.0.0.1:43101'
    return this.origin
  }

  async restart(options) {
    this.restarts.push(options)
    this.running = true
    this.origin = 'http://127.0.0.1:43102'
    return this.origin
  }

  async stop() {
    this.stops += 1
    this.running = false
    this.origin = null
  }
}

function harness({
  content = INITIAL_CONFIG,
  configExistedAtLaunch = true,
  health = null,
  runningGateway = null,
} = {}) {
  const files = new Map([[CONFIG_PATH, content]])
  const writes = []
  const chmods = []
  const gateways = []
  const backendCalls = []
  const compatibilityChecks = []
  const env = { PATH: '/usr/bin', HOME: '/home/tester' }
  const runtime = new NativeDesktopRuntime({
    runtimeRoot: '/app/runtime',
    sourceRoot: '/app',
    runtimeEnvironment: {
      configPath: CONFIG_PATH,
      configDirectory: '/home/tester/.config/qwaudio',
    },
    configExistedAtLaunch,
    env,
    readFileSync(path) {
      if (!files.has(path)) {
        const error = new Error('missing')
        error.code = 'ENOENT'
        throw error
      }
      return files.get(path)
    },
    writeFileSync(path, value, options) {
      writes.push({ path, value, options })
      files.set(path, value)
    },
    chmodSync(path, mode) {
      chmods.push({ path, mode })
    },
    createGateway(options) {
      const gateway = new FakeGateway()
      gateway.options = options
      gateways.push(gateway)
      return gateway
    },
    readGatewayHealth: async origin => typeof health === 'function'
      ? health(origin)
      : health || {
          realtimeProvider: 'dashscope',
          realtimeLabel: 'DashScope',
          realtimeModel: 'qwen-audio-3.0-realtime-flash',
          voiceConfigured: true,
          voiceClients: { realtime: { connected: true } },
          backend: {
            kind: 'none',
            label: 'Voice only',
            baseUrl: null,
            ok: true,
          },
        },
    findRunningGateway: async () => runningGateway,
    assertGatewayCompatibility(gatewayHealth, environment) {
      compatibilityChecks.push({ gatewayHealth, environment })
    },
    inspectBackendSetups({ env: inspectedEnv }) {
      backendCalls.push(inspectedEnv)
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
    },
    refreshProcessPath() {},
    now: () => 10_000,
  })
  return {
    backendCalls,
    chmods,
    compatibilityChecks,
    env,
    files,
    gateways,
    runtime,
    writes,
  }
}

test('reuses a compatible existing local Gateway without adopting ownership', async () => {
  const runningGateway = {
    origin: 'http://127.0.0.1:41917',
    lease: { instanceId: 'existing-instance', owner: 'cli' },
    health: { ok: true },
  }
  const target = harness({ runningGateway })

  const result = await target.runtime.initialize()

  assert.equal(result.state, 'ready')
  assert.equal(target.runtime.origin, runningGateway.origin)
  assert.equal(target.gateways.length, 0)
  assert.equal(target.compatibilityChecks.length, 1)
  await target.runtime.stop()
  assert.equal(target.gateways.length, 0)
})

test('refuses to change runtime settings while a borrowed Gateway is healthy', async () => {
  const target = harness({
    runningGateway: {
      origin: 'http://127.0.0.1:41917',
      lease: { instanceId: 'existing-instance', owner: 'cli' },
      health: { ok: true },
    },
    health: { ok: true },
  })
  await target.runtime.initialize()

  await assert.rejects(
    target.runtime.writeSettings({
      ...(await target.runtime.readSettings()),
      dashscopeApiKey: 'updated-key',
    }),
    /复用由其他进程启动的 Gateway/,
  )
  assert.equal(target.writes.length, 0)
  assert.match(target.files.get(CONFIG_PATH), /DASHSCOPE_API_KEY=initial-key/)
})

test('reads settings and starts the existing local Gateway configuration', async () => {
  const target = harness()
  assert.equal((await target.runtime.readSettings()).dashscopeApiKey, 'initial-key')
  const result = await target.runtime.initialize()
  assert.equal(result.state, 'ready')
  assert.equal(target.runtime.origin, 'http://127.0.0.1:43101')
  assert.equal(target.gateways.length, 1)
  assert.deepEqual(target.gateways[0].starts, [{ preferredPort: 3101 }])
  const childEnvironment = target.gateways[0].options.envFactory()
  assert.equal(childEnvironment.DASHSCOPE_API_KEY, 'initial-key')
  assert.equal(childEnvironment.QWEN_AUDIO_AGENT_RUNTIME_ROOT, '/app/runtime')
  assert.equal(target.env.QWEN_AUDIO_AGENT_URL, 'http://127.0.0.1:43101')
})

test('reports setup-required without starting when local voice settings are absent', async () => {
  const target = harness({
    content: 'QWEN_AUDIO_AGENT_URL=http://127.0.0.1:3101\nDASHSCOPE_API_KEY=\n',
  })
  assert.deepEqual(await target.runtime.initialize(), {
    state: 'setup-required',
    reason: 'settings-required',
    canRepair: true,
    origin: null,
  })
  assert.equal(target.gateways.length, 0)
})

test('writes mode-0600 settings and restarts the owned Gateway when runtime values change', async () => {
  const target = harness()
  await target.runtime.initialize()
  const result = await target.runtime.writeSettings({
    ...(await target.runtime.readSettings()),
    dashscopeApiKey: 'updated-key',
    agentProtocol: 'none',
  })
  assert.equal(result.restarted, true)
  assert.equal(target.gateways[0].restarts.length, 1)
  assert.equal(target.runtime.origin, 'http://127.0.0.1:43102')
  assert.equal(target.writes.at(-1).options.mode, 0o600)
  assert.deepEqual(target.chmods.at(-1), { path: CONFIG_PATH, mode: 0o600 })
  assert.match(target.files.get(CONFIG_PATH), /DASHSCOPE_API_KEY=updated-key/)
  assert.equal(result.settings.dashscopeApiKey, 'updated-key')
})

test('switches to a healthy remote Gateway without adopting its process', async () => {
  const target = harness()
  await target.runtime.initialize()
  const result = await target.runtime.writeSettings({
    ...(await target.runtime.readSettings()),
    gatewayUrl: 'https://gateway.example.com',
  })
  assert.equal(target.gateways[0].stops, 1)
  assert.equal(target.runtime.origin, 'https://gateway.example.com')
  assert.equal(result.restarted, false)
  await target.runtime.stop()
  assert.equal(target.gateways[0].stops, 1)
})

test('maps Gateway health and returns only public backend inspection fields', async () => {
  const target = harness()
  await target.runtime.initialize()
  assert.deepEqual(await target.runtime.getRuntimeStatus(), {
    gatewayConnected: true,
    realtimeProvider: 'dashscope',
    realtimeLabel: 'DashScope',
    realtimeModel: 'qwen-audio-3.0-realtime-flash',
    voiceConfigured: true,
    realtimeConnection: { connected: true },
    backend: {
      protocol: 'none',
      label: 'Voice only',
      baseUrl: null,
      model: null,
      connected: true,
      error: null,
    },
  })
  assert.deepEqual(await target.runtime.inspectBackends(), {
    selected: 'none',
    backends: [{
      id: 'none',
      label: 'Voice only',
      ready: true,
      selected: true,
      issues: [],
    }],
  })
  await target.runtime.inspectBackends()
  assert.equal(target.backendCalls.length, 1)
  await target.runtime.inspectBackends({ force: true })
  assert.equal(target.backendCalls.length, 2)
})

test('forwards runtime status and removes subscriptions cleanly', async () => {
  const target = harness()
  const statuses = []
  const unsubscribe = target.runtime.subscribeStatus(status => statuses.push(status))
  await target.runtime.initialize()
  assert.equal(statuses.at(-1).state, 'ready')
  const subscribedCount = statuses.length
  unsubscribe()
  await target.runtime.restartRuntime()
  assert.equal(statuses.length, subscribedCount)
  await target.runtime.stop()
  assert.equal(target.gateways[0].onUnexpectedExit, null)
})
