import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { CockpitService } from '../cockpit-service.mjs'
import { CustomSkillStore } from '../custom-skills/store.mjs'
import { CockpitStateStore } from '../state-store.mjs'

function fixture() {
  let timestamp = 1_700_000_000_000
  const activities = []
  const routeOrigins = []
  const store = new CockpitStateStore({ now: () => timestamp++ })
  const service = new CockpitService({
    store,
    now: () => timestamp++,
    random: () => 0.25,
    services: {
      async vehicleLocation() {
        return {
          name: '测试车位',
          city: '测试市',
          district: '测试区',
          address: '测试路1号',
          lng: 121.1,
          lat: 31.2,
        }
      },
      async resolvePlace(name) {
        return name === '不存在' ? null : name === '西湖' ? '120.1,30.2' : '120.2,30.3'
      },
      async drivingRoute(origin, destination) {
        routeOrigins.push(origin)
        return {
          origin,
          destination,
          distance: 12_300,
          duration: 1_500,
          polyline: `${origin};${destination}`,
          trafficSegments: [],
        }
      },
      async weather(city) {
        return { city, dayweather: '小雨', daytemp: '9', nighttemp: '5' }
      },
      async searchPlaces(query) {
        return [{ name: query, location: '120.3,30.4' }]
      },
      async searchNearbyPlaces({ keywords }) {
        return [{ name: keywords, location: '120.4,30.5', distance: 800 }]
      },
    },
  })
  return {
    service,
    activities,
    routeOrigins,
    options: { cockpitId: 'car-one', onActivity: event => activities.push(event) },
  }
}

test('queries a live vehicle location without changing unrelated cockpit state', async () => {
  const { service, options } = fixture()
  const output = await service.execute('vehicle_location_query', {}, options)

  assert.match(output.content, /测试车位/u)
  assert.deepEqual(output.changed, [])
  assert.equal(output.data.location.coordinates, '121.1,31.2')
  assert.equal(service.snapshot('car-one').location.source, 'vehicle')
})

test('keeps local navigation controls independent from the location adapter', async () => {
  let requests = 0
  const service = new CockpitService({
    services: {
      async vehicleLocation() {
        requests += 1
        return null
      },
    },
  })

  await service.execute('navigation_set_view', { viewMode: 'overview' })
  await service.execute('navigation_set_voice', { mute: true })
  await service.execute('navigation_stop', {})

  assert.equal(requests, 0)
})

test('keeps isolated authoritative state per cockpit', async () => {
  const { service } = fixture()
  await service.execute('vehicle_window_control', {
    action: 'open',
    window: 'windowFL',
  }, { cockpitId: 'car-one' })

  assert.equal(service.snapshot('car-one').vehicle.windowFL, 1)
  assert.equal(service.snapshot('car-two').vehicle.windowFL, 0)
})

test('validates climate bounds before mutating state', async () => {
  const { service, options } = fixture()
  const rejected = await service.execute('vehicle_climate_control', {
    action: 'set_temp',
    temperature: 40,
  }, options)
  assert.match(rejected.content, /16~32/)
  assert.equal(rejected.changed.length, 0)

  const accepted = await service.execute('vehicle_climate_control', {
    action: 'set_temp',
    temperature: 23,
  }, options)
  assert.equal(accepted.data.vehicle.acTemp, 23)
  assert.deepEqual(accepted.changed, ['vehicle'])
})

test('updates music state without returning UI actions', async () => {
  const { service, options } = fixture()
  const output = await service.execute('music_play', { query: '稻香' }, options)

  assert.match(output.content, /稻香/)
  assert.equal(output.data.music.playing, true)
  assert.equal(output.data.music.playlist[output.data.music.currentIndex].title, '稻香')
  assert.equal('actions' in output, false)
})

test('projects navigation progress and route state separately', async () => {
  const { service, activities, options, routeOrigins } = fixture()
  const output = await service.execute('navigation_start', {
    destination: '西湖',
    waypoints: ['黄龙体育中心', '城西银泰'],
  }, options)

  assert.equal(output.data.navigation.status, 'navigating')
  assert.match(output.content, /已开始导航到西湖/u)
  assert.deepEqual(output.data.navigation.waypoints, ['黄龙体育中心', '城西银泰'])
  assert.equal(output.data.navigation.map.markers.length, 3)
  assert.equal(output.data.navigation.map.polylines.length, 3)
  assert.equal(routeOrigins[0], '121.1,31.2')
  assert.deepEqual(activities.map(event => event.status), [
    'searching_destination',
    'destination_locked',
    'searching_waypoint',
    'waypoint_locked',
    'searching_waypoint',
    'waypoint_locked',
    'planning_route',
    'navigation_started',
  ])
})

test('persists a route preference before a destination is selected', async () => {
  const { service, options } = fixture()
  const preference = await service.execute('navigation_set_route_strategy', {
    strategy: 13,
  }, options)
  assert.match(preference.content, /后续路线偏好设为高速优先/u)
  assert.equal(preference.data.navigation.strategy, 13)

  const route = await service.execute('navigation_start', {
    destination: '西湖',
  }, options)
  assert.equal(route.data.navigation.strategy, 13)
})

test('publishes scenario activity independently from the call observer', async () => {
  const { service, options } = fixture()
  const published = []
  const unsubscribe = service.subscribeActivity(
    'car-one',
    event => published.push(event),
  )
  await service.execute('navigation_start', { destination: '西湖' }, options)
  unsubscribe()

  assert.deepEqual(published.map(event => event.status), [
    'searching_destination',
    'destination_locked',
    'planning_route',
    'navigation_started',
  ])
  assert.ok(published.every(event => (
    event.type === 'cockpit.activity'
    && event.cockpitId === 'car-one'
    && event.category === 'navigation'
  )))
})

test('queries the current route without requiring another destination', async () => {
  const { service, options } = fixture()
  const empty = await service.execute('navigation_route_query', {}, options)
  assert.match(empty.content, /没有进行中的导航/u)
  assert.deepEqual(empty.changed, [])

  await service.execute('navigation_start', { destination: '西湖' }, options)
  const current = await service.execute('navigation_route_query', {}, options)
  assert.match(current.content, /当前正导航到西湖/u)
  assert.match(current.content, /12\.3公里/u)
  assert.deepEqual(current.changed, [])
  assert.equal(current.data.navigation.status, 'navigating')
})

test('updates an active navigation route with waypoints destination and strategy', async () => {
  const { service, options } = fixture()
  await service.execute('navigation_start', { destination: '西湖' }, options)

  const added = await service.execute('navigation_add_waypoint', {
    waypoint: '城西银泰',
  }, options)
  assert.match(added.content, /已增加途经点城西银泰/u)
  assert.deepEqual(added.data.navigation.waypoints, ['城西银泰'])
  assert.equal(added.data.navigation.map.markers.length, 2)
  assert.equal(added.data.navigation.map.polylines.length, 2)

  const changed = await service.execute('navigation_change_destination', {
    destination: '萧山机场',
  }, options)
  assert.match(changed.content, /已将目的地改为萧山机场/u)
  assert.equal(changed.data.navigation.destination, '萧山机场')
  assert.deepEqual(changed.data.navigation.waypoints, ['城西银泰'])

  const strategy = await service.execute('navigation_set_route_strategy', {
    strategy: 5,
  }, options)
  assert.match(strategy.content, /不走高速/u)
  assert.equal(strategy.data.navigation.strategy, 5)

  const removed = await service.execute('navigation_remove_waypoint', {
    waypoint: '城西银泰',
  }, options)
  assert.match(removed.content, /已删除途经点城西银泰/u)
  assert.deepEqual(removed.data.navigation.waypoints, [])
  assert.equal(removed.data.navigation.map.markers.length, 1)
})

test('supports place search favorites voice and view navigation tools', async () => {
  const { service, options } = fixture()
  const search = await service.execute('navigation_search_place', {
    query: '充电站',
    nearby: true,
  }, options)
  assert.match(search.content, /找到1个地点/u)
  assert.equal(search.data.results[0].name, '充电站')
  assert.deepEqual(search.changed, [])

  const favorite = await service.execute('navigation_set_favorite', {
    favoriteType: 'home',
    address: '西湖',
  }, options)
  assert.match(favorite.content, /设置为家/u)
  assert.equal(favorite.data.navigation.favorites.home.label, '家')
  assert.equal(favorite.data.navigation.favorites.home.name, '西湖')
  assert.equal(favorite.data.navigation.favorites.home.address, '西湖')

  const home = await service.execute('navigation_to_favorite', {
    favoriteType: 'home',
  }, options)
  assert.match(home.content, /已开始导航到西湖/u)
  assert.equal(home.data.navigation.status, 'navigating')

  const voice = await service.execute('navigation_set_voice', {
    mute: true,
    broadcastMode: 'brief',
  }, options)
  assert.match(voice.content, /导航静音/u)
  assert.equal(voice.data.navigation.voice.muted, true)
  assert.equal(voice.data.navigation.voice.broadcastMode, 'brief')

  const view = await service.execute('navigation_set_view', {
    viewMode: 'overview',
  }, options)
  assert.match(view.content, /路线全览/u)
  assert.equal(view.data.navigation.viewMode, 'overview')

  const invalidVoice = await service.execute('navigation_set_voice', {
    broadcastMode: 'verbose',
  }, options)
  assert.match(invalidVoice.content, /有效的导航播报模式/u)
  assert.equal(invalidVoice.data.navigation.voice.broadcastMode, 'brief')

  const invalidView = await service.execute('navigation_set_view', {
    viewMode: 'bird_eye',
  }, options)
  assert.match(invalidView.content, /有效的导航视图模式/u)
  assert.equal(invalidView.data.navigation.viewMode, 'overview')
})

test('requires a preview and explicit confirmation before ordering', async () => {
  const { service, activities, options } = fixture()
  const premature = await service.execute('flashbuy', {
    action: 'confirm_order',
    confirmed: true,
  }, options)
  assert.match(premature.content, /还没有可确认/)

  const cart = await service.execute('flashbuy', {
    action: 'add_to_cart',
    query: '奶茶',
  }, options)
  assert.equal(cart.data.requireConfirm, true)
  assert.deepEqual(activities.map(event => event.status), [
    'flashbuy_searching',
    'flashbuy_results_ready',
    'flashbuy_adding',
    'flashbuy_previewing',
    'flashbuy_preview_ready',
  ])

  const unconfirmed = await service.execute('flashbuy', {
    action: 'confirm_order',
    confirmed: false,
  }, options)
  assert.equal(unconfirmed.data.requireConfirm, true)

  const completed = await service.execute('flashbuy', {
    action: 'confirm_order',
    confirmed: true,
  }, options)
  assert.equal(completed.data.order.id, 'SG3250')
  assert.deepEqual(activities.slice(-2).map(event => event.status), [
    'flashbuy_ordering',
    'flashbuy_order_completed',
  ])

  const duplicate = await service.execute('flashbuy', {
    action: 'confirm_order',
    confirmed: true,
  }, options)
  assert.equal(duplicate.data.duplicate, true)
  assert.equal(duplicate.data.order.id, completed.data.order.id)
})

test('publishes versioned snapshots after state changes', async () => {
  const { service, options } = fixture()
  const events = []
  const unsubscribe = service.subscribe('car-one', event => events.push(event))
  await service.execute('weather', { city: '杭州' }, options)
  unsubscribe()

  assert.equal(events.length, 1)
  assert.deepEqual(events[0].changed, ['weather'])
  assert.equal(events[0].state.weather.dayweather, '小雨')
  assert.equal(events[0].version, events[0].state.version)
})

test('resets cockpit state and publishes a full state update', async () => {
  const { service, options } = fixture()
  await service.execute('navigation_set_favorite', {
    favoriteType: 'home',
    address: '西湖',
  }, options)
  await service.execute('music_play', { query: '稻香' }, options)

  const events = []
  const unsubscribe = service.subscribe('car-one', event => events.push(event))
  const reset = service.reset('car-one')
  unsubscribe()

  assert.equal(reset.version, 1)
  assert.equal(reset.navigation.favorites.home, null)
  assert.equal(reset.music.playing, false)
  assert.deepEqual(events.at(-1).changed, [
    'vehicle',
    'location',
    'navigation',
    'music',
    'flashbuy',
    'weather',
  ])
  assert.equal(events.at(-1).state.navigation.status, 'idle')
})

test('stores custom skills outside transient cockpit state and publishes catalog changes', async t => {
  const root = await mkdtemp(resolve(tmpdir(), 'qwen-cockpit-service-skills-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const customSkills = new CustomSkillStore({ root })
  const { service, options } = fixture()
  service.customSkills = customSkills
  const published = []
  const unsubscribe = service.subscribeActivity('car-one', event => published.push(event))

  const created = await service.execute('custom_skill_create', {
    name: '下班回家',
    description: '导航、音乐和空调',
    instructions: '依次导航回家、播放音乐并把空调调到 23 度。',
  }, options)
  assert.equal(created.changed.length, 0)
  assert.equal(service.snapshot('car-one').version, 1)
  assert.equal((await service.listSkills('car-one'))[0].name, '下班回家')

  const loaded = await service.execute('custom_skill_load', {
    skill_name: '下班回家',
  }, options)
  assert.match(loaded.content, /custom_skill_instructions/u)
  assert.match(loaded.content, /23 度/u)
  assert.equal('instructions' in loaded.data.skill, false)

  await service.deleteSkill('car-one', created.data.skill.id)
  unsubscribe()
  assert.deepEqual(published.map(event => event.status), [
    'skills_changed',
    'skills_changed',
  ])
  assert.deepEqual(await service.listSkills('car-one'), [])
})
