import assert from 'node:assert/strict'
import test from 'node:test'
import { navigationRouteView } from '../react-app/src/navigation-route.js'

test('projects authoritative navigation state into the map view contract', () => {
  assert.deepEqual(navigationRouteView({
    status: 'navigating',
    destination: '西湖',
    route: {
      distKm: '12.3',
      durationMin: 25,
      arrival: '15:10',
      legs: [
        {
          polyline: '120.0,30.0;120.1,30.1',
          trafficSegments: [{ status: '畅通', polyline: '120.0,30.0;120.1,30.1' }],
        },
        {
          polyline: '120.1,30.1;120.2,30.2',
          trafficSegments: [],
        },
      ],
    },
    map: {
      markers: [{ role: 'via', location: '120.1,30.1' }],
    },
  }), {
    status: 'navigating',
    destination: '西湖',
    distKm: '12.3',
    durationMin: 25,
    arrivalStr: '15:10',
    polyline: '120.0,30.0;120.1,30.1;120.2,30.2',
    trafficSegments: [{ status: '畅通', polyline: '120.0,30.0;120.1,30.1' }],
    viaLocation: '120.1,30.1',
  })
})

test('supports route previews and ignores idle navigation', () => {
  assert.equal(navigationRouteView({ status: 'idle', route: null }), null)
  assert.equal(navigationRouteView({
    status: 'preview',
    destination: '西湖',
    route: { legs: [] },
  }).status, 'preview')
})
