import assert from 'node:assert/strict'
import test from 'node:test'
import { CockpitStateStore } from '../state-store.mjs'
import { executeNavigationTool } from '../tools/navigation/execute.mjs'

function fixture(services = {}, { navigating = false } = {}) {
  const store = new CockpitStateStore({ now: () => 1_700_000_000_000 })
  const cockpitId = 'place-search-car'
  const activities = []
  store.update(cockpitId, ['location', 'navigation'], state => {
    state.location.coordinates = '121.1,31.2'
    if (navigating) {
      state.navigation = {
        ...state.navigation,
        status: 'navigating',
        destination: '目的地',
        destinationLocation: '121.3,31.4',
        waypoints: ['途经点'],
        waypointLocations: ['121.2,31.3'],
        strategy: 4,
        route: { distance: 5000, duration: 600, distKm: '5.0', durationMin: 10 },
        map: {
          markers: [{ role: 'destination', name: '目的地', location: '121.3,31.4' }],
          polylines: [{ segment: 0, polyline: '121.1,31.2;121.3,31.4' }],
        },
      }
    }
  })
  const context = {
    cockpitId,
    services,
    store,
    now: () => 1_700_000_000_000,
    snapshot: () => store.snapshot(cockpitId),
    onActivity: event => activities.push(event),
  }
  return {
    activities,
    snapshot: context.snapshot,
    search: args => executeNavigationTool('navigation_search_place', args, context),
  }
}

test('nearby search returns actual restaurant details with the current origin and radius', async () => {
  const calls = []
  const places = [
    { id: 'poi-1', name: '川味小馆（测试路店）', address: '测试路18号', location: '121.101,31.201', distance: 650, type: '餐饮服务;中餐厅' },
    { id: 'poi-2', name: '街角面馆', address: '测试路28号', location: '121.102,31.202', distance: '900' },
  ]
  const { search } = fixture({
    async searchNearbyPlaces(args) {
      calls.push(args)
      return places
    },
    async searchPlaces() { assert.fail('nearby search must not use city search') },
    async resolvePlace() { assert.fail('POI search must not use geocoding') },
  })

  const output = await search({ query: '川菜', category: 'restaurant', nearby: true, radius: 1800 })

  assert.deepEqual(calls, [{ keywords: '川菜', location: '121.1,31.2', radius: 1800 }])
  assert.deepEqual(output.data.results, places)
  assert.equal(output.data.status, 'ok')
  assert.match(output.content, /川味小馆（测试路店）/u)
  assert.match(output.content, /测试路18号/u)
  assert.match(output.content, /650米/u)
  assert.match(output.content, /街角面馆/u)
  assert.deepEqual(output.changed, [])
})

test('city search preserves actual POIs and queries without passing category as a provider type', async () => {
  const calls = []
  const places = [{ name: '同名店', location: '120.1,30.2', address: '真实地址1号' }]
  const { search } = fixture({
    async searchPlaces(query, options) {
      calls.push({ query, options })
      return places
    },
    async resolvePlace() { assert.fail('POI search must not resolve a query to coordinates') },
  })

  const output = await search({ query: '同名店', category: '餐饮服务' })

  assert.deepEqual(calls, [{ query: '同名店', options: { city: '杭州' } }])
  assert.deepEqual(output.data.results, places)
  assert.equal(output.data.status, 'ok')
})

test('the existing restaurant category alias is a keyword fallback, never a provider type', async () => {
  const calls = []
  const { search } = fixture({
    async searchNearbyPlaces(args) {
      calls.push(['nearby', args])
      return []
    },
    async searchPlaces(query, options) {
      calls.push(['city', query, options])
      return []
    },
  })

  await search({ category: 'restaurant', nearby: true })
  await search({ category: 'restaurant' })
  await search({ query: '川菜', category: 'restaurant', nearby: true })

  assert.deepEqual(calls, [
    ['nearby', { keywords: '餐厅', location: '121.1,31.2', radius: 3000 }],
    ['city', '餐厅', { city: '杭州' }],
    ['nearby', { keywords: '川菜', location: '121.1,31.2', radius: 3000 }],
  ])
})

for (const nearby of [false, true]) {
  test(`empty ${nearby ? 'nearby' : 'city'} POI results never become a query-named place from geocoding`, async () => {
    let resolveCalls = 0
    const { search, snapshot } = fixture({
      async searchPlaces() { return [] },
      async searchNearbyPlaces() { return [] },
      async resolvePlace() {
        resolveCalls += 1
        return '120.1,30.2'
      },
    }, { navigating: true })
    const before = snapshot()

    const output = await search({ query: '麻辣餐厅', nearby })

    assert.equal(resolveCalls, 0)
    assert.deepEqual(output.data.results, [])
    assert.equal(output.data.status, 'empty')
    assert.equal(output.content, '没有找到“麻辣餐厅”相关地点')
    assert.deepEqual(output.changed, [])
    assert.deepEqual(snapshot(), before)
  })
}

test('nearby search uses its default radius without changing preference keywords', async () => {
  const calls = []
  const { search } = fixture({
    async searchNearbyPlaces(args) {
      calls.push(args)
      return []
    },
  })

  await search({ query: '酸辣口味餐厅', nearby: true })

  assert.deepEqual(calls, [{ keywords: '酸辣口味餐厅', location: '121.1,31.2', radius: 3000 }])
})

test('missing nearby support is unavailable and never falls back to a city search', async () => {
  const { search, activities } = fixture({
    async searchPlaces() { assert.fail('must not silently expand a nearby search to the city') },
    async resolvePlace() { assert.fail('must not fabricate a place from coordinates') },
  })

  const output = await search({ query: '餐厅', nearby: true })

  assert.equal(output.data.status, 'error')
  assert.equal(output.data.error_code, 'place_search_unavailable')
  assert.deepEqual(output.data.results, [])
  assert.match(output.content, /附近地点搜索服务暂不可用/u)
  assert.doesNotMatch(output.content, /没有找到|找到\d+个/u)
  assert.equal(activities.at(-1).status, 'place_search_failed')
})

test('missing city search support returns unavailable without geocoding', async () => {
  const { search } = fixture({
    async resolvePlace() { assert.fail('must not fabricate a place from coordinates') },
  })

  const output = await search({ query: '餐厅' })

  assert.equal(output.data.status, 'error')
  assert.equal(output.data.error_code, 'place_search_unavailable')
  assert.deepEqual(output.data.results, [])
  assert.match(output.content, /地点搜索服务暂不可用/u)
})

test('nameless and unusable candidates are dropped instead of being named after the query', async () => {
  const realPlace = { name: '实际小馆', address: '测试路6号', distance: 0 }
  const { search } = fixture({
    async searchNearbyPlaces() {
      return [
        null,
        '121.1,31.2',
        { location: '121.1,31.2' },
        { name: '   ', location: '121.1,31.2' },
        { name: ['不是地点名'], location: '121.1,31.2' },
        { name: '只有名称' },
        { name: '无效坐标', location: 'not,coordinates' },
        { name: '越界坐标', location: '200,95' },
        { name: '空坐标', location: ',' },
        realPlace,
      ]
    },
    async resolvePlace() { assert.fail('must not fill missing candidate details from geocoding') },
  })

  const output = await search({ query: '偏好关键词', nearby: true })

  assert.deepEqual(output.data.results, [realPlace])
  assert.match(output.content, /实际小馆（测试路6号，距离0米）/u)
  assert.doesNotMatch(output.content, /偏好关键词/u)
})

test('successful POI searches leave an active route and all navigation controls untouched', async () => {
  const { search, snapshot } = fixture({
    async searchNearbyPlaces() { return [{ name: '实际餐厅', location: '121.12,31.23' }] },
    async drivingRoute() { assert.fail('search must not replan an active route') },
    async resolvePlace() { assert.fail('search must not resolve an active destination') },
  }, { navigating: true })
  const before = snapshot()

  const output = await search({ query: '餐厅', nearby: true })

  assert.equal(output.data.status, 'ok')
  assert.equal(output.stateVersion, before.version)
  assert.deepEqual(output.changed, [])
  assert.deepEqual(snapshot(), before)
})

test('a named POI with a real provider ID remains usable without inventing address or distance', async () => {
  const place = { id: 'real-poi-id', name: '实际店铺' }
  const { search } = fixture({ async searchNearbyPlaces() { return [place] } })
  const output = await search({ query: '餐厅', nearby: true })
  assert.deepEqual(output.data.results, [place])
  assert.equal(output.data.status, 'ok')
  assert.equal(output.content, '找到1个地点：实际店铺')
})

for (const nearby of [false, true]) {
  test(`${nearby ? 'nearby' : 'city'} search errors are unavailable, not empty or fabricated success`, async () => {
    const fail = async () => { throw new Error('provider unavailable') }
    const { search, snapshot, activities } = fixture({
      searchPlaces: fail,
      searchNearbyPlaces: fail,
      async resolvePlace() { assert.fail('search failures must not trigger geocoding') },
    }, { navigating: true })
    const before = snapshot()

    const output = await search({ query: '餐厅', nearby })

    assert.equal(output.data.status, 'error')
    assert.equal(output.data.error_code, 'place_search_unavailable')
    assert.deepEqual(output.data.results, [])
    assert.match(output.content, /搜索服务暂不可用/u)
    assert.doesNotMatch(output.content, /没有找到|找到\d+个/u)
    assert.equal(activities.at(-1).status, 'place_search_failed')
    assert.deepEqual(snapshot(), before)
  })
}

test('malformed search responses are unavailable instead of being treated as no results', async () => {
  for (const response of [null, undefined, {}, { pois: [] }]) {
    const { search } = fixture({ async searchNearbyPlaces() { return response } })

    const output = await search({ query: '餐厅', nearby: true })

    assert.equal(output.data.status, 'error')
    assert.equal(output.data.error_code, 'place_search_unavailable')
    assert.deepEqual(output.data.results, [])
  }
})
