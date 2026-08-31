import assert from 'node:assert/strict'
import test from 'node:test'
import {
  A2ABackendAdapter,
} from '../../../../server/src/backend/a2a-backend-adapter.mjs'
import {
  CockpitServiceServer,
} from '../../service/server.mjs'
import { CockpitService } from '../../service/cockpit-service.mjs'
import { startCockpitAgentServer } from '../server.mjs'

function toolCall(name, args) {
  return {
    content: null,
    tool_calls: [{
      id: `call-${name}`,
      function: { name, arguments: JSON.stringify(args) },
    }],
  }
}

function cockpitModel() {
  return {
    async complete({ messages }) {
      const last = messages.at(-1)
      if (last.role === 'tool') return { content: last.content }
      const objective = last.content
      if (/空调/u.test(objective)) {
        return toolCall('vehicle_climate_control', { action: 'set_temp', temperature: 22 })
      }
      if (/五常地铁站/u.test(objective)) {
        return toolCall('navigation_start', {
          destination: '萧山机场',
          waypoints: ['五常地铁站', '城西银泰'],
        })
      }
      if (/杭州西湖/u.test(objective)) {
        return toolCall('navigation_start', { destination: '杭州西湖' })
      }
      if (/还有多久/u.test(objective)) return toolCall('navigation_route_query', {})
      if (/播放晴天/u.test(objective)) return toolCall('music_play', { query: '晴天' })
      if (/确认/u.test(objective)) {
        return toolCall('flashbuy', { action: 'confirm_order', confirmed: true })
      }
      if (/搜索|看看/u.test(objective) && /外卖|奶茶|黑椒牛肉饭/u.test(objective)) {
        return toolCall('flashbuy', {
          action: 'search',
          query: objective,
          category: /奶茶/u.test(objective) ? 'tea' : 'food',
        })
      }
      if (/帮我点|加入购物车|就这个|外卖|奶茶/u.test(objective)) {
        return toolCall('flashbuy', {
          action: 'add_to_cart',
          query: objective,
          category: /外卖/u.test(objective) ? 'food' : 'tea',
        })
      }
      return { content: '这个座舱 Agent 没有对应的工具。' }
    },
  }
}

test('runs core cockpit capabilities through A2A and MCP without UI actions', async t => {
  const cockpit = new CockpitService({
    random: () => 0.25,
    services: {
      async resolvePlace(name) {
        const locations = {
          杭州西湖: '120.1,30.2',
          五常地铁站: '120.02,30.25',
          城西银泰: '120.12,30.31',
          萧山机场: '120.43,30.24',
        }
        return locations[name] || null
      },
      async drivingRoute(origin, destination) {
        return {
          origin,
          destination,
          distance: 12_300,
          duration: 1_500,
          polyline: `${origin};${destination}`,
          trafficSegments: [],
        }
      },
    },
  })
  const service = new CockpitServiceServer({ service: cockpit, port: 0 })
  await service.start()
  t.after(() => service.close())
  const agent = await startCockpitAgentServer({
    port: 0,
    serviceOrigin: service.origin,
    model: cockpitModel(),
  })
  t.after(() => agent.close())
  const backend = new A2ABackendAdapter({
    agentCardUrl: agent.agentCardUrl,
    pollIntervalMs: 10,
  })
  t.after(() => backend.close())

  let task = 0
  const submit = objective => backend.submit({
    id: `gateway-task-${task += 1}`,
    ownerId: 'owner',
    objective,
  })

  const vehicle = await submit('空调调到二十二度')
  assert.match(vehicle.content, /空调当前开启.*22°C/u)
  assert.equal(vehicle.presentation, undefined)

  const navigation = await submit('导航到杭州西湖')
  assert.match(navigation.content, /已开始导航到杭州西湖/u)

  const multiStop = await submit('先去五常地铁站，再到城西银泰，最后去萧山机场')
  assert.match(multiStop.content, /已开始导航到萧山机场/u)
  assert.match(multiStop.content, /途经五常地铁站、城西银泰/u)

  const currentRoute = await submit('导航还有多久')
  assert.match(currentRoute.content, /当前正导航到萧山机场/u)

  const music = await submit('播放晴天')
  assert.match(music.content, /正在播放：晴天/u)

  const search = await submit('搜索附近的黑椒牛肉饭外卖')
  assert.match(search.content, /找到\d+个可送商品/u)

  let state = await fetch(`${service.origin}/api/cockpit/state?cockpitId=default`)
    .then(response => response.json())
  assert.equal(state.flashbuy.status, 'selecting')
  assert.equal(state.flashbuy.cartItems.length, 0)

  const cart = await submit('将刚才的黑椒牛肉饭加入购物车并生成订单预览')
  assert.match(cart.content, /订单预览/u)
  assert.match(cart.content, /黑椒牛肉饭/u)
  assert.match(cart.content, /确认是否下单/u)

  state = await fetch(`${service.origin}/api/cockpit/state?cockpitId=default`)
    .then(response => response.json())
  assert.equal(state.flashbuy.status, 'awaiting_confirm')
  assert.equal(state.flashbuy.cartItems.length, 1)
  assert.ok(state.flashbuy.preview)

  const order = await submit('确认这个外卖订单，下单吧')
  assert.match(order.content, /已下单/u)

  state = await fetch(`${service.origin}/api/cockpit/state?cockpitId=default`)
    .then(response => response.json())
  assert.equal(state.vehicle.acTemp, 22)
  assert.equal(state.navigation.status, 'navigating')
  assert.equal(state.navigation.destination, '萧山机场')
  assert.deepEqual(state.navigation.waypoints, ['五常地铁站', '城西银泰'])
  assert.equal(state.music.playing, true)
  assert.equal(state.music.playlist[state.music.currentIndex].title, '晴天')
  assert.match(state.flashbuy.order.id, /^SG/u)
})
