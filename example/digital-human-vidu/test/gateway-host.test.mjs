import assert from 'node:assert/strict'
import test from 'node:test'
import { startSharedGateway, localGatewayOrigin } from '../gateway-host.mjs'
import { overlayWindowBounds, overlayWindowOptions } from '../desktop-window.mjs'

function hostFixture() {
  const calls = []
  const runtime = { configDirectory: '/config', dataDirectory: '/data', stateDirectory: '/state', cacheDirectory: '/cache', sharedWorkspace: '/workspace' }
  const options = { env: {}, sourceRoot: '/source',
    loadRuntime: () => runtime,
    findGateway: async () => null,
    createProcess: options => {
      calls.push(['create', options])
      return { start: async () => { calls.push(['start']); return 'http://127.0.0.1:3101' },
        stop: async () => { calls.push(['stop']) } }
    },
  }
  return { calls, options }
}

test('borrows the orb Gateway without starting or stopping another process', async () => {
  const { calls, options } = hostFixture()
  options.findGateway = async state => { assert.equal(state, '/state'); return { origin: 'http://127.0.0.1:3456' } }
  const host = await startSharedGateway(options)
  assert.equal(host.borrowed, true)
  assert.equal(host.origin, 'http://127.0.0.1:3456')
  await host.close()
  assert.deepEqual(calls, [])
})

test('owns only a Gateway it starts and forwards the shared configuration paths', async () => {
  const { calls, options } = hostFixture()
  const host = await startSharedGateway(options)
  assert.equal(host.borrowed, false)
  const environment = calls[0][1].env
  assert.equal(environment.QWAUDIO_CONFIG_DIR, '/config')
  assert.equal(environment.QWAUDIO_STATE_DIR, '/state')
  assert.equal(environment.QWEN_AUDIO_AGENT_SOURCE_ROOT, '/source')
  await host.close()
  assert.deepEqual(calls.map(call => call[0]), ['create', 'start', 'stop'])
})

test('a Gateway startup race cleans up its process and borrows the winner', async () => {
  const { calls, options } = hostFixture()
  let lookup = 0
  options.findGateway = async () => ++lookup === 1 ? null : { origin: 'http://127.0.0.1:3456' }
  options.createProcess = () => ({ start: async () => { throw new Error('lease occupied') }, stop: async () => calls.push(['stop']) })
  const host = await startSharedGateway(options)
  assert.equal(host.borrowed, true)
  await host.close()
  assert.deepEqual(calls, [['stop']])
})

test('explicit Gateway override is health-checked and never owned', async () => {
  const { calls, options } = hostFixture()
  options.env.VIDU_GATEWAY_ORIGIN = 'http://localhost:3456'
  options.loadRuntime = () => { throw new Error('must not load defaults') }
  options.readHealth = async origin => { assert.equal(origin, 'http://localhost:3456'); return { backend: {} } }
  const host = await startSharedGateway(options)
  await host.close()
  assert.deepEqual(calls, [])
  options.readHealth = async () => null
  await assert.rejects(startSharedGateway(options), /unavailable/)
  for (const value of ['https://example.com', 'http://localhost/path', 'http://user:password@localhost', 'http://127.0.0.1/?x=1']) {
    assert.throws(() => localGatewayOrigin(value), /local HTTP origin/)
  }
})

test('floating window fits small and offset displays and isolates its renderer', () => {
  const bounds = overlayWindowBounds({ x: -1920, y: 30, width: 1920, height: 1080 })
  assert.deepEqual(bounds, { x: -402, y: 538, width: 390, height: 560 })
  assert.deepEqual(overlayWindowBounds({ x: 10, y: 20, width: 300, height: 400 }), { x: 10, y: 20, width: 300, height: 400 })
  const options = overlayWindowOptions(bounds, '/preload.cjs')
  assert.equal(options.alwaysOnTop, true)
  assert.equal(options.frame, false)
  assert.equal(options.webPreferences.nodeIntegration, false)
  assert.equal(options.webPreferences.contextIsolation, true)
  assert.equal(options.webPreferences.sandbox, true)
})
