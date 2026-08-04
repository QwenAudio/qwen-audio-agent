import assert from 'node:assert/strict'
import test from 'node:test'
import {
  clampWindowBounds,
  defaultWindowBounds,
} from '../src/window-placement.mjs'

const displays = [
  {
    id: 1,
    workArea: { x: 0, y: 0, width: 1920, height: 1040 },
    scaleFactor: 1,
  },
  {
    id: 2,
    workArea: { x: -1280, y: 120, width: 1280, height: 984 },
    scaleFactor: 1.25,
  },
]

test('places a new orb at the primary top-right with fixed dimensions', () => {
  assert.deepEqual(defaultWindowBounds({
    kind: 'orb',
    display: displays[0],
  }), {
    x: 1724,
    y: 24,
    width: 172,
    height: 170,
  })
})

test('keeps the complete fixed-size orb visible on the nearest current display', () => {
  assert.deepEqual(clampWindowBounds({
    kind: 'orb',
    bounds: { x: -1400, y: 1080, width: 400, height: 300 },
    displays,
  }), {
    x: -1280,
    y: 934,
    width: 172,
    height: 170,
  })
})

test('moves a window from a disconnected monitor to the nearest remaining work area', () => {
  const result = clampWindowBounds({
    kind: 'settings',
    bounds: { x: 2500, y: 200, width: 540, height: 860 },
    displays: [displays[0]],
  })
  assert.deepEqual(result, {
    x: 1380,
    y: 200,
    width: 540,
    height: 860,
  })
})

test('resizes oversized settings and repair windows while keeping a title bar visible', () => {
  assert.deepEqual(clampWindowBounds({
    kind: 'repair',
    bounds: { x: -3000, y: -900, width: 2000, height: 1400 },
    displays: [displays[1]],
  }), {
    x: -1280,
    y: 120,
    width: 1280,
    height: 984,
  })
  const partiallyOffscreen = clampWindowBounds({
    kind: 'settings',
    bounds: { x: 100, y: 1025, width: 540, height: 860 },
    displays: [displays[0]],
  })
  assert.equal(partiallyOffscreen.y, 1008)
  assert.equal(partiallyOffscreen.height, 860)
})

test('rejects absent displays and ignores invalid saved bounds', () => {
  assert.throws(() => clampWindowBounds({
    kind: 'orb',
    bounds: null,
    displays: [],
  }), /display/i)
  assert.deepEqual(clampWindowBounds({
    kind: 'orb',
    bounds: { x: Number.NaN, y: 20, width: 172, height: 170 },
    displays,
  }), defaultWindowBounds({ kind: 'orb', display: displays[0] }))
})
