import assert from 'node:assert/strict'
import test from 'node:test'
import { TaskManager } from '../src/task/task-manager.mjs'
import { TaskOperations } from '../src/orchestration/task-operations.mjs'
import { TaskScheduler } from '../src/task/task-scheduler.mjs'
import { persistedTask } from '../src/task/task-state.mjs'

const identity = { ownerId: 'personal', sessionId: 'voice' }
const tick = () => new Promise(resolve => setImmediate(resolve))

function harness(t, options) {
  const taskManager = new TaskManager(options)
  const runs = new Map()
  const backendRuntime = {
    run(_input, context) {
      const pending = Promise.withResolvers()
      runs.set(context.taskId, { ...pending, ...context })
      context.signal.addEventListener('abort', () => pending.reject(new Error('cancelled')), { once: true })
      return pending.promise
    },
    async cancel() { return { state: 'cancelled' } },
  }
  const operations = new TaskOperations({ taskManager, backendRuntime })
  t.after(async () => {
    await Promise.all(operations.list(identity, { active: true }).map(task => operations.cancel(task.id, identity)))
  })
  const create = objective => operations.submit({ objective }, identity)
  return { taskManager, operations, runs, create }
}

test('default capacity runs new work serially and admits the next task only after completion', async t => {
  const h = harness(t)
  const a = h.create('A')
  const b = h.create('B')
  await tick()
  assert.deepEqual([...h.runs.keys()], [a.id])
  assert.equal(h.operations.get(a.id, identity).status, 'running')
  assert.equal(h.operations.get(b.id, identity).status, 'queued')
  assert.equal(h.taskManager.scheduler.active.size, 1)

  h.runs.get(a.id).resolve({ content: 'A done' })
  await h.taskManager.wait(a.id)
  await tick()
  assert.deepEqual([...h.runs.keys()], [a.id, b.id])
  assert.equal(h.operations.get(b.id, identity).status, 'running')
  assert.equal(h.taskManager.scheduler.active.size, 1)
})

for (const capacity of [1, 2, 3]) {
  test(`owner capacity ${capacity} bounds execution and drains queued work in order`, async t => {
    const h = harness(t, { maxConcurrent: 4, maxConcurrentPerOwner: capacity })
    const tasks = Array.from({ length: capacity + 2 }, (_, index) => h.create(`work ${index}`))
    await tick()
    assert.deepEqual([...h.runs.keys()], tasks.slice(0, capacity).map(task => task.id))
    assert.equal(h.operations.get(tasks[capacity].id, identity).status, 'queued')
    h.runs.get(tasks[0].id).resolve({ content: 'done' })
    await h.taskManager.wait(tasks[0].id)
    await tick()
    assert.equal(h.runs.has(tasks[capacity].id), true)
    assert.equal(h.runs.has(tasks[capacity + 1].id), false)
    assert.equal(h.taskManager.scheduler.active.size, capacity)
  })
}

test('global capacity still limits a higher owner capacity', async t => {
  const h = harness(t, { maxConcurrent: 1, maxConcurrentPerOwner: 3 })
  h.create('A')
  const b = h.create('B')
  await tick()
  assert.equal(h.runs.size, 1)
  assert.equal(h.operations.get(b.id, identity).status, 'queued')
})

test('delegated work and pending permission retain slots; failure admits queued work', async t => {
  const h = harness(t, { maxConcurrent: 2, maxConcurrentPerOwner: 2 })
  const a = h.create('A')
  const b = h.create('B')
  const c = h.create('C')
  await tick()
  h.runs.get(a.id).onEvent({ type: 'backend.delegated', delegation: { id: 'child', sessionId: 'project' } })
  h.runs.get(b.id).onEvent({ type: 'backend.permission.requested', permission: { id: 'permission', status: 'pending', summary: 'read file' } })
  await tick()
  assert.equal(h.runs.size, 2)
  assert.equal(h.operations.get(c.id, identity).status, 'queued')
  h.runs.get(a.id).reject(new Error('backend failed'))
  assert.equal((await h.taskManager.wait(a.id)).status, 'failed')
  await tick()
  assert.equal(h.runs.has(c.id), true)
  assert.equal(h.operations.get(b.id, identity).authorization.id, 'permission')
})

test('cancelling one work frees only its slot and leaves the other work running', async t => {
  const h = harness(t, { maxConcurrent: 2, maxConcurrentPerOwner: 2 })
  const a = h.create('A')
  const b = h.create('B')
  const c = h.create('C')
  await tick()
  await h.operations.cancel(a.id, identity)
  await tick()
  assert.equal(h.runs.get(a.id).signal.aborted, true)
  assert.equal(h.runs.get(b.id).signal.aborted, false)
  assert.equal(h.operations.get(b.id, identity).status, 'running')
  assert.equal(h.runs.has(c.id), true)
})

function recoveryHarness(t, options = {}) {
  const saved = Array.from({ length: 3 }, (_, index) => ({
    id: `task_${index + 1}`, ownerId: identity.ownerId, sessionId: identity.sessionId,
    objective: `recovered work ${index + 1}`, scope: 'user', kind: 'work',
    status: 'delegated', createdAt: Date.now() + index,
    delegation: { id: `child-${index + 1}`, sessionId: `project-${index + 1}` },
  }))
  const taskManager = new TaskManager({ ...options, store: { load: () => saved, save() {} } })
  const runs = new Map()
  taskManager.recoverDelegated({
    canRecover: () => true,
    runner: (task, execution) => {
      const pending = Promise.withResolvers()
      runs.set(task.id, pending)
      execution.onEvent({ type: 'backend.delegated', delegation: task.delegation })
      execution.signal.addEventListener('abort', () => pending.resolve({ content: 'cancelled' }), { once: true })
      return pending.promise
    },
  })
  t.after(async () => {
    await Promise.all(taskManager.list({ ownerId: identity.ownerId, active: true })
      .map(task => taskManager.cancel(task.id, identity)))
  })
  return { taskManager, runs }
}

for (const capacity of [1, 2]) {
  test(`recovered delegated work respects ${capacity === 1 ? 'default' : 'explicit'} capacity ${capacity} and drains the next task`, async t => {
    const h = recoveryHarness(t, capacity === 1 ? undefined : { maxConcurrent: 2, maxConcurrentPerOwner: 2 })
    const nextId = `task_${capacity + 1}`
    await tick()
    assert.deepEqual([...h.runs.keys()], Array.from({ length: capacity }, (_, index) => `task_${index + 1}`))
    assert.equal(h.taskManager.scheduler.active.size, capacity)
    assert.equal(h.taskManager.get(nextId).status, 'queued')
    assert.equal(persistedTask(h.taskManager.tasks.get(nextId)).status, 'delegated')
    h.runs.get('task_1').resolve({ content: 'recovered work finished' })
    await h.taskManager.wait('task_1')
    await tick()
    assert.equal(h.runs.has(nextId), true)
    assert.equal(h.taskManager.get(nextId).status, 'delegated')
    assert.equal(h.taskManager.scheduler.active.size, capacity)
    assert.equal(h.taskManager.tasks.get(nextId).recoveryPersistedStatus, null)
    if (capacity === 1) assert.equal(h.runs.has('task_3'), false)
  })
}

test('cancelling queued recovered work persists cancellation instead of reviving its delegated snapshot', async t => {
  const h = recoveryHarness(t)
  await tick()
  await h.taskManager.cancel('task_3', identity)
  assert.equal(h.runs.has('task_3'), false)
  assert.equal(h.taskManager.get('task_3').status, 'cancelled')
  assert.equal(persistedTask(h.taskManager.tasks.get('task_3')).status, 'cancelled')
})

test('concurrency limits are positive whole numbers', () => {
  assert.equal(new TaskScheduler().maxConcurrent, 1)
  assert.equal(new TaskScheduler().maxConcurrentPerOwner, 1)
  assert.equal(new TaskScheduler({ maxConcurrent: 2.9 }).maxConcurrent, 2)
  assert.equal(new TaskScheduler({ maxConcurrentPerOwner: 2.9 }).maxConcurrentPerOwner, 2)
  for (const value of [0, -1, 0.5, Infinity, NaN]) {
    assert.equal(new TaskScheduler({ maxConcurrent: value }).maxConcurrent, 1)
    assert.equal(new TaskScheduler({ maxConcurrentPerOwner: value }).maxConcurrentPerOwner, 1)
  }
})
