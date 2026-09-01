import assert from 'node:assert/strict'
import test from 'node:test'
import { applyCockpitStateUpdate } from '../src/projections/cockpit-state.js'

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
