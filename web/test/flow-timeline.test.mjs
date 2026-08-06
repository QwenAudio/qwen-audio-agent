import assert from 'node:assert/strict'
import test from 'node:test'

import {
  FLOW_LAYERS,
  anomalyIndexMap,
  buildFlowRows,
  flowEventLabel,
  flowEventSummary,
  flowLayerLabel,
  formatOffset,
} from '../src/flow-timeline.js'

const T0 = 1_000_000

function flow(events) {
  return { flowId: 'f1', events: events.map(e => ({ ...e, at: T0 + e.offset })) }
}

test('builds one row per event, in the order they happened', () => {
  const { rows, durationMs, layerCounts } = buildFlowRows(flow([
    { layer: 'frontstage', type: 'turn.started', offset: 0 },
    { layer: 'gateway', type: 'task.accepted', offset: 300, taskId: 'w1' },
    { layer: 'backend', type: 'acp.request', offset: 600 },
  ]))

  assert.deepEqual(rows.map(row => row.type),
    ['turn.started', 'task.accepted', 'acp.request'])
  assert.deepEqual(rows.map(row => row.offsetMs), [0, 300, 600])
  assert.equal(durationMs, 600)
  assert.deepEqual(layerCounts, { frontstage: 1, gateway: 1, backend: 1 })
})

test('reads event names as sentences and keeps the raw type', () => {
  assert.equal(flowEventLabel('task.permission.requested'), '向用户请求授权')
  assert.equal(flowEventLabel('acp.request'), '向后台发起调用')
  // An unmapped type is shown as-is rather than hidden.
  assert.equal(flowEventLabel('something.new'), 'something.new')

  const { rows } = buildFlowRows(flow([
    { layer: 'gateway', type: 'task.running', offset: 0 },
  ]))
  assert.equal(rows[0].label, '任务开始执行')
  assert.equal(rows[0].type, 'task.running', 'the grep-able name survives')
})

test('summarises the field that matters for each kind of event', () => {
  assert.match(flowEventSummary({ detail: { method: 'session/prompt', rpcId: 4 } }),
    /session\/prompt/)
  assert.match(flowEventSummary({ detail: { elapsedMs: 9061 } }), /9061ms/)
  assert.match(flowEventSummary({ detail: { name: 'spawn_thinking' } }), /spawn_thinking/)
  // The attribution and the dangling listener are the evidence for the
  // misattributed-permission failure, so they belong on the row itself.
  const summary = flowEventSummary({
    detail: { attributedToRun: 'work_1', listenerStillAttached: true },
  })
  assert.match(summary, /归属 work_1/)
  assert.match(summary, /监听仍挂着/)
  assert.equal(flowEventSummary({}), '')
  assert.equal(flowEventSummary(), '')
})

test('collapses a run of identical events into one row with a count', () => {
  const { rows } = buildFlowRows(flow([
    { layer: 'gateway', type: 'task.progress', offset: 0 },
    { layer: 'gateway', type: 'task.progress', offset: 100 },
    { layer: 'gateway', type: 'task.progress', offset: 200 },
    { layer: 'gateway', type: 'task.completed', offset: 300 },
  ]))
  assert.equal(rows.length, 2, 'nothing is learned from reading the same line twice')
  assert.equal(rows[0].repeated, 3)
  assert.equal(rows[1].repeated, 1)
})

test('does not collapse across a long pause or over a finding', () => {
  const paused = buildFlowRows(flow([
    { layer: 'backend', type: 'acp.request', offset: 0 },
    { layer: 'backend', type: 'acp.request', offset: 30_000 },
  ]))
  assert.equal(paused.rows.length, 2, 'a 30s gap is not the same moment')

  const flagged = buildFlowRows(flow([
    { layer: 'gateway', type: 'task.permission.requested', offset: 0 },
    { layer: 'gateway', type: 'task.permission.requested', offset: 100 },
  ]), [{ rule: 'permission-unanswered', severity: 'error', eventIndexes: [1] }])
  assert.equal(flagged.rows.length, 2, 'an accused event keeps its own row')
})

test('marks the long waits, which is where failures hide', () => {
  const { rows } = buildFlowRows(flow([
    { layer: 'gateway', type: 'task.running', offset: 0 },
    { layer: 'backend', type: 'acp.response', offset: 9000 },
    { layer: 'gateway', type: 'task.completed', offset: 9100 },
  ]))
  assert.equal(rows[0].gapMs, 0, 'the first row has nothing to wait for')
  assert.equal(rows[1].gapMs, 9000)
  assert.equal(rows[2].gapMs, 0, 'a short step is not worth pointing out')
})

test('carries the severity of a finding onto its row', () => {
  const { rows } = buildFlowRows(flow([
    { layer: 'gateway', type: 'task.completed', offset: 0, taskId: 'w1' },
    { layer: 'gateway', type: 'task.permission.requested', offset: 100, taskId: 'w1' },
  ]), [{
    rule: 'permission-after-terminal',
    severity: 'error',
    eventIndexes: [0, 1],
    summary: 'x',
  }])
  assert.deepEqual(rows.map(row => row.severity), ['error', 'error'])
  assert.equal(rows[1].anomalyRule, 'permission-after-terminal')
})

test('an error outranks a warning on the same event', () => {
  const map = anomalyIndexMap([
    { rule: 'task-idle', severity: 'warn', eventIndexes: [3] },
    { rule: 'permission-after-terminal', severity: 'error', eventIndexes: [3] },
  ])
  assert.equal(map.get(3).severity, 'error')

  const reversed = anomalyIndexMap([
    { rule: 'permission-after-terminal', severity: 'error', eventIndexes: [3] },
    { rule: 'task-idle', severity: 'warn', eventIndexes: [3] },
  ])
  assert.equal(reversed.get(3).severity, 'error', 'order of findings must not matter')
})

test('returns nothing to draw for an empty or malformed flow', () => {
  for (const input of [flow([]), {}, null, undefined]) {
    const { rows, durationMs } = buildFlowRows(input)
    assert.deepEqual(rows, [])
    assert.equal(durationMs, 0)
  }
})

test('formats offsets in one comparable unit', () => {
  assert.equal(formatOffset(0), '0.0s')
  assert.equal(formatOffset(430), '0.4s')
  assert.equal(formatOffset(9061), '9.1s')
  assert.equal(formatOffset(-5), '0.0s')
  assert.equal(formatOffset(Number.NaN), '0.0s')
})

test('names every layer it can show', () => {
  for (const layer of FLOW_LAYERS) {
    assert.equal(flowLayerLabel(layer.id), layer.label)
    assert.ok(layer.hint, 'each layer explains itself on hover')
  }
  assert.equal(flowLayerLabel('unheard-of'), 'unheard-of')
})
