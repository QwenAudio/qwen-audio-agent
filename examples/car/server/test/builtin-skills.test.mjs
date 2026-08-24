import assert from 'node:assert/strict'
import test from 'node:test'
import { builtinDomainCatalog } from '../skills/builtin/index.mjs'
import { tools, executors } from '../tools/index.mjs'

const splitFunctionNames = [
  'vehicle_state_query',
  'vehicle_window_control',
  'vehicle_sunroof_control',
  'vehicle_headlights_control',
  'vehicle_climate_control',
  'music_play',
  'music_pause',
  'music_next',
  'music_previous',
  'music_search',
  'navigation_start',
  'navigation_route_query',
  'navigation_stop',
  'flashbuy',
  'weather',
  'web_search',
]

test('registers split car domain functions instead of aggregate functions', () => {
  const names = tools.map(tool => tool.function.name)

  for (const name of splitFunctionNames) {
    assert.ok(names.includes(name), `missing ${name}`)
    assert.equal(typeof executors[name], 'function', `missing executor for ${name}`)
  }

  assert.equal(names.includes('vehicle_control'), false)
  assert.equal(names.includes('music'), false)
  assert.equal(names.includes('navigation'), false)
})

test('loads car domain functions from domain catalog', () => {
  const domains = new Map(builtinDomainCatalog.map(domain => [domain.domain, domain]))

  assert.deepEqual([...domains.keys()].sort(), ['flashbuy', 'music', 'navigation', 'vehicle', 'weather', 'web_search'])
  assert.deepEqual(domains.get('vehicle').functions.map(fn => fn.name), [
    'vehicle_state_query',
    'vehicle_window_control',
    'vehicle_sunroof_control',
    'vehicle_headlights_control',
    'vehicle_climate_control',
  ])
  assert.deepEqual(domains.get('navigation').functions.map(fn => fn.name), [
    'navigation_start',
    'navigation_route_query',
    'navigation_stop',
  ])
  assert.deepEqual(domains.get('music').functions.map(fn => fn.name), [
    'music_play',
    'music_pause',
    'music_next',
    'music_previous',
    'music_search',
  ])
  assert.deepEqual(domains.get('flashbuy').functions.map(fn => fn.name), ['flashbuy'])
  assert.deepEqual(domains.get('weather').functions.map(fn => fn.name), ['weather'])
  assert.deepEqual(domains.get('web_search').functions.map(fn => fn.name), ['web_search'])
  for (const domain of domains.values()) {
    for (const fn of domain.functions) {
      assert.deepEqual(Object.keys(fn).sort(), ['description', 'exposure', 'label', 'name'].sort())
    }
  }
})

test('vehicle window control keeps the existing multi-window action behavior', async () => {
  const result = await executors.vehicle_window_control(
    { action: 'open', window: 'windows' },
    {
      vehicleState: {
        windowFL: 0,
        windowFR: 0,
        windowRL: 0,
        windowRR: 0,
        sunroof: 0,
        headlights: 0,
        ac: 0,
      },
    },
  )

  assert.equal(result.actions.length, 4)
  assert.deepEqual(result.actions.map(action => action.part), ['windowFL', 'windowFR', 'windowRL', 'windowRR'])
  assert.deepEqual(result.actions.map(action => action.state), [1, 1, 1, 1])
  assert.equal(Object.hasOwn(result, 'subCalls'), false)
})

test('vehicle climate control maps temperature updates to the existing car control action', async () => {
  const result = await executors.vehicle_climate_control(
    { action: 'set_temp', temperature: 23 },
    {
      vehicleState: {
        ac: 1,
        acMode: 'cool',
        acTemp: 25,
        acFan: 3,
      },
    },
  )

  assert.deepEqual(result.actions, [
    { type: 'car_control', part: 'ac', state: 1, temperature: 23 },
  ])
})

test('music split functions preserve playback actions', async () => {
  const play = await executors.music_play({ query: '晴天' }, {})
  const pause = await executors.music_pause({}, {})
  const previous = await executors.music_previous({}, {})

  assert.deepEqual(play.action, { type: 'music', action: 'play', query: '晴天' })
  assert.deepEqual(pause.action, { type: 'music', action: 'pause' })
  assert.deepEqual(previous.action, { type: 'music', action: 'prev' })
})

test('navigation stop split function preserves navigation stop action', async () => {
  const mapActions = []
  const result = await executors.navigation_stop({}, { onMapEvent: action => mapActions.push(action) })

  assert.deepEqual(result.action, { type: 'navigation', action: 'stop' })
  assert.deepEqual(mapActions, [{ action: 'clear' }])
})

test('flashbuy domain function preserves search actions', async () => {
  const progress = []
  const result = await executors.flashbuy(
    { action: 'search', query: '奶茶' },
    { clientId: 'test-flashbuy-search', onProgress: event => progress.push(event) },
  )

  assert.match(result.result, /找到/)
  assert.deepEqual(result.actions.map(action => action.action), ['open', 'status', 'results'])
  assert.equal(result.actions[2].type, 'flashbuy')
  assert.equal(result.actions[2].category, 'tea')
  assert.equal(Object.hasOwn(result, 'subCalls'), false)
  assert.deepEqual(progress.map(event => event.stage), ['flashbuy_searching', 'flashbuy_results_ready'])
})

test('web search domain function validates required query before network calls', async () => {
  const result = await executors.web_search({}, {})

  assert.equal(result.result, '请提供要联网查询的问题')
})
