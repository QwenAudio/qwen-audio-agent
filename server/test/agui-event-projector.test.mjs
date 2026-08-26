import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AguiEventType,
  parseAguiGatewayEvent,
} from '../../shared/protocol/agui-events.mjs'
import { GatewayTaskEvent } from '../../shared/realtime-events.mjs'
import {
  AGUI_TASK_ACTIVITY_TYPE,
  projectGatewayTaskEventForFormat,
  projectGatewayTaskEventToAgui,
} from '../src/transport/agui-event-projector.mjs'

function task(overrides = {}) {
  return {
    id: 'task_1',
    workState: 'working',
    status: 'running',
    kind: 'work',
    objective: 'inspect the system',
    createdAt: 1,
    elapsedMs: 0,
    result: null,
    error: null,
    ...overrides,
  }
}

function authorization() {
  return {
    id: 'permission_1',
    taskId: 'task_1',
    status: 'pending',
    category: 'shell',
    summary: 'run command',
    patterns: [],
    createdAt: 1,
    resolvedAt: null,
  }
}

test('projects every public Task event into one AG-UI activity snapshot', () => {
  for (const eventType of Object.values(GatewayTaskEvent)) {
    const projected = projectGatewayTaskEventToAgui({
      type: eventType,
      task: task(),
    })

    assert.equal(projected.type, AguiEventType.ACTIVITY_SNAPSHOT)
    assert.equal(projected.messageId, `${AGUI_TASK_ACTIVITY_TYPE}:task_1`)
    assert.equal(projected.activityType, AGUI_TASK_ACTIVITY_TYPE)
    assert.equal(projected.replace, true)
    assert.equal(projected.content.eventType, eventType)
    assert.equal(projected.content.task.id, 'task_1')
    assert.deepEqual(parseAguiGatewayEvent(projected), projected)
  }
})

test('keeps one stable activity identity across a Task lifecycle', () => {
  const running = projectGatewayTaskEventToAgui({
    type: GatewayTaskEvent.RUNNING,
    task: task(),
  })
  const completed = projectGatewayTaskEventToAgui({
    type: GatewayTaskEvent.COMPLETED,
    task: task({
      workState: 'completed',
      status: 'completed',
      completedAt: 10,
      result: '24 GB',
    }),
  })

  assert.equal(completed.messageId, running.messageId)
  assert.equal(completed.content.task.status, 'completed')
  assert.equal(completed.content.task.result, '24 GB')
})

test('preserves public details without exposing undeclared fields', () => {
  const projected = projectGatewayTaskEventToAgui({
    type: GatewayTaskEvent.PERMISSION_REQUESTED,
    task: task({ internalSchedulerLane: 'coordinator:owner' }),
    permission: authorization(),
    message: 'permission needed',
    privateReason: 'adapter-only',
  })

  assert.deepEqual(projected.content.permission, authorization())
  assert.equal(projected.content.message, 'permission needed')
  assert.equal('internalSchedulerLane' in projected.content.task, false)
  assert.equal('privateReason' in projected.content, false)
})

test('does not project malformed or unrelated events', () => {
  assert.equal(projectGatewayTaskEventToAgui(null), null)
  assert.equal(projectGatewayTaskEventToAgui({ type: 'voice.ready' }), null)
})

test('keeps native events by default and projects only on explicit opt-in', () => {
  const event = {
    type: GatewayTaskEvent.SNAPSHOT,
    task: task(),
  }

  assert.equal(projectGatewayTaskEventForFormat(event), event)
  assert.equal(projectGatewayTaskEventForFormat(event, 'native'), event)
  assert.equal(
    projectGatewayTaskEventForFormat(event, 'ag-ui').type,
    AguiEventType.ACTIVITY_SNAPSHOT,
  )
})
