import assert from 'node:assert/strict'
import test from 'node:test'
import { GatewayTaskEvent } from '../../shared/realtime-events.mjs'
import { TaskDomainEvent } from '../src/task/task-events.mjs'
import {
  projectGatewayTaskEvent,
  projectGatewayTaskSnapshot,
} from '../src/transport/gateway-task-event-projector.mjs'

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

test('projects every Task domain event into an explicit public event', () => {
  for (const type of Object.values(TaskDomainEvent)) {
    const projected = projectGatewayTaskEvent({
      type,
      ownerId: 'internal-owner-routing-key',
      task: task(),
    })
    assert.ok(projected, `missing public projection for ${type}`)
    assert.equal(projected.type, type)
    assert.equal('ownerId' in projected, false)
  }
})

test('keeps public details and strips undeclared Task fields', () => {
  const projected = projectGatewayTaskEvent({
    type: TaskDomainEvent.PERMISSION_REQUESTED,
    task: task({ internalSchedulerLane: 'coordinator:owner' }),
    permission: authorization(),
    message: 'public progress',
    privateReason: 'adapter-only',
  })

  assert.deepEqual(projected.permission, authorization())
  assert.equal(projected.message, 'public progress')
  assert.equal('internalSchedulerLane' in projected.task, false)
  assert.equal('privateReason' in projected, false)
})

test('projects a reconnect snapshot through the same Task schema', () => {
  const projected = projectGatewayTaskSnapshot(task({
    status: 'queued',
    privateStoreVersion: 2,
  }))

  assert.equal(projected.type, GatewayTaskEvent.SNAPSHOT)
  assert.equal(projected.task.status, 'queued')
  assert.equal('privateStoreVersion' in projected.task, false)
})

test('does not expose malformed or unrelated internal events', () => {
  assert.equal(projectGatewayTaskEvent(null), null)
  assert.equal(projectGatewayTaskEvent({ type: 'backend.activity' }), null)
  assert.equal(projectGatewayTaskSnapshot(null), null)
})

test('never projects system jobs into the public task protocol', () => {
  const system = task({ scope: 'system', kind: 'system_job' })
  assert.equal(projectGatewayTaskEvent({
    type: TaskDomainEvent.RUNNING,
    task: system,
  }), null)
  assert.equal(projectGatewayTaskSnapshot(system), null)
})
