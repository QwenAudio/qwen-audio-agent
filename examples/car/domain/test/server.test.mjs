import assert from 'node:assert/strict'
import test from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { CockpitDomain } from '../cockpit-domain.mjs'
import { CockpitDomainServer } from '../server.mjs'

function domainFixture() {
  return new CockpitDomain({
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
  const server = new CockpitDomainServer({ domain: domainFixture(), port: 0 })
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
  const server = new CockpitDomainServer({ domain: domainFixture(), port: 0 })
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

test('exposes the same domain operations through MCP', async t => {
  const server = new CockpitDomainServer({ domain: domainFixture(), port: 0 })
  await server.start()
  t.after(() => server.close())
  const client = new Client({ name: 'cockpit-domain-test', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(
    new URL(`${server.origin}/mcp?cockpitId=mcp-car`),
  )
  await client.connect(transport)
  t.after(() => client.close())

  const tools = await client.listTools()
  assert.equal(tools.tools.length, 15)
  assert.ok(tools.tools.some(tool => tool.name === 'vehicle_climate_control'))
  assert.ok(tools.tools.some(tool => tool.name === 'flashbuy'))

  const output = await client.callTool({
    name: 'vehicle_climate_control',
    arguments: { action: 'set_temp', temperature: 22 },
  })
  assert.equal(output.isError, undefined)
  assert.equal(output.structuredContent.vehicle.acTemp, 22)

  const state = await fetch(`${server.origin}/api/cockpit/state?cockpitId=mcp-car`)
    .then(response => response.json())
  assert.equal(state.vehicle.acTemp, 22)
})
