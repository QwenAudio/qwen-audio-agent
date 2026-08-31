import assert from 'node:assert/strict'
import test from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { CockpitService } from '../cockpit-service.mjs'
import { CockpitServiceServer } from '../server.mjs'

function serviceFixture() {
  return new CockpitService({
    services: {
      async resolvePlace() { return '120.1,30.2' },
      async drivingRoute() {
        return { distance: 1_000, duration: 120, polyline: 'a;b', trafficSegments: [] }
      },
      async weather(city) { return { city, dayweather: '晴', daytemp: '25' } },
    },
  })
}

async function readSseEvent(reader, eventName) {
  const decoder = new TextDecoder()
  let buffered = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) throw new Error(`SSE stream closed before ${eventName}`)
    buffered += decoder.decode(value, { stream: true })
    const frames = buffered.split('\n\n')
    buffered = frames.pop() || ''
    const frame = frames.find(item => item.startsWith(`event: ${eventName}\n`))
    if (!frame) continue
    const data = frame.split('\n').find(line => line.startsWith('data: '))
    return JSON.parse(data.slice(6))
  }
}

test('serves state and commands over the scenario HTTP boundary', async t => {
  const server = new CockpitServiceServer({ service: serviceFixture(), port: 0 })
  await server.start()
  t.after(() => server.close())

  const health = await fetch(`${server.origin}/health`).then(response => response.json())
  assert.equal(health.ok, true)

  const command = await fetch(`${server.origin}/api/cockpit/commands`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cockpitId: 'http-car',
      name: 'vehicle_headlights_control',
      arguments: { action: 'open' },
    }),
  }).then(response => response.json())
  assert.deepEqual(command.changed, ['vehicle'])

  const state = await fetch(`${server.origin}/api/cockpit/state?cockpitId=http-car`)
    .then(response => response.json())
  assert.equal(state.vehicle.headlights, 1)
})

test('streams authoritative state changes to cockpit panels', async t => {
  const server = new CockpitServiceServer({ service: serviceFixture(), port: 0 })
  await server.start()
  t.after(() => server.close())
  const controller = new AbortController()
  t.after(() => controller.abort())
  const response = await fetch(
    `${server.origin}/api/cockpit/events?cockpitId=stream-car`,
    { signal: controller.signal },
  )
  const reader = response.body.getReader()
  const snapshot = await readSseEvent(reader, 'snapshot')
  assert.equal(snapshot.vehicle.windowFL, 0)

  const updatePromise = readSseEvent(reader, 'state')
  await fetch(`${server.origin}/api/cockpit/commands`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cockpitId: 'stream-car',
      name: 'vehicle_window_control',
      arguments: { action: 'open', window: 'windowFL' },
    }),
  })
  const update = await updatePromise
  assert.deepEqual(update.changed, ['vehicle'])
  assert.equal(update.state.vehicle.windowFL, 1)
  await reader.cancel()
})

test('streams navigation activity to the scenario UI', async t => {
  const server = new CockpitServiceServer({ service: serviceFixture(), port: 0 })
  await server.start()
  t.after(() => server.close())
  const controller = new AbortController()
  t.after(() => controller.abort())
  const response = await fetch(
    `${server.origin}/api/cockpit/events?cockpitId=progress-car`,
    { signal: controller.signal },
  )
  const reader = response.body.getReader()
  await readSseEvent(reader, 'snapshot')

  const activityPromise = readSseEvent(reader, 'activity')
  const commandPromise = fetch(`${server.origin}/api/cockpit/commands`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cockpitId: 'progress-car',
      name: 'navigation_start',
      arguments: { destination: '西湖' },
    }),
  })
  const activity = await activityPromise
  await commandPromise

  assert.equal(activity.category, 'navigation')
  assert.equal(activity.status, 'searching_destination')
  assert.equal(activity.message, '正在查找目的地')
  await reader.cancel()
})

test('streams flash-buy activity that lets the client open the Taobao panel', async t => {
  const server = new CockpitServiceServer({ service: serviceFixture(), port: 0 })
  await server.start()
  t.after(() => server.close())
  const controller = new AbortController()
  t.after(() => controller.abort())
  const response = await fetch(
    `${server.origin}/api/cockpit/events?cockpitId=flashbuy-car`,
    { signal: controller.signal },
  )
  const reader = response.body.getReader()
  await readSseEvent(reader, 'snapshot')

  const activityPromise = readSseEvent(reader, 'activity')
  const commandPromise = fetch(`${server.origin}/api/cockpit/commands`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cockpitId: 'flashbuy-car',
      name: 'flashbuy',
      arguments: { action: 'add_to_cart', query: '外卖', category: 'food' },
    }),
  })
  const activity = await activityPromise
  await commandPromise

  assert.equal(activity.category, 'flashbuy')
  assert.equal(activity.status, 'flashbuy_searching')
  assert.equal(activity.message, '正在查找附近可送商品')
  await reader.cancel()
})

test('separates frontend and backend tools across standard MCP surfaces', async t => {
  const server = new CockpitServiceServer({ service: serviceFixture(), port: 0 })
  await server.start()
  t.after(() => server.close())
  const backend = new Client({ name: 'cockpit-backend-test', version: '1.0.0' })
  await backend.connect(new StreamableHTTPClientTransport(
    new URL(`${server.origin}/mcp/backend?cockpitId=mcp-car`),
  ))
  t.after(() => backend.close())
  const frontend = new Client({ name: 'cockpit-frontend-test', version: '1.0.0' })
  await frontend.connect(new StreamableHTTPClientTransport(
    new URL(`${server.origin}/mcp/frontend?cockpitId=mcp-car`),
  ))
  t.after(() => frontend.close())

  const backendTools = await backend.listTools()
  assert.equal(backendTools.tools.length, 14)
  assert.ok(backendTools.tools.some(tool => tool.name === 'vehicle_climate_control'))
  assert.ok(backendTools.tools.some(tool => tool.name === 'flashbuy'))
  assert.ok(!backendTools.tools.some(tool => tool.name === 'weather'))

  const frontendTools = await frontend.listTools()
  assert.deepEqual(frontendTools.tools.map(tool => tool.name), ['weather'])

  const output = await backend.callTool({
    name: 'vehicle_climate_control',
    arguments: { action: 'set_temp', temperature: 22 },
  })
  assert.equal(output.isError, undefined)
  assert.equal(output.structuredContent.vehicle.acTemp, 22)

  const weather = await frontend.callTool({
    name: 'weather',
    arguments: { city: '杭州' },
  })
  assert.equal(weather.isError, undefined)
  assert.match(weather.content[0].text, /杭州，晴，25°/u)

  const unavailable = await frontend.callTool({
    name: 'vehicle_state_query',
    arguments: {},
  })
  assert.equal(unavailable.isError, true)
  assert.match(unavailable.content[0].text, /not available on this MCP surface/u)

  const state = await fetch(`${server.origin}/api/cockpit/state?cockpitId=mcp-car`)
    .then(response => response.json())
  assert.equal(state.vehicle.acTemp, 22)
  assert.equal(state.weather.dayweather, '晴')
})

test('does not expose an ambiguous combined MCP endpoint', async t => {
  const server = new CockpitServiceServer({ service: serviceFixture(), port: 0 })
  await server.start()
  t.after(() => server.close())
  const response = await fetch(`${server.origin}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  })
  assert.equal(response.status, 404)
})
