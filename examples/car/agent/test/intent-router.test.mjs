import assert from 'node:assert/strict'
import test from 'node:test'
import { planCockpitTool } from '../intent-router.mjs'

test('routes representative cockpit requests to existing MCP tools', () => {
  assert.deepEqual(planCockpitTool('打开主驾车窗'), {
    name: 'vehicle_window_control',
    arguments: { action: 'open', window: 'windowFL' },
  })
  assert.deepEqual(planCockpitTool('空调调到22度'), {
    name: 'vehicle_climate_control',
    arguments: { action: 'set_temp', temperature: 22 },
  })
  assert.deepEqual(planCockpitTool('导航到杭州西湖'), {
    name: 'navigation_start',
    arguments: { destination: '杭州西湖' },
  })
  assert.deepEqual(planCockpitTool('导航还有多久'), {
    name: 'navigation_route_query',
    arguments: {},
  })
  assert.deepEqual(planCockpitTool('播放晴天'), {
    name: 'music_play',
    arguments: { query: '晴天' },
  })
  assert.equal(planCockpitTool('杭州天气怎么样'), null)
})

test('keeps explicit order confirmation separate from product search', () => {
  assert.deepEqual(planCockpitTool('确认这个奶茶订单，下单吧'), {
    name: 'flashbuy',
    arguments: { action: 'confirm_order', confirmed: true },
  })
  assert.equal(planCockpitTool('帮我写一份年度计划'), null)
})
