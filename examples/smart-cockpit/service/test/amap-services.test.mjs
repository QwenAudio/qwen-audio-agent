import assert from 'node:assert/strict'
import test from 'node:test'
import { createAmapCockpitServices } from '../integrations/amap/services.mjs'

test('falls back to geocoding when place search is temporarily unavailable', async () => {
  const calls = []
  const services = createAmapCockpitServices({
    async search(name, city) {
      calls.push(['search', name, city])
      throw new TypeError('fetch failed')
    },
    async encode(name, city) {
      calls.push(['geocode', name, city])
      return '120.1,30.2'
    },
  })

  assert.equal(await services.resolvePlace('西湖', '杭州'), '120.1,30.2')
  assert.deepEqual(calls, [
    ['search', '西湖', '杭州'],
    ['geocode', '西湖', '杭州'],
  ])
})
