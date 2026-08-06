import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_THRESHOLDS,
  detectFlowAnomalies,
} from '../src/observability/flow-anomalies.mjs'

const T0 = 1_000_000

function flow(events) {
  return {
    flowId: 'flow-1',
    events: events.map((event, index) => ({
      flowId: 'flow-1',
      layer: 'gateway',
      at: T0 + (event.offset ?? index * 1000),
      ...event,
    })),
  }
}

function rules(found) {
  return found.map(item => item.rule)
}

// This is the failure that motivated the whole feature. It was found by hand,
// by grepping a log file and noticing that a permission request carried the id
// of a task that had finished five minutes earlier.
test('catches a permission request delivered to an already finished task', () => {
  const found = detectFlowAnomalies(flow([
    { type: 'task.accepted', taskId: 'work_1', offset: 0 },
    { type: 'task.running', taskId: 'work_1', offset: 1000 },
    { type: 'task.completed', taskId: 'work_1', offset: 50_000 },
    { type: 'task.accepted', taskId: 'work_2', offset: 60_000 },
    { type: 'task.running', taskId: 'work_2', offset: 61_000 },
    // Five minutes after work_1 ended, a permission arrives bearing its id.
    { type: 'task.permission.requested', taskId: 'work_1', offset: 350_000 },
  ]), { now: T0 + 360_000 })

  assert.ok(rules(found).includes('permission-after-terminal'))
  const anomaly = found.find(item => item.rule === 'permission-after-terminal')
  assert.equal(anomaly.severity, 'error')
  assert.match(anomaly.summary, /work_1/)
  // Both the closing event and the late request, so the page can show the pair.
  assert.equal(anomaly.eventIndexes.length, 2)
  assert.deepEqual(anomaly.eventIndexes, [2, 5])
  assert.match(anomaly.detail, /300 秒前/)
})

test('does not accuse a permission request that arrives while the task runs', () => {
  const found = detectFlowAnomalies(flow([
    { type: 'task.running', taskId: 'work_1', offset: 0 },
    { type: 'task.permission.requested', taskId: 'work_1', offset: 1000, detail: { permissionId: 'p1' } },
    { type: 'task.permission.resolved', taskId: 'work_1', offset: 2000, detail: { permissionId: 'p1' } },
    { type: 'task.completed', taskId: 'work_1', offset: 3000 },
  ]), { now: T0 + 4000 })
  assert.deepEqual(rules(found), [], 'a healthy permission round trip is silent')
})

test('flags a permission nobody ever answered', () => {
  const events = [
    { type: 'task.running', taskId: 'work_1', offset: 0 },
    { type: 'task.permission.requested', taskId: 'work_1', offset: 1000, detail: { permissionId: 'p1' } },
  ]
  const pending = detectFlowAnomalies(flow(events), { now: T0 + 90_000 })
  assert.ok(rules(pending).includes('permission-unanswered'))

  // Still inside the grace period: a human may simply not have clicked yet.
  const fresh = detectFlowAnomalies(flow(events), { now: T0 + 5000 })
  assert.ok(!rules(fresh).includes('permission-unanswered'))
})

test('flags a running task with no backend activity, but not a quick one', () => {
  const stuck = detectFlowAnomalies(flow([
    { type: 'task.accepted', taskId: 'work_1', offset: 0 },
    { type: 'task.running', taskId: 'work_1', offset: 1000 },
  ]), { now: T0 + 200_000 })
  assert.ok(rules(stuck).includes('task-idle'))

  const quick = detectFlowAnomalies(flow([
    { type: 'task.running', taskId: 'work_1', offset: 0 },
    { type: 'task.completed', taskId: 'work_1', offset: 2000 },
  ]), { now: T0 + 200_000 })
  assert.ok(!rules(quick).includes('task-idle'),
    'answering fast without backend traffic is not a fault')

  const working = detectFlowAnomalies(flow([
    { type: 'task.running', taskId: 'work_1', offset: 0 },
    { type: 'acp.request', layer: 'backend', offset: 5000 },
  ]), { now: T0 + 200_000 })
  assert.ok(!rules(working).includes('task-idle'))
})

test('flags a backend call that never returned', () => {
  const hanging = detectFlowAnomalies(flow([
    {
      type: 'acp.request',
      layer: 'backend',
      offset: 0,
      detail: { rpcId: 4, method: 'session/prompt' },
    },
  ]), { now: T0 + 400_000 })
  const anomaly = hanging.find(item => item.rule === 'request-without-response')
  assert.ok(anomaly)
  assert.match(anomaly.summary, /session\/prompt/)

  const answered = detectFlowAnomalies(flow([
    { type: 'acp.request', layer: 'backend', offset: 0, detail: { rpcId: 4, method: 'session/prompt' } },
    { type: 'acp.response', layer: 'backend', offset: 1000, detail: { rpcId: 4 } },
  ]), { now: T0 + 400_000 })
  assert.deepEqual(rules(answered), [])
})

test('only reports an unknown session when the known set is supplied', () => {
  const events = flow([
    { type: 'acp.notify', layer: 'backend', sessionId: 'stale-session', offset: 0 },
  ])
  // Sessions outlive one interaction, so guessing from the flow alone would
  // accuse every healthy resumed session.
  assert.deepEqual(rules(detectFlowAnomalies(events)), [])

  const found = detectFlowAnomalies(events, { knownSessionIds: ['live-session'] })
  assert.ok(rules(found).includes('unknown-session'))

  const ok = detectFlowAnomalies(events, { knownSessionIds: new Set(['stale-session']) })
  assert.deepEqual(rules(ok), [])
})

test('orders findings by the evidence they point at', () => {
  const found = detectFlowAnomalies(flow([
    { type: 'acp.request', layer: 'backend', offset: 0, detail: { rpcId: 1, method: 'session/new' } },
    { type: 'task.completed', taskId: 'work_1', offset: 1000 },
    { type: 'task.permission.requested', taskId: 'work_1', offset: 2000 },
  ]), { now: T0 + 400_000 })
  assert.ok(found.length >= 2)
  const positions = found.map(item => item.eventIndexes[0])
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b))
})

test('says nothing about an empty or malformed flow', () => {
  assert.deepEqual(detectFlowAnomalies({ events: [] }), [])
  assert.deepEqual(detectFlowAnomalies({}), [])
  assert.deepEqual(detectFlowAnomalies(), [])
})

test('thresholds can be overridden and have sane defaults', () => {
  assert.ok(DEFAULT_THRESHOLDS.pendingPermissionMs > 0)
  const events = flow([
    { type: 'task.permission.requested', taskId: 'work_1', offset: 0 },
  ])
  assert.deepEqual(rules(detectFlowAnomalies(events, { now: T0 + 100 })), [])
  const strict = detectFlowAnomalies(events, {
    now: T0 + 100,
    thresholds: { pendingPermissionMs: 50 },
  })
  assert.ok(rules(strict).includes('permission-unanswered'))
})
