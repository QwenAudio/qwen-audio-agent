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
  const store = new CockpitStateStore({ now: () => timestamp++ })
  const service = new CockpitService({
    store,
    now: () => timestamp++,
    random: () => 0.25,
    services: {
      async resolvePlace(name) {
        return name === '不存在' ? null : name === '西湖' ? '120.1,30.2' : '120.2,30.3'
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
      async weather(city) {
        return { city, dayweather: '小雨', daytemp: '9', nighttemp: '5' }
      },
    },
  })
  return {
    service,
    activities,
    options: { cockpitId: 'car-one', onActivity: event => activities.push(event) },
  }
}

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
  const { service, activities, options } = fixture()
  const output = await service.execute('navigation_start', {
    destination: '西湖',
    waypoints: ['黄龙体育中心', '城西银泰'],
  }, options)

  assert.equal(output.data.navigation.status, 'navigating')
  assert.match(output.content, /已开始导航到西湖/u)
  assert.deepEqual(output.data.navigation.waypoints, ['黄龙体育中心', '城西银泰'])
  assert.equal(output.data.navigation.map.markers.length, 3)
  assert.equal(output.data.navigation.map.polylines.length, 3)
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
