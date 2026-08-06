import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_MAX_EVENTS_PER_FLOW,
  DEFAULT_MAX_FLOWS,
  FLOW_HEARTBEAT_EVENTS,
  FlowRecorder,
  NULL_FLOW_RECORDER,
  taskEventToFlowEvent,
} from '../src/observability/flow-recorder.mjs'

function clock(start = 1000) {
  let value = start
  return { now: () => (value += 10), peek: () => value }
}

test('groups events by flow and reports them newest first', () => {
  const recorder = new FlowRecorder(clock())
  recorder.record({ flowId: 'a', layer: 'frontstage', type: 'ws.in' })
  recorder.record({ flowId: 'b', layer: 'gateway', type: 'task.accepted', taskId: 'w1' })
  recorder.record({ flowId: 'a', layer: 'backend', type: 'acp.request' })

  const flow = recorder.get('a')
  assert.equal(flow.events.length, 2)
  assert.deepEqual(flow.events.map(e => e.type), ['ws.in', 'acp.request'])

  const listed = recorder.list()
  assert.deepEqual(listed.map(f => f.flowId), ['a', 'b'], 'most recently active first')
  assert.deepEqual(listed[1].taskIds, ['w1'])
  assert.deepEqual(listed[0].layers, ['frontstage', 'backend'])
})

test('refuses events that cannot be placed on a timeline', () => {
  const recorder = new FlowRecorder()
  assert.equal(recorder.record({ layer: 'gateway', type: 'task.running' }), null)
  assert.equal(recorder.record({ flowId: 'a' }), null)
  assert.equal(recorder.record(), null)
  assert.equal(recorder.list().length, 0)
})

// Found on real traffic: task.progress fires once a second, so a 500-event
// buffer held 500 identical rows and had evicted every event that explained
// anything. A heartbeat is not information transfer.
test('drops heartbeats so they cannot crowd out the real events', () => {
  const recorder = new FlowRecorder({ maxEventsPerFlow: 5 })
  recorder.record({ flowId: 'a', layer: 'frontstage', type: 'turn.started' })
  for (let index = 0; index < 50; index += 1) {
    assert.equal(
      recorder.record({ flowId: 'a', layer: 'gateway', type: 'task.progress' }),
      null,
    )
  }
  recorder.record({ flowId: 'a', layer: 'gateway', type: 'task.completed' })

  const flow = recorder.get('a')
  assert.deepEqual(flow.events.map(e => e.type), ['turn.started', 'task.completed'],
    'what matters survives the heartbeat')
  assert.ok(FLOW_HEARTBEAT_EVENTS.has('task.progress'))
})

test('falls back to the gateway layer for an unknown one', () => {
  const recorder = new FlowRecorder()
  const event = recorder.record({ flowId: 'a', layer: 'nowhere', type: 'x' })
  assert.equal(event.layer, 'gateway')
})

test('stays bounded in both directions', () => {
  const recorder = new FlowRecorder({ maxFlows: 2, maxEventsPerFlow: 3 })
  for (const flowId of ['a', 'b', 'c']) {
    recorder.record({ flowId, layer: 'gateway', type: 'task.accepted' })
  }
  // The Gateway is long-lived, so the oldest flow has to go.
  assert.deepEqual(recorder.list().map(f => f.flowId), ['c', 'b'])
  assert.equal(recorder.get('a'), null)

  for (let index = 0; index < 5; index += 1) {
    recorder.record({ flowId: 'c', layer: 'backend', type: `step-${index}` })
  }
  const flow = recorder.get('c')
  assert.equal(flow.events.length, 3)
  assert.deepEqual(flow.events.map(e => e.type), ['step-2', 'step-3', 'step-4'],
    'oldest events drop first')
})

test('evicts the least recently active flow, not merely the earliest started', () => {
  const recorder = new FlowRecorder({ maxFlows: 2 })
  recorder.record({ flowId: 'a', layer: 'gateway', type: 'task.accepted' })
  recorder.record({ flowId: 'b', layer: 'gateway', type: 'task.accepted' })
  // Touching 'a' again should protect it from the next eviction.
  recorder.record({ flowId: 'a', layer: 'gateway', type: 'task.running' })
  recorder.record({ flowId: 'c', layer: 'gateway', type: 'task.accepted' })

  assert.ok(recorder.get('a'), 'recently active flow survives')
  assert.equal(recorder.get('b'), null)
})

test('redacts secrets and truncates long text', () => {
  const recorder = new FlowRecorder({ maxTextLength: 10, maxPayloadTextLength: 10 })
  const event = recorder.record({
    flowId: 'a',
    layer: 'backend',
    type: 'acp.request',
    detail: { apiKey: 'super-secret-value', prompt: 'x'.repeat(40), rpcId: 7 },
  })
  assert.notEqual(event.detail.apiKey, 'super-secret-value')
  assert.ok(event.detail.prompt.startsWith('xxxxxxxxxx'))
  assert.match(event.detail.prompt, /\(\+30\)$/)
  assert.equal(event.detail.rpcId, 7, 'non-text fields survive untouched')
})

// A prompt truncated to the ordinary limit made scrolling the detail panel
// pointless: the rest had been discarded at record time, not merely hidden.
test('keeps payload fields far longer than ordinary ones', () => {
  const recorder = new FlowRecorder({ maxTextLength: 20, maxPayloadTextLength: 5000 })
  const event = recorder.record({
    flowId: 'a',
    layer: 'backend',
    type: 'acp.request',
    detail: {
      prompt: 'p'.repeat(3000),
      content: 'c'.repeat(3000),
      arguments: 'a'.repeat(3000),
      method: 'm'.repeat(3000),
    },
  })
  assert.equal(event.detail.prompt.length, 3000, 'a prompt is what the reader came for')
  assert.equal(event.detail.content.length, 3000)
  assert.equal(event.detail.arguments.length, 3000)
  // Everything else stays small, which is what keeps the buffer bounded.
  assert.ok(event.detail.method.length < 60)
  assert.match(event.detail.method, /\(\+2980\)$/)
})

test('never lets the payload limit fall below the ordinary one', () => {
  const recorder = new FlowRecorder({ maxTextLength: 500, maxPayloadTextLength: 10 })
  assert.equal(recorder.maxPayloadTextLength, 500)
})

test('notifies subscribers and survives a broken one', () => {
  const recorder = new FlowRecorder()
  const seen = []
  recorder.subscribe(() => { throw new Error('broken subscriber') })
  const unsubscribe = recorder.subscribe(event => seen.push(event.type))

  recorder.record({ flowId: 'a', layer: 'gateway', type: 'task.accepted' })
  assert.deepEqual(seen, ['task.accepted'])

  unsubscribe()
  recorder.record({ flowId: 'a', layer: 'gateway', type: 'task.running' })
  assert.deepEqual(seen, ['task.accepted'], 'unsubscribed listener stops hearing')
  assert.equal(typeof recorder.subscribe('not a function'), 'function')
})

test('the null recorder is safe to call from every instrumented site', () => {
  assert.equal(NULL_FLOW_RECORDER.record({ flowId: 'a', type: 'x' }), null)
  assert.deepEqual(NULL_FLOW_RECORDER.list(), [])
  assert.equal(NULL_FLOW_RECORDER.get('a'), null)
  assert.equal(typeof NULL_FLOW_RECORDER.subscribe(() => {}), 'function')
  NULL_FLOW_RECORDER.alias('a', 'b')
  NULL_FLOW_RECORDER.clear()
})

// The backend identifies an interaction by the coordinator run, the frontstage
// by the turn. Real traffic came out as two half timelines until these were
// tied together, which no unit test had caught.
test('routes later events through a learned alias', () => {
  const recorder = new FlowRecorder()
  recorder.record({ flowId: 'turn-1', layer: 'frontstage', type: 'turn.started' })
  recorder.alias('work_1', 'turn-1')
  recorder.record({ flowId: 'work_1', layer: 'backend', type: 'acp.request' })

  assert.equal(recorder.list().length, 1, 'one interaction, one timeline')
  const flow = recorder.get('turn-1')
  assert.deepEqual(flow.events.map(e => e.type), ['turn.started', 'acp.request'])
  assert.ok(flow.events.every(e => e.flowId === 'turn-1'))
})

test('merges events that already landed under the alias', () => {
  const recorder = new FlowRecorder(clock())
  // Backend traffic can be recorded before any task event reveals the mapping.
  recorder.record({ flowId: 'work_1', layer: 'backend', type: 'acp.request' })
  recorder.record({ flowId: 'turn-1', layer: 'frontstage', type: 'turn.started' })
  recorder.alias('work_1', 'turn-1')

  assert.equal(recorder.get('work_1'), null, 'the stray flow is gone')
  const flow = recorder.get('turn-1')
  assert.equal(flow.events.length, 2)
  // Merged by time, so the timeline still reads in the order things happened.
  assert.deepEqual(flow.events.map(e => e.type), ['acp.request', 'turn.started'])
  assert.equal(recorder.list().length, 1)
})

test('adopts a stray flow wholesale when the target does not exist yet', () => {
  const recorder = new FlowRecorder()
  recorder.record({ flowId: 'work_1', layer: 'backend', type: 'acp.request' })
  recorder.alias('work_1', 'turn-1')
  const flow = recorder.get('turn-1')
  assert.equal(flow.flowId, 'turn-1')
  assert.equal(flow.events.length, 1)
  assert.equal(flow.events[0].flowId, 'turn-1')
})

test('ignores meaningless or repeated aliases', () => {
  const recorder = new FlowRecorder()
  recorder.record({ flowId: 'turn-1', layer: 'gateway', type: 'task.accepted' })
  recorder.alias('turn-1', 'turn-1')
  recorder.alias('', 'turn-1')
  recorder.alias('work_1', '')
  recorder.alias('work_1', 'turn-1')
  recorder.alias('work_1', 'turn-1')
  assert.equal(recorder.list().length, 1)
  assert.equal(recorder.get('turn-1').events.length, 1)
})

test('reshapes task events without needing changes in the task layer', () => {
  const event = taskEventToFlowEvent({
    type: 'task.permission.requested',
    task: {
      id: 'work_1',
      turnId: 'voice-1',
      sessionId: 'main',
      status: 'running',
      kind: 'work',
    },
    authorization: { id: 'perm_1' },
  })
  assert.equal(event.flowId, 'voice-1')
  assert.equal(event.layer, 'gateway')
  assert.equal(event.taskId, 'work_1')
  assert.equal(event.detail.permissionId, 'perm_1')

  const delegated = taskEventToFlowEvent({
    type: 'task.running',
    task: { id: 'work_2', flowId: 'flow-9', kind: 'delegated', status: 'running' },
  })
  assert.equal(delegated.layer, 'delegated')
  assert.equal(delegated.flowId, 'flow-9', 'an explicit flowId wins over turnId')

  assert.equal(taskEventToFlowEvent({ type: 'task.running', task: {} }), null,
    'an event with nothing to correlate on is not recorded')
  assert.equal(taskEventToFlowEvent(), null)
})

test('exposes the bounds it defaults to', () => {
  assert.ok(DEFAULT_MAX_FLOWS > 0)
  assert.ok(DEFAULT_MAX_EVENTS_PER_FLOW > 0)
})
