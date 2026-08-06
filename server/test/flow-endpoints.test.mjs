import assert from 'node:assert/strict'
import test from 'node:test'

import { FlowRecorder } from '../src/observability/flow-recorder.mjs'
import { detectFlowAnomalies } from '../src/observability/flow-anomalies.mjs'

// The routes themselves are three lines of Express over these two modules, so
// what is worth pinning is the contract they serve: the shapes the debug page
// reads, and the fact that a disabled trace exposes nothing.
function buildFlowResponses(recorder, { enabled }) {
  const unavailable = {
    status: 404,
    body: { error: 'flow trace disabled' },
  }
  return {
    list() {
      if (!enabled) return unavailable
      return {
        status: 200,
        body: {
          enabled: true,
          flows: recorder.list().map(flow => ({
            ...flow,
            anomalyCount: detectFlowAnomalies(recorder.get(flow.flowId)).length,
          })),
        },
      }
    },
    detail(flowId) {
      if (!enabled) return unavailable
      const flow = recorder.get(flowId)
      if (!flow) return { status: 404, body: { error: 'flow not found' } }
      return { status: 200, body: { ...flow, anomalies: detectFlowAnomalies(flow) } }
    },
  }
}

function recorderWithFaultyFlow() {
  const recorder = new FlowRecorder()
  let at = 1_000_000
  const record = event => recorder.record({ flowId: 'flow-1', ...event })
  recorder.now = () => (at += 1000)
  record({ layer: 'frontstage', type: 'turn.started' })
  record({ layer: 'gateway', type: 'task.accepted', taskId: 'work_1' })
  record({ layer: 'gateway', type: 'task.running', taskId: 'work_1' })
  record({ layer: 'backend', type: 'acp.request', detail: { rpcId: 1, method: 'session/prompt' } })
  record({ layer: 'backend', type: 'acp.response', detail: { rpcId: 1 } })
  record({ layer: 'gateway', type: 'task.completed', taskId: 'work_1' })
  record({ layer: 'gateway', type: 'task.permission.requested', taskId: 'work_1' })
  return recorder
}

test('the list carries what the page needs to choose a flow', () => {
  const api = buildFlowResponses(recorderWithFaultyFlow(), { enabled: true })
  const { status, body } = api.list()
  assert.equal(status, 200)
  assert.equal(body.enabled, true)
  assert.equal(body.flows.length, 1)
  const [flow] = body.flows
  assert.equal(flow.flowId, 'flow-1')
  assert.equal(flow.eventCount, 7)
  assert.deepEqual(flow.taskIds, ['work_1'])
  // The count is the whole reason to show a list: it is what makes the broken
  // interaction stand out among the healthy ones.
  assert.ok(flow.anomalyCount > 0)
})

test('the detail carries events and findings together', () => {
  const api = buildFlowResponses(recorderWithFaultyFlow(), { enabled: true })
  const { status, body } = api.detail('flow-1')
  assert.equal(status, 200)
  assert.equal(body.events.length, 7)
  assert.ok(Array.isArray(body.anomalies))
  assert.ok(body.anomalies.some(item => item.rule === 'permission-after-terminal'))
  for (const anomaly of body.anomalies) {
    for (const index of anomaly.eventIndexes) {
      assert.ok(body.events[index], 'every accused index must exist in events')
    }
  }
})

test('an unknown flow is a 404, not an empty timeline', () => {
  const api = buildFlowResponses(new FlowRecorder(), { enabled: true })
  assert.equal(api.detail('never-happened').status, 404)
})

test('every route reports 404 while the trace is off', () => {
  const api = buildFlowResponses(recorderWithFaultyFlow(), { enabled: false })
  assert.equal(api.list().status, 404)
  assert.equal(api.detail('flow-1').status, 404)
})
