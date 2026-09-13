import assert from 'node:assert/strict'
import test from 'node:test'
import { CockpitService } from '../../service/cockpit-service.mjs'
import { CockpitServiceServer } from '../../service/server.mjs'
import { FRONTEND_TOOL_NAMES } from '../../service/tools/registry.mjs'
import { createCockpitFrontendMcpConfiguration } from '../profile-bundle.mjs'
import { FrontendMcpClient } from '../../../../server/src/frontend/tools/mcp/frontend-mcp-client.mjs'
import {
  normalizeFrontendMcpConfiguration,
} from '../../../../server/src/frontend/tools/mcp/frontend-mcp-config.mjs'

test('calls selected cockpit tools inline through the frontend MCP client', async t => {
  const service = new CockpitService({
    services: {
      async vehicleLocation() {
        return { city: '杭州市', district: '余杭区', address: '文一西路969号', lng: 120.1, lat: 30.2 }
      },
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
    configuration: normalizeFrontendMcpConfiguration(
      createCockpitFrontendMcpConfiguration({
        frontendMcpUrl: `${server.origin}/mcp/frontend`,
      }),
    ),
  })
  t.after(() => client.close())

  const tools = await client.initialize()
  assert.deepEqual(
    tools.map(tool => tool.name),
    FRONTEND_TOOL_NAMES.map(name => `mcp__cockpit__${name}`),
  )
  const navigationTool = tools.find(tool => tool.name === 'mcp__cockpit__navigation_start')
  assert.match(navigationTool.definition.function.description, /调用前先用一句简短自然口语/u)
  assert.match(navigationTool.definition.function.description, /随后在同一轮立即调用工具/u)
  assert.match(navigationTool.definition.function.description, /同一请求只衔接一次/u)
  assert.match(navigationTool.definition.function.description, /规划过程中可以复述地点列表/u)
  assert.match(navigationTool.definition.function.description, /最终语音回复只播报总里程和预计耗时/u)
  assert.match(navigationTool.definition.function.description, /不复述目的地或途经点/u)
  assert.match(navigationTool.definition.function.description, /用户明确询问路线详情时再展开/u)
  const navigation = await client.execute('mcp__cockpit__navigation_start', {
    destination: '西湖',
    waypoints: ['五常地铁站', '城西银泰'],
  })
  assert.equal(navigation.text, '全程3.0公里，约6分钟')
  assert.equal(navigation.structured_content.navigation.destination, '西湖')
  assert.deepEqual(navigation.structured_content.navigation.waypoints, ['五常地铁站', '城西银泰'])
  assert.equal(navigation.structured_content.navigation.map.markers.length, 3)
  assert.equal(navigation.structured_content.navigation.map.polylines.length, 3)
  const route = await client.execute('mcp__cockpit__navigation_route_query', {})
  assert.match(route.text, /途经五常地铁站、城西银泰，全程3\.0公里，约6分钟/u)
  const output = await client.execute('mcp__cockpit__weather', { city: '杭州' })
  assert.match(output.text, /杭州，晴，27°/u)
  const location = await client.execute('mcp__cockpit__vehicle_location_query', {})
  assert.match(location.text, /文一西路969号/u)
  await client.execute('mcp__cockpit__vehicle_window_control', {
    action: 'open',
    window: 'windowFL',
  })
  await client.execute('mcp__cockpit__vehicle_light_control', {
    action: 'open',
    light: 'headlights',
  })
  await client.execute('mcp__cockpit__vehicle_sunroof_control', {
    action: 'open',
  })
  await client.execute('mcp__cockpit__vehicle_temperature_control', {
    action: 'set',
    temperature: 22,
  })
  const state = await client.execute('mcp__cockpit__vehicle_state_query', {
    part: 'all',
  })
  assert.match(state.text, /主驾车窗: 开启/u)
  assert.match(state.text, /大灯: 开启/u)
  await client.execute('mcp__cockpit__music_next', {})
  await client.execute('mcp__cockpit__music_previous', {})
  await client.execute('mcp__cockpit__music_volume_control', { action: 'set', volume: 7 })
  await client.execute('mcp__cockpit__music_source_control', { source: 'bluetooth' })
  await client.execute('mcp__cockpit__music_favorite_control', { action: 'add', query: '晴天' })
  const musicState = await client.execute('mcp__cockpit__music_state_query', { part: 'all' })
  assert.match(musicState.text, /当前来源蓝牙/u)
  await client.execute('mcp__cockpit__music_pause', {})
  assert.equal(service.snapshot().weather.daytemp, '27')
  assert.equal(service.snapshot().vehicle.windowFL, 1)
  assert.equal(service.snapshot().vehicle.sunroof, 1)
  assert.equal(service.snapshot().vehicle.headlights, 1)
  assert.equal(service.snapshot().vehicle.acTemp, 22)
  assert.equal(service.snapshot().music.volume, 7)
  assert.equal(service.snapshot().music.source, 'bluetooth')
  assert.deepEqual(service.snapshot().music.favoriteIds, ['sunny-day'])
})
