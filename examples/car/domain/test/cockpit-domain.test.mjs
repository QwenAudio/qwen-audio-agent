import assert from 'node:assert/strict'
import test from 'node:test'
import { CockpitDomain } from '../cockpit-domain.mjs'
import { CockpitStateStore } from '../state-store.mjs'

function fixture() {
  let timestamp = 1_700_000_000_000
  const activities = []
  const store = new CockpitStateStore({ now: () => timestamp++ })
  const domain = new CockpitDomain({
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
    domain,
    activities,
    options: { cockpitId: 'car-one', onActivity: event => activities.push(event) },
  }
}

test('keeps isolated authoritative state per cockpit', async () => {
  const { domain } = fixture()
  await domain.execute('vehicle_window_control', {
    action: 'open',
    window: 'windowFL',
  }, { cockpitId: 'car-one' })

  assert.equal(domain.snapshot('car-one').vehicle.windowFL, 1)
  assert.equal(domain.snapshot('car-two').vehicle.windowFL, 0)
})

test('validates climate bounds before mutating state', async () => {
  const { domain, options } = fixture()
  const rejected = await domain.execute('vehicle_climate_control', {
    action: 'set_temp',
    temperature: 40,
  }, options)
  assert.match(rejected.content, /16~32/)
  assert.equal(rejected.changed.length, 0)

  const accepted = await domain.execute('vehicle_climate_control', {
    action: 'set_temp',
    temperature: 23,
  }, options)
  assert.equal(accepted.data.vehicle.acTemp, 23)
  assert.deepEqual(accepted.changed, ['vehicle'])
})

test('updates music state without returning UI actions', async () => {
  const { domain, options } = fixture()
  const output = await domain.execute('music_play', { query: '稻香' }, options)

  assert.match(output.content, /稻香/)
  assert.equal(output.data.music.playing, true)
  assert.equal(output.data.music.playlist[output.data.music.currentIndex].title, '稻香')
  assert.equal('actions' in output, false)
})

test('projects navigation progress and route state separately', async () => {
  const { domain, activities, options } = fixture()
  const output = await domain.execute('navigation_start', {
    destination: '西湖',
    via: '黄龙体育中心',
  }, options)

  assert.equal(output.data.navigation.status, 'navigating')
  assert.equal(output.data.navigation.map.markers.length, 2)
  assert.equal(output.data.navigation.map.polylines.length, 2)
  assert.deepEqual(activities.map(event => event.status), [
    'searching_destination',
    'planning_route',
    'navigation_started',
  ])
})

test('queries the current route without requiring another destination', async () => {
  const { domain, options } = fixture()
  const empty = await domain.execute('navigation_route_query', {}, options)
  assert.match(empty.content, /没有进行中的导航/u)
  assert.deepEqual(empty.changed, [])

  await domain.execute('navigation_start', { destination: '西湖' }, options)
  const current = await domain.execute('navigation_route_query', {}, options)
  assert.match(current.content, /当前正导航到西湖/u)
  assert.match(current.content, /12\.3公里/u)
  assert.deepEqual(current.changed, [])
  assert.equal(current.data.navigation.status, 'navigating')
})

test('requires a preview and explicit confirmation before ordering', async () => {
  const { domain, options } = fixture()
  const premature = await domain.execute('flashbuy', {
    action: 'confirm_order',
    confirmed: true,
  }, options)
  assert.match(premature.content, /还没有可确认/)

  const cart = await domain.execute('flashbuy', {
    action: 'add_to_cart',
    query: '奶茶',
  }, options)
  assert.equal(cart.data.requireConfirm, true)

  const unconfirmed = await domain.execute('flashbuy', {
    action: 'confirm_order',
    confirmed: false,
  }, options)
  assert.equal(unconfirmed.data.requireConfirm, true)

  const completed = await domain.execute('flashbuy', {
    action: 'confirm_order',
    confirmed: true,
  }, options)
  assert.equal(completed.data.order.id, 'SG3250')

  const duplicate = await domain.execute('flashbuy', {
    action: 'confirm_order',
    confirmed: true,
  }, options)
  assert.equal(duplicate.data.duplicate, true)
  assert.equal(duplicate.data.order.id, completed.data.order.id)
})

test('publishes versioned snapshots after state changes', async () => {
  const { domain, options } = fixture()
  const events = []
  const unsubscribe = domain.subscribe('car-one', event => events.push(event))
  await domain.execute('weather', { city: '杭州' }, options)
  unsubscribe()

  assert.equal(events.length, 1)
  assert.deepEqual(events[0].changed, ['weather'])
  assert.equal(events[0].state.weather.dayweather, '小雨')
  assert.equal(events[0].version, events[0].state.version)
})
