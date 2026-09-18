import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { parseArguments, helpText } from '../src/arguments.mjs'
import { main } from '../src/launcher.mjs'
import { ensureRuntime, readWebRtcConfiguration } from '../src/runtime.mjs'
import { requireWebRtcDependencies } from '../../shared/gateway/webrtc.mjs'
import { resolveRealtimeFrontendConfiguration } from '../../shared/realtime-provider-catalog.mjs'

test('WebRTC is opt-in, accepts CLI or environment and stays scoped to Gateway startup', () => {
  assert.equal(parseArguments(['gateway'], {}).webrtc, false)
  assert.equal(parseArguments(['gateway', '--webrtc'], {}).webrtc, true)
  assert.equal(parseArguments(['gateway', '--webrtc'], { QWAUDIO_WEBRTC_ENABLED: '0' }).webrtc, true)
  assert.equal(parseArguments(['gateway', 'install', '--webrtc'], {}).webrtc, true)
  for (const value of ['1', 'true']) assert.equal(parseArguments(['gateway'], { QWAUDIO_WEBRTC_ENABLED: value }).webrtc, true)
  for (const argv of [['tui', '--webrtc'], ['webui', '--webrtc'], ['gateway', 'pair', '--webrtc'], ['gateway', 'restart', '--webrtc']]) {
    assert.throws(() => parseArguments(argv, {}), /--webrtc 只适用于/)
  }
  assert.match(helpText(), /--webrtc/)
  assert.match(helpText(), /QWAUDIO_WEBRTC_ENABLED/)
})

test('dependency preflight explains how to install the optional npm extension', () => {
  assert.throws(() => requireWebRtcDependencies({
    resolvePackage: () => { throw Object.assign(new Error('missing'), { code: 'MODULE_NOT_FOUND' }) },
    sourceManifest: null,
  }), /npm install -g qwen-audio-agent-webrtc/)
})

function launcher(overrides = {}) {
  const calls = []
  return { calls, dependencies: {
    env: {}, stdout: { write: value => calls.push(['output', value]) },
    signalSource: new EventEmitter(), prepareEnvironment: () => ({ configDirectory: '/tmp/rtc-config', stateDirectory: '/tmp/rtc-state' }),
    refreshPath: () => {},
    prepareRuntime: async options => { calls.push(['runtime', options]); return { ownsProcesses: false, close: () => calls.push(['close']) } },
    inspectGateway: async () => ({ backend: { enabled: false } }),
    inspectWebRtc: async (url, token) => { calls.push(['webrtc', url, token]); return { model: 'qwen-audio-3.0-realtime-plus' } },
    ...overrides,
  } }
}

test('CLI enable flag sets the existing switch and prints the demo URL after checking the endpoint', async () => {
  const { calls, dependencies } = launcher()
  await main(['gateway', '--webrtc'], dependencies)
  assert.equal(dependencies.env.QWAUDIO_WEBRTC_ENABLED, '1')
  assert.equal(calls.find(call => call[0] === 'runtime')[1].webrtc, true)
  assert.ok(calls.some(call => call[0] === 'webrtc'))
  assert.match(calls.find(call => call[0] === 'output')[1], /\/api\/realtime\/webrtc\/example/)
})

test('ordinary CLI startup does not enable or probe WebRTC', async () => {
  const { calls, dependencies } = launcher()
  await main(['gateway'], dependencies)
  assert.equal(dependencies.env.QWAUDIO_WEBRTC_ENABLED, undefined)
  assert.ok(!calls.some(call => call[0] === 'webrtc'))
})

test('CLI refuses a running WSS-only Gateway without stopping that shared process', async () => {
  const { calls, dependencies } = launcher({ inspectWebRtc: () => readWebRtcConfiguration('http://localhost:3101', { fetchImpl: async () => ({ status: 404 }) }) })
  await assert.rejects(main(['gateway', '--webrtc'], dependencies), /未开启 WebRTC/)
  assert.ok(!calls.some(call => call[0] === 'close'))
})

test('WebRTC endpoint validation rejects unsupported models and propagates Gateway credentials', async () => {
  await assert.rejects(readWebRtcConfiguration('http://localhost:3101', {
    fetchImpl: async () => ({ status: 409, ok: false, json: async () => ({ error: { message: 'model unsupported' } }) }),
  }), /model unsupported/)
  const result = await readWebRtcConfiguration('http://localhost:3101', {
    accessToken: 'synthetic-token',
    fetchImpl: async (url, options) => {
      assert.equal(url.pathname, '/api/v1/webrtc/config')
      assert.equal(options.headers.Authorization, 'Bearer synthetic-token')
      return { status: 200, ok: true, json: async () => ({ model: 'qwen-audio-3.0-realtime-plus' }) }
    },
  })
  assert.ok(result.model)
})

test('service installation records the explicit WebRTC switch without installing media packages', async () => {
  const operations = []
  const { dependencies } = launcher({
    inspectGateway: async () => null,
    checkWebRtcDependencies: () => operations.push(['dependencies']),
    manageService: async (action, options) => { operations.push([action, options]); return { running: false, installed: true } },
    waitForService: async () => ({ backend: { enabled: false } }),
  })
  await main(['gateway', 'install', '--webrtc'], dependencies)
  assert.equal(operations[0][0], 'dependencies')
  const install = operations.find(([action]) => action === 'install')[1]
  assert.equal(install.serviceEnvironment.QWAUDIO_WEBRTC_ENABLED, '1')
  assert.equal(install.serviceMetadata.webrtc, true)
})

test('runtime rejects missing optional dependencies before spawning a Gateway', async () => {
  let spawned = false
  await assert.rejects(ensureRuntime({ url: 'http://localhost:3101', webrtc: true }, {
    root: '/unused', env: {}, loadEnvironment: () => {}, requireCredential: () => {},
    requireWebRtc: () => { throw new Error('install WebRTC dependencies') },
    fetchImpl: async () => { throw new Error('not running') },
    spawnImpl: () => { spawned = true },
  }), /install WebRTC dependencies/)
  assert.equal(spawned, false)
})

test('runtime forwards WebRTC into its Gateway child without changing the model signature', async () => {
  const env = { DASHSCOPE_API_KEY: 'synthetic-key' }
  const frontend = resolveRealtimeFrontendConfiguration(env)
  let fetched = false
  let childEnvironment
  let checked = false
  const runtime = await ensureRuntime({ url: 'http://localhost:3101', webrtc: true }, {
    root: '/unused', env, loadEnvironment: () => {}, requireCredential: () => {},
    requireWebRtc: () => { checked = true },
    fetchImpl: async () => {
      if (!fetched) { fetched = true; throw new Error('not running') }
      return { json: async () => ({ ok: true, backend: { enabled: false }, realtimeProvider: frontend.active.provider, realtimeConfigurationSignature: frontend.active.signature }) }
    },
    spawnImpl: (_command, _args, options) => {
      childEnvironment = options.env
      const child = new EventEmitter()
      child.exitCode = 0
      return child
    },
  })
  assert.equal(checked, true)
  assert.equal(childEnvironment.QWAUDIO_WEBRTC_ENABLED, '1')
  assert.equal(runtime.ownsProcesses, true)
})
