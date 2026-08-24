import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DESKTOP_ORB_HEIGHT,
  DESKTOP_ORB_WIDTH,
  DESKTOP_PANEL_HEIGHT,
  DESKTOP_PANEL_WIDTH,
  DESKTOP_TASK_SURFACE_WIDTH,
  desktopConversationPanelBounds,
  desktopOrbAnchorFromPanel,
  desktopOrbBounds,
  desktopSurfaceLayout,
  desktopSurfaceSize,
  desktopTaskPlacement,
} from '../src/desktop-surface-layout.mjs'

const workArea = { x: 0, y: 0, width: 1200, height: 800 }

test('expands a panel from the orb anchor and restores that anchor', () => {
  const orbBounds = { x: 1000, y: 40, width: 172, height: 204 }
  const panel = desktopConversationPanelBounds({ orbBounds, workArea })
  assert.deepEqual(panel, {
    x: 732,
    y: 40,
    width: DESKTOP_PANEL_WIDTH,
    height: DESKTOP_PANEL_HEIGHT,
  })
  assert.deepEqual(desktopOrbAnchorFromPanel({
    bounds: panel,
    workArea,
  }), orbBounds)
})

test('keeps the conversation panel and restored orb inside a small display', () => {
  const smallArea = { x: -800, y: 20, width: 360, height: 540 }
  const panel = desktopConversationPanelBounds({
    orbBounds: { x: -500, y: 500, width: 172, height: 204 },
    workArea: smallArea,
  })
  assert.deepEqual(panel, {
    x: -800,
    y: 20,
    width: 360,
    height: 540,
  })
  assert.deepEqual(desktopOrbAnchorFromPanel({
    bounds: panel,
    workArea: smallArea,
  }), {
    x: -612,
    y: 20,
    width: DESKTOP_ORB_WIDTH,
    height: DESKTOP_ORB_HEIGHT,
  })
})

test('keeps the compact orb surface without task cards', () => {
  assert.deepEqual(desktopSurfaceSize(0), {
    width: DESKTOP_ORB_WIDTH,
    height: DESKTOP_ORB_HEIGHT,
  })
})

test('sizes task cards to the available side of the orb', () => {
  assert.deepEqual(desktopSurfaceSize(2, { taskAreaHeight: 696 }), {
    width: DESKTOP_TASK_SURFACE_WIDTH,
    height: 322,
  })
  assert.deepEqual(desktopSurfaceSize(20, { taskAreaHeight: 496 }), {
    width: DESKTOP_TASK_SURFACE_WIDTH,
    height: 700,
  })
})

test('places cards above an orb near the bottom of the display', () => {
  const result = desktopSurfaceLayout({
    bounds: { x: 900, y: 570, width: 172, height: 204 },
    taskCount: 2,
    workArea,
  })
  assert.equal(result.placement, 'above')
  assert.deepEqual(result.bounds, {
    x: 806,
    y: 452,
    width: 360,
    height: 322,
  })
  assert.deepEqual(desktopOrbBounds(result.bounds, {
    taskCount: 2,
    placement: result.placement,
    orbOffsetX: result.orbOffsetX,
  }), { x: 900, y: 570, width: 172, height: 204 })
})

test('places cards below an orb near the top of the display', () => {
  const result = desktopSurfaceLayout({
    bounds: { x: 900, y: 24, width: 172, height: 204 },
    taskCount: 2,
    placement: 'above',
    workArea,
  })
  assert.equal(result.placement, 'below')
  assert.deepEqual(result.bounds, {
    x: 806,
    y: 24,
    width: 360,
    height: 322,
  })
})

test('keeps the current side when both sides have enough room', () => {
  const orbBounds = { x: 500, y: 300, width: 172, height: 204 }
  assert.equal(desktopTaskPlacement({
    orbBounds,
    workArea,
    taskCount: 2,
    placement: 'above',
  }), 'above')
  assert.equal(desktopTaskPlacement({
    orbBounds,
    workArea,
    taskCount: 2,
    placement: 'below',
  }), 'below')
})

test('uses the screen half when cards fit on either side', () => {
  const tallWorkArea = { x: 0, y: 0, width: 1200, height: 1200 }
  assert.equal(desktopTaskPlacement({
    orbBounds: { x: 500, y: 650, width: 172, height: 204 },
    workArea: tallWorkArea,
    taskCount: 2,
    placement: 'below',
  }), 'above')
  assert.equal(desktopTaskPlacement({
    orbBounds: { x: 500, y: 150, width: 172, height: 204 },
    workArea: tallWorkArea,
    taskCount: 2,
    placement: 'above',
  }), 'below')
})

test('keeps the orb anchored when task cards collapse', () => {
  const result = desktopSurfaceLayout({
    bounds: { x: 806, y: 452, width: 360, height: 322 },
    currentTaskCount: 2,
    taskCount: 0,
    placement: 'above',
    orbOffsetX: 94,
    workArea,
  })
  assert.deepEqual(result.bounds, {
    x: 900,
    y: 570,
    width: DESKTOP_ORB_WIDTH,
    height: DESKTOP_ORB_HEIGHT,
  })
})

test('offsets cards instead of moving an orb near either screen edge', () => {
  const left = desktopSurfaceLayout({
    bounds: { x: 12, y: 24, width: 172, height: 204 },
    taskCount: 2,
    workArea,
  })
  assert.equal(left.bounds.x, 0)
  assert.equal(left.orbOffsetX, 12)
  assert.equal(desktopOrbBounds(left.bounds, {
    taskCount: 2,
    placement: left.placement,
    orbOffsetX: left.orbOffsetX,
  }).x, 12)

  const right = desktopSurfaceLayout({
    bounds: { x: 1016, y: 24, width: 172, height: 204 },
    taskCount: 2,
    workArea,
  })
  assert.equal(right.bounds.x, 840)
  assert.equal(right.orbOffsetX, 176)
  assert.equal(desktopOrbBounds(right.bounds, {
    taskCount: 2,
    placement: right.placement,
    orbOffsetX: right.orbOffsetX,
  }).x, 1016)
})

test('uses the larger side and caps the stack when neither side fits', () => {
  const result = desktopSurfaceLayout({
    bounds: { x: 500, y: 350, width: 172, height: 204 },
    taskCount: 20,
    placement: 'below',
    workArea,
  })
  assert.equal(result.placement, 'above')
  assert.equal(result.bounds.y, 0)
  assert.equal(result.bounds.height, 554)
})
