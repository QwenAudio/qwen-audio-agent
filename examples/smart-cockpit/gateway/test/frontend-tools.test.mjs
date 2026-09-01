import assert from 'node:assert/strict'
import test from 'node:test'
import { CockpitService } from '../../service/cockpit-service.mjs'
import { CockpitServiceServer } from '../../service/server.mjs'
import { FrontendMcpClient } from '../../../../server/src/providers/mcp/frontend-mcp-client.mjs'
import {
  normalizeFrontendMcpConfiguration,
} from '../../../../server/src/providers/mcp/frontend-mcp-config.mjs'

test('calls selected cockpit tools inline through the frontend MCP client', async t => {
  const service = new CockpitService({
    services: {
      async resolvePlace() { return '120.1,30.2' },
      async drivingRoute() {
        return { distance: 1_000, duration: 120, polyline: '120.0,30.0;120.1,30.2', trafficSegments: [] }
      },
      async weather(city) {
        return { city, dayweather: '晴', daytemp: '27' }
      },
    },
  })
  const server = new CockpitServiceServer({ service, port: 0 })
  await server.start()
  t.after(() => server.close())
  const client = new FrontendMcpClient({
    configuration: normalizeFrontendMcpConfiguration({
      version: 1,
      servers: {
        cockpit: {
          enabled: true,
          url: `${server.origin}/mcp/frontend`,
          tools: {
            weather: { enabled: true },
            vehicle_state_query: { enabled: true },
            vehicle_window_control: { enabled: true },
            vehicle_sunroof_control: { enabled: true },
            vehicle_headlights_control: { enabled: true },
            vehicle_climate_control: { enabled: true },
            navigation_set_route_strategy: { enabled: true },
            navigation_set_voice: { enabled: true },
            navigation_set_view: { enabled: true },
          },
        },
      },
    }),
  })
  t.after(() => client.close())

  const tools = await client.initialize()
  assert.deepEqual(tools.map(tool => tool.name), [
    'mcp__cockpit__weather',
    'mcp__cockpit__vehicle_state_query',
    'mcp__cockpit__vehicle_window_control',
    'mcp__cockpit__vehicle_sunroof_control',
    'mcp__cockpit__vehicle_headlights_control',
    'mcp__cockpit__vehicle_climate_control',
    'mcp__cockpit__navigation_set_route_strategy',
    'mcp__cockpit__navigation_set_voice',
    'mcp__cockpit__navigation_set_view',
  ])
  const output = await client.execute('mcp__cockpit__weather', { city: '杭州' })
  assert.match(output.text, /杭州，晴，27°/u)
  await client.execute('mcp__cockpit__vehicle_window_control', {
    action: 'open',
    window: 'windowFL',
  })
  await client.execute('mcp__cockpit__vehicle_headlights_control', {
    action: 'open',
  })
  await client.execute('mcp__cockpit__vehicle_sunroof_control', {
    action: 'open',
  })
  await client.execute('mcp__cockpit__vehicle_climate_control', {
    action: 'set_temp',
    temperature: 22,
  })
  const state = await client.execute('mcp__cockpit__vehicle_state_query', {
    part: 'all',
  })
  assert.match(state.text, /主驾车窗: 开启/u)
  assert.match(state.text, /大灯: 开启/u)
  await service.execute('navigation_start', { destination: '西湖' })
  const view = await client.execute('mcp__cockpit__navigation_set_view', {
    viewMode: 'overview',
  })
  assert.match(view.text, /路线全览/u)
  const strategy = await client.execute('mcp__cockpit__navigation_set_route_strategy', {
    strategy: 4,
  })
  assert.match(strategy.text, /躲避拥堵/u)
  const voice = await client.execute('mcp__cockpit__navigation_set_voice', {
    broadcastMode: 'brief',
  })
  assert.match(voice.text, /简洁播报/u)
  assert.equal(service.snapshot().weather.daytemp, '27')
  assert.equal(service.snapshot().vehicle.windowFL, 1)
  assert.equal(service.snapshot().vehicle.sunroof, 1)
  assert.equal(service.snapshot().vehicle.headlights, 1)
  assert.equal(service.snapshot().vehicle.acTemp, 22)
  assert.equal(service.snapshot().navigation.viewMode, 'overview')
  assert.equal(service.snapshot().navigation.strategy, 4)
  assert.equal(service.snapshot().navigation.voice.broadcastMode, 'brief')
})
