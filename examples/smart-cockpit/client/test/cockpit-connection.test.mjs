import assert from 'node:assert/strict'
import test from 'node:test'
import { createCockpitViteConfig } from '../vite.config.js'
import { createHookHarness, mockHookImports } from './helpers/hook-harness.mjs'

test('client inherits the Gateway cockpit and Service proxy in a separate demo instance', () => {
  const config = createCockpitViteConfig({
    COCKPIT_ID: 'multi-zone-validation',
    COCKPIT_SERVICE_ORIGIN: 'http://127.0.0.1:3011',
  })
  assert.equal(JSON.parse(config.define['import.meta.env.VITE_COCKPIT_ID']), 'multi-zone-validation')
  assert.equal(config.server.proxy['/api'].target, 'http://127.0.0.1:3011')
  const explicit = createCockpitViteConfig({
    COCKPIT_ID: 'other',
    COCKPIT_FRONTEND_MCP_URL: 'http://localhost:3011/mcp/frontend?cockpitId=tool-car',
  })
  assert.equal(JSON.parse(explicit.define['import.meta.env.VITE_COCKPIT_ID']), 'tool-car')
  const override = createCockpitViteConfig({ COCKPIT_ID: 'other', VITE_COCKPIT_ID: 'client-car' })
  assert.equal(JSON.parse(override.define['import.meta.env.VITE_COCKPIT_ID']), 'client-car')
  assert.equal(JSON.parse(createCockpitViteConfig({}).define['import.meta.env.VITE_COCKPIT_ID']), 'default')
})

test('vehicle snapshots, SSE updates and commands share the page Service proxy and cockpit', async t => {
  const harness = createHookHarness()
  const load = mockHookImports(t, { react: harness.react })
  const requests = []
  const events = []
  const initial = { version: 1, vehicle: { windowFL: 0 }, navigation: { status: 'idle' } }
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, options })
    return { ok: true, json: async () => initial }
  })
  const previousEventSource = Object.getOwnPropertyDescriptor(globalThis, 'EventSource')
  t.after(() => {
    if (previousEventSource) Object.defineProperty(globalThis, 'EventSource', previousEventSource)
    else delete globalThis.EventSource
  })
  globalThis.EventSource = class {
    constructor(url) {
      this.url = url
      this.listeners = {}
      events.push(this)
    }
    addEventListener(type, listener) { this.listeners[type] = listener }
    close() { this.closed = true }
  }
  const { default: useCockpitState } = await load(new URL('../src/hooks/useCockpitState.js', import.meta.url))
  t.after(() => harness.unmount())
  const render = () => harness.render(() => useCockpitState('multi-zone-validation'))
  render()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(requests[0].url, '/api/cockpit/state?cockpitId=multi-zone-validation')
  assert.equal(events[0].url, '/api/cockpit/events?cockpitId=multi-zone-validation')
  assert.equal(render().state.vehicle.windowFL, 0)
  events[0].listeners.state({ data: JSON.stringify({
    changed: ['vehicle'],
    state: { ...initial, version: 2, vehicle: { windowFL: 1 } },
  }) })
  assert.equal(render().state.vehicle.windowFL, 1)
  await render().execute('vehicle_window_control', { action: 'close', window: 'windowFL' })
  assert.equal(requests[1].url, '/api/cockpit/commands')
  assert.equal(JSON.parse(requests[1].options.body).cockpitId, 'multi-zone-validation')
})
