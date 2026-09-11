import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ROUTE_FLOW_DURATION_MS,
  routeFlowFrame,
} from '../src/projections/route-flow.js'

test('plays the route highlight once and reaches a terminal frame', () => {
  const points = Array.from({ length: 100 }, (_, index) => index)
  const start = routeFlowFrame(points, 0)
  const middle = routeFlowFrame(points, ROUTE_FLOW_DURATION_MS / 2)
  const end = routeFlowFrame(points, ROUTE_FLOW_DURATION_MS)
  const afterEnd = routeFlowFrame(points, ROUTE_FLOW_DURATION_MS * 3)

  assert.equal(start.done, false)
  assert.equal(middle.done, false)
  assert.ok(middle.path[0] > start.path[0])
  assert.equal(end.done, true)
  assert.deepEqual(afterEnd, end)
  assert.equal(end.path.at(-1), points.at(-1))
})

test('handles short and missing routes without scheduling an endless animation', () => {
  assert.deepEqual(routeFlowFrame([], 0), { path: [], done: true })
  assert.deepEqual(routeFlowFrame([1, 2, 3], ROUTE_FLOW_DURATION_MS), {
    path: [1, 2, 3],
    done: true,
  })
})
