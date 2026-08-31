import assert from 'node:assert/strict'
import test from 'node:test'
import {
  A2ABackendAdapter,
} from '../../../../server/src/backend/a2a-backend-adapter.mjs'
import {
  CockpitDomainServer,
} from '../../domain/server.mjs'
import { CockpitDomain } from '../../domain/cockpit-domain.mjs'
import { startCockpitAgentServer } from '../server.mjs'

test('runs core cockpit capabilities through A2A and MCP without UI actions', async t => {
  const cockpit = new CockpitDomain({
    random: () => 0.25,
    services: {
      async resolvePlace(name) {
        return name === '杭州西湖' ? '120.1,30.2' : null
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
  const domain = new CockpitDomainServer({ domain: cockpit, port: 0 })
  await domain.start()
  t.after(() => domain.close())
  const agent = await startCockpitAgentServer({
    port: 0,
    domainOrigin: domain.origin,
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

  const vehicle = await submit('打开主驾车窗')
  assert.match(vehicle.content, /已打开主驾车窗/u)
  assert.equal(vehicle.presentation, undefined)

  const navigation = await submit('导航到杭州西湖')
  assert.match(navigation.content, /已规划到杭州西湖/u)

  const currentRoute = await submit('导航还有多久')
  assert.match(currentRoute.content, /当前正导航到杭州西湖/u)

  const music = await submit('播放晴天')
  assert.match(music.content, /正在播放：晴天/u)

  const cart = await submit('帮我买杯奶茶')
  assert.match(cart.content, /订单预览/u)
  assert.match(cart.content, /确认是否下单/u)

  const order = await submit('确认这个奶茶订单，下单吧')
  assert.match(order.content, /已下单/u)

  const state = await fetch(`${domain.origin}/api/cockpit/state?cockpitId=default`)
    .then(response => response.json())
  assert.equal(state.vehicle.windowFL, 1)
  assert.equal(state.navigation.status, 'navigating')
  assert.equal(state.navigation.destination, '杭州西湖')
  assert.equal(state.music.playing, true)
  assert.equal(state.music.playlist[state.music.currentIndex].title, '晴天')
  assert.match(state.flashbuy.order.id, /^SG/u)
})
