import assert from 'node:assert/strict'
import test from 'node:test'
import { TaskManager } from '../src/task/task-manager.mjs'

// Runner that blocks until resolved — keeps the task running so the
// progress check timer has time to fire.
function blockingRunner() {
  let resolve
  const promise = new Promise(r => { resolve = r })
  const runner = async (objective, { onEvent }) => {
    onEvent?.({
      type: 'backend.activity',
      activity: {
        id: 'call_1',
        kind: 'tool',
        tool: 'bash',
        status: 'running',
        category: 'run',
        detail: 'npm test',
      },
    })
    return promise
  }
  runner.resolve = resolve
  return runner
}

function createWorkTask(manager, opts = {}) {
  const {
    objective = 'test',
    ownerId = 'owner',
    runner = null,
  } = opts
  return manager.create({
    objective,
    ownerId,
    sessionId: 'voice',
    turnId: 'turn-1',
    runner: runner || blockingRunner(),
  })
}

test('progress check timer emits task.progress.check with activity-based message', async () => {
  const manager = new TaskManager({ progressCheckMs: 30 })
  const progressEvents = []
  manager.subscribe(event => {
    if (event.type === 'task.progress.check') progressEvents.push(event)
  })

  const runner = blockingRunner()
  const task = createWorkTask(manager, {
    objective: '测试进度任务',
    runner,
  })

  const internal = manager.tasks.get(task.id)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(manager.get(task.id).status, 'running')

  // The blockingRunner pushes an activity event via onEvent
  assert.ok(internal.activity.length > 0)

  // Wait for progress check timer to fire
  await new Promise(resolve => setTimeout(resolve, 60))

  assert.ok(progressEvents.length > 0)
  const event = progressEvents[0]
  assert.equal(event.type, 'task.progress.check')
  assert.ok(event.message.includes('npm test'))
  assert.ok(event.message.includes('执行'))
  assert.equal(event.delegated, false)

  // Clean up
  runner.resolve({ content: 'done' })
  if (internal.progressCheckTimer) clearInterval(internal.progressCheckTimer)
  if (internal.progressTimer) clearInterval(internal.progressTimer)
})

test('progress check handles no activity gracefully', async () => {
  const manager = new TaskManager({ progressCheckMs: 30 })
  const progressEvents = []
  manager.subscribe(event => {
    if (event.type === 'task.progress.check') progressEvents.push(event)
  })

  // Runner that blocks but doesn't push any activity
  let resolveRunner
  const noActivityRunner = async () => new Promise(r => { resolveRunner = r })

  const task = createWorkTask(manager, {
    objective: '无活动任务',
    runner: noActivityRunner,
  })

  const internal = manager.tasks.get(task.id)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(manager.get(task.id).status, 'running')
  assert.equal(internal.activity.length, 0)

  await new Promise(resolve => setTimeout(resolve, 60))

  assert.ok(progressEvents.length > 0)
  const event = progressEvents[0]
  assert.ok(event.message.includes('正在处理中'))

  resolveRunner({ content: 'done' })
  if (internal.progressCheckTimer) clearInterval(internal.progressCheckTimer)
  if (internal.progressTimer) clearInterval(internal.progressTimer)
})

test('delegated task progress check uses Gateway-known activity', async () => {
  const manager = new TaskManager({ progressCheckMs: 30 })

  const progressEvents = []
  manager.subscribe(event => {
    if (event.type === 'task.progress.check') progressEvents.push(event)
  })

  // Runner that blocks — gives us time to simulate delegation
  let resolveRunner
  const blockingRunner = async () => new Promise(r => { resolveRunner = r })

  const task = createWorkTask(manager, {
    objective: '委托任务',
    runner: blockingRunner,
  })

  const internal = manager.tasks.get(task.id)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(manager.get(task.id).status, 'running')

  // Simulate delegation
  internal.status = 'delegated'
  internal.delegation = {
    id: 'delegated-session',
    sessionId: 'session-2',
    status: 'running',
  }

  await new Promise(resolve => setTimeout(resolve, 60))

  assert.ok(progressEvents.length > 0)
  const event = progressEvents[0]
  assert.equal(event.delegated, true)
  assert.ok(event.message.includes('正在处理中'))

  resolveRunner({ content: 'done' })
  if (internal.progressCheckTimer) clearInterval(internal.progressCheckTimer)
  if (internal.progressTimer) clearInterval(internal.progressTimer)
})

test('progress check timer stops after task completes', async () => {
  const manager = new TaskManager({ progressCheckMs: 30 })
  const progressEvents = []
  manager.subscribe(event => {
    if (event.type === 'task.progress.check') progressEvents.push(event)
  })

  let resolveRunner
  const task = createWorkTask(manager, {
    objective: '完成后停止进度检查',
    runner: () => new Promise(resolve => {
      resolveRunner = resolve
    }),
  })

  const internal = manager.tasks.get(task.id)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(manager.get(task.id).status, 'running')

  // Complete the task
  resolveRunner({ content: '完成' })
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(manager.get(task.id).status, 'completed')
  assert.equal(internal.progressCheckTimer, null)

  // Wait beyond the check interval — no new events should arrive
  const countBefore = progressEvents.length
  await new Promise(resolve => setTimeout(resolve, 80))
  assert.equal(progressEvents.length, countBefore)

  if (internal.progressTimer) clearInterval(internal.progressTimer)
})

test('scheduled tasks stay quiet while they run', async () => {
  const manager = new TaskManager({ progressCheckMs: 30 })
  const progressEvents = []
  manager.subscribe(event => {
    if (event.type === 'task.progress.check') progressEvents.push(event)
  })

  const runner = blockingRunner()
  const task = manager.createScheduled({
    objective: '安静执行的定时任务',
    ownerId: 'owner',
    sessionId: 'voice',
    turnId: 'turn-1',
    schedule: { at: Date.now() - 1000, recurrence: 'once' },
    type: 'task',
    runner,
  })
  const internal = manager.tasks.get(task.id)
  internal.status = 'queued'
  manager.drain()

  await new Promise(resolve => setImmediate(resolve))
  assert.equal(manager.get(task.id).status, 'running')
  assert.equal(manager.get(task.id).progressCheckMs, null)

  await new Promise(resolve => setTimeout(resolve, 60))
  assert.equal(progressEvents.length, 0)
  assert.equal(internal.progressCheckTimer, null)

  runner.resolve({ content: 'done' })
  if (internal.timeoutTimer) clearTimeout(internal.timeoutTimer)
  if (internal.progressTimer) clearInterval(internal.progressTimer)
})
