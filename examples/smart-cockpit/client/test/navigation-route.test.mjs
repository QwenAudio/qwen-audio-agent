import assert from 'node:assert/strict'
import test from 'node:test'
import { navigationRouteKey, navigationRouteView } from '../src/projections/navigation-route.js'

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
        {
          polyline: '120.2,30.2;120.3,30.3',
          trafficSegments: [],
        },
      ],
    },
    map: {
      markers: [
        { role: 'waypoint', index: 1, location: '120.2,30.2' },
        { role: 'waypoint', index: 0, location: '120.1,30.1' },
      ],
    },
  }), {
    status: 'navigating',
    destination: '西湖',
    distKm: '12.3',
    durationMin: 25,
    arrivalStr: '15:10',
    polyline: '120.0,30.0;120.1,30.1;120.2,30.2;120.3,30.3',
    trafficSegments: [{ status: '畅通', polyline: '120.0,30.0;120.1,30.1' }],
    waypointLocations: ['120.1,30.1', '120.2,30.2'],
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

test('keeps route key stable for voice and view changes', () => {
  const navigation = {
    status: 'navigating',
    destination: '西湖',
    viewMode: 'follow',
    voice: { muted: false, broadcastMode: 'standard' },
    route: {
      distKm: '12.3',
      durationMin: 25,
      arrival: '15:10',
      legs: [{ polyline: '120.0,30.0;120.1,30.1' }],
    },
    map: {
      markers: [{ role: 'destination', location: '120.1,30.1' }],
    },
  }
  assert.equal(navigationRouteKey(navigation), navigationRouteKey({
    ...navigation,
    viewMode: 'overview',
    voice: { muted: true, broadcastMode: 'brief' },
  }))
})
