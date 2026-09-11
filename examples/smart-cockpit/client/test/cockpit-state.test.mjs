import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyCockpitStateUpdate,
  clearNavigationSession,
  hasActiveNavigationSession,
} from '../src/projections/cockpit-state.js'

function state(version, overrides = {}) {
  return {
    version,
    updatedAt: version * 100,
    vehicle: { ac: 1 },
    navigation: { status: 'navigating', destination: '西湖' },
    music: { playing: false },
    weather: { city: '杭州市', dayweather: '多云' },
    ...overrides,
  }
}

test('weather updates preserve unrelated panel state identities', () => {
  const previous = state(1)
  const incoming = state(2, {
    weather: { city: '杭州市', dayweather: '晴' },
  })

  const next = applyCockpitStateUpdate(previous, {
    changed: ['weather'],
    state: incoming,
  })

  assert.equal(next.version, 2)
  assert.equal(next.updatedAt, 200)
  assert.equal(next.weather, incoming.weather)
  assert.equal(next.navigation, previous.navigation)
  assert.equal(next.vehicle, previous.vehicle)
  assert.equal(next.music, previous.music)
})

test('falls back to a full snapshot replacement without change metadata', () => {
  const previous = state(1)
  const incoming = state(2)

  assert.equal(applyCockpitStateUpdate(previous, { state: incoming }), incoming)
  assert.equal(applyCockpitStateUpdate(null, { changed: ['weather'], state: incoming }), incoming)
})

test('clears transient navigation session state without dropping navigation preferences', () => {
  const active = state(3, {
    navigation: {
      status: 'navigating',
      destination: '西湖',
      destinationLocation: '120.1,30.2',
      waypoints: ['武林广场'],
      waypointLocations: ['120.2,30.3'],
      strategy: 2,
      route: { distKm: 8.2 },
      map: { markers: [{ role: 'destination' }], polylines: [{ path: [] }] },
      favorites: { home: { name: '家' } },
      voice: { muted: true, broadcastMode: 'brief' },
      viewMode: 'overview',
    },
  })

  assert.equal(hasActiveNavigationSession(active), true)
  const cleared = clearNavigationSession(active)
  assert.equal(cleared.navigation.status, 'idle')
  assert.equal(cleared.navigation.destination, null)
  assert.equal(cleared.navigation.route, null)
  assert.deepEqual(cleared.navigation.waypoints, [])
  assert.deepEqual(cleared.navigation.map, { markers: [], polylines: [] })
  assert.equal(cleared.navigation.strategy, 2)
  assert.deepEqual(cleared.navigation.favorites, { home: { name: '家' } })
  assert.deepEqual(cleared.navigation.voice, { muted: true, broadcastMode: 'brief' })
  assert.equal(cleared.navigation.viewMode, 'overview')
})

test('leaves an idle navigation snapshot unchanged', () => {
  const idle = state(4, {
    navigation: {
      status: 'idle',
      destination: null,
      route: null,
      strategy: 1,
    },
  })

  assert.equal(hasActiveNavigationSession(idle), false)
  assert.equal(clearNavigationSession(idle), idle)
})
