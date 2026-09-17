import assert from 'node:assert/strict'
import test from 'node:test'
import {
  navigationProgressMarker,
  navigationRouteCompletionViewMode,
  navigationRouteKey,
  navigationRouteView,
} from '../src/projections/navigation-route.js'

test('projects authoritative navigation state into the map view contract', () => {
  assert.deepEqual(navigationRouteView({
    status: 'navigating',
    destination: '西湖',
    destinationLocation: '120.3,30.3',
    waypoints: ['黄龙体育中心', '城西银泰'],
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
        { role: 'destination', name: '西湖', location: '120.3,30.3' },
        { role: 'waypoint', index: 1, name: '城西银泰', location: '120.2,30.2' },
        { role: 'waypoint', index: 0, name: '黄龙体育中心', location: '120.1,30.1' },
      ],
    },
  }), {
    status: 'navigating',
    destination: '西湖',
    destinationLocation: '120.3,30.3',
    waypoints: ['黄龙体育中心', '城西银泰'],
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

test('projects navigation progress semantic anchors into preview markers', () => {
  assert.deepEqual(navigationProgressMarker({
    domain: 'navigation',
    stage: 'waypoint_locked',
    item: {
      role: 'waypoint',
      index: 1,
      name: '城西银泰',
      location: '120.2,30.2',
    },
  }), {
    role: 'waypoint',
    index: 1,
    name: '城西银泰',
    location: '120.2,30.2',
  })

  assert.deepEqual(navigationProgressMarker({
    domain: 'navigation',
    stage: 'destination_locked',
    item: {
      role: 'destination',
      name: '西湖',
      location: '120.3,30.3',
    },
  }), {
    role: 'destination',
    index: null,
    name: '西湖',
    location: '120.3,30.3',
  })

  assert.equal(navigationProgressMarker({
    domain: 'navigation',
    stage: 'searching_waypoint',
    item: { role: 'waypoint', location: '120.1,30.1' },
  }), null)
})

test('settles completed route animation on the full route overview', () => {
  assert.equal(navigationRouteCompletionViewMode({
    polyline: '120.0,30.0;120.1,30.1;120.2,30.2',
  }), 'overview')

  assert.equal(navigationRouteCompletionViewMode({
    destinationLocation: '120.2,30.2',
  }), 'destination')
})
