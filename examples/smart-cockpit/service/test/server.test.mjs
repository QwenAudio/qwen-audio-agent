import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { CockpitService } from '../cockpit-service.mjs'
import { CustomSkillStore } from '../custom-skills/store.mjs'
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

  const reset = await fetch(`${server.origin}/api/cockpit/reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cockpitId: 'http-car' }),
  }).then(response => response.json())
  assert.equal(reset.vehicle.headlights, 0)
  assert.equal(reset.navigation.status, 'idle')
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

test('scopes frontend tools while retaining a complete backend MCP surface', async t => {
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
  assert.equal(backendTools.tools.length, 28)
  assert.ok(backendTools.tools.some(tool => tool.name === 'vehicle_climate_control'))
  assert.ok(backendTools.tools.some(tool => tool.name === 'flashbuy'))
  assert.ok(backendTools.tools.some(tool => tool.name === 'weather'))
  assert.ok(backendTools.tools.some(tool => tool.name === 'vehicle_window_control'))
  assert.ok(backendTools.tools.some(tool => tool.name === 'vehicle_headlights_control'))
  assert.ok(backendTools.tools.some(tool => tool.name === 'vehicle_location_query'))
  assert.ok(backendTools.tools.some(tool => tool.name === 'custom_skill_create'))

  const frontendTools = await frontend.listTools()
  assert.deepEqual(frontendTools.tools.map(tool => tool.name), [
    'weather',
    'vehicle_location_query',
    'vehicle_state_query',
    'vehicle_window_control',
    'vehicle_sunroof_control',
    'vehicle_headlights_control',
    'vehicle_climate_control',
    'navigation_set_route_strategy',
    'navigation_set_voice',
    'navigation_set_view',
    'navigation_stop',
    'music_pause',
    'music_next',
    'music_previous',
  ])

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

  const location = await frontend.callTool({
    name: 'vehicle_location_query',
    arguments: {},
  })
  assert.equal(location.isError, undefined)
  assert.match(location.content[0].text, /云谷园区/u)

  const window = await frontend.callTool({
    name: 'vehicle_window_control',
    arguments: { action: 'open', window: 'windowFL' },
  })
  assert.equal(window.isError, undefined)
  assert.equal(window.structuredContent.vehicle.windowFL, 1)

  const sunroof = await frontend.callTool({
    name: 'vehicle_sunroof_control',
    arguments: { action: 'open' },
  })
  assert.equal(sunroof.isError, undefined)
  assert.equal(sunroof.structuredContent.vehicle.sunroof, 1)

  const climate = await frontend.callTool({
    name: 'vehicle_climate_control',
    arguments: { action: 'set_fan', fan: 4 },
  })
  assert.equal(climate.isError, undefined)
  assert.equal(climate.structuredContent.vehicle.acFan, 4)

  await backend.callTool({
    name: 'navigation_start',
    arguments: { destination: '西湖' },
  })
  const view = await frontend.callTool({
    name: 'navigation_set_view',
    arguments: { viewMode: 'overview' },
  })
  assert.equal(view.isError, undefined)
  assert.equal(view.structuredContent.navigation.viewMode, 'overview')
  const strategy = await frontend.callTool({
    name: 'navigation_set_route_strategy',
    arguments: { strategy: 4 },
  })
  assert.equal(strategy.isError, undefined)
  assert.equal(strategy.structuredContent.navigation.strategy, 4)

  const pause = await frontend.callTool({
    name: 'music_pause',
    arguments: {},
  })
  assert.equal(pause.isError, undefined)
  const stopped = await frontend.callTool({
    name: 'navigation_stop',
    arguments: {},
  })
  assert.equal(stopped.isError, undefined)

  const state = await fetch(`${server.origin}/api/cockpit/state?cockpitId=mcp-car`)
    .then(response => response.json())
  assert.equal(state.vehicle.acTemp, 22)
  assert.equal(state.vehicle.acFan, 4)
  assert.equal(state.vehicle.sunroof, 1)
  assert.equal(state.vehicle.windowFL, 1)
  assert.equal(state.weather.dayweather, '晴')
  assert.equal(state.navigation.viewMode, 'overview')
  assert.equal(state.navigation.strategy, 4)
  assert.equal(state.navigation.status, 'idle')
})

test('serves persistent custom skill management to the scenario UI', async t => {
  const root = await mkdtemp(resolve(tmpdir(), 'qwen-cockpit-http-skills-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const service = serviceFixture()
  service.customSkills = new CustomSkillStore({ root })
  const server = new CockpitServiceServer({ service, port: 0 })
  await server.start()
  t.after(() => server.close())

  const backend = new Client({ name: 'cockpit-skill-test', version: '1.0.0' })
  await backend.connect(new StreamableHTTPClientTransport(
    new URL(`${server.origin}/mcp/backend?cockpitId=skill-car`),
  ))
  t.after(() => backend.close())
  await backend.callTool({
    name: 'custom_skill_create',
    arguments: {
      name: '下班回家',
      description: '导航、音乐和空调',
      instructions: '依次导航回家、播放音乐并调节空调。',
    },
  })

  const skills = await fetch(`${server.origin}/api/cockpit/skills?cockpitId=skill-car`)
    .then(response => response.json())
  assert.equal(skills.length, 1)
  assert.equal(skills[0].name, '下班回家')

  const detail = await fetch(
    `${server.origin}/api/cockpit/skills/${skills[0].id}?cockpitId=skill-car`,
  ).then(response => response.json())
  assert.match(detail.instructions, /调节空调/u)

  const deleted = await fetch(
    `${server.origin}/api/cockpit/skills/${skills[0].id}?cockpitId=skill-car`,
    { method: 'DELETE' },
  ).then(response => response.json())
  assert.equal(deleted.id, skills[0].id)
  assert.deepEqual(
    await fetch(`${server.origin}/api/cockpit/skills?cockpitId=skill-car`)
      .then(response => response.json()),
    [],
  )
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
