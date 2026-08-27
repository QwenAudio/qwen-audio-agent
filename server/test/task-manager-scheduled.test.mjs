import assert from 'node:assert/strict'
import test from 'node:test'
import { TaskManager } from '../src/task/task-manager.mjs'

const trivialRunner = async objective => ({
  content: objective,
})

function persistedReminder(status, id = `work_${status}_reminder`) {
  const now = Date.now()
  return {
    id,
    status,
    kind: 'reminder',
    objective: '已到点的提醒',
    ownerId: 'owner',
    sessionId: 'voice',
    turnId: 'turn-1',
    priority: 0,
    parentTaskId: null,
    schedule: { type: 'at', at: now - 60_000, recurrence: 'once' },
    timeoutMs: null,
    createdAt: now - 60_000,
    startedAt: now - 30_000,
    completedAt: null,
    elapsedMs: 0,
    result: null,
    error: null,
    activity: [],
    delegation: null,
    cancellation: null,
    authorization: null,
    notificationStatus: 'none',
    notificationClaimantId: null,
    notificationClaimedAt: null,
    submissionKey: null,
  }
}

test('createScheduled creates a task with status scheduled and correct kind', () => {
  const manager = new TaskManager()
  const future = Date.now() + 60_000

  const reminder = manager.createScheduled({
    objective: '提醒我开会',
    ownerId: 'owner',
    sessionId: 'voice',
    turnId: 'turn-1',
    schedule: { at: future, recurrence: 'once' },
    type: 'reminder',
    runner: trivialRunner,
  })

  assert.equal(reminder.status, 'scheduled')
  assert.equal(reminder.kind, 'reminder')
  assert.deepEqual(reminder.schedule, { type: 'at', at: future, recurrence: 'once' })
  assert.equal(reminder.timeoutMs, null)
  assert.equal(reminder.reused, false)
})

test('createScheduled with type=task sets a timeout', () => {
  const manager = new TaskManager()
  const future = Date.now() + 60_000

  const task = manager.createScheduled({
    objective: '查构建状态',
    ownerId: 'owner',
    sessionId: 'voice',
    turnId: 'turn-1',
    schedule: { at: future, recurrence: 'once' },
    type: 'task',
    runner: trivialRunner,
  })

  assert.equal(task.status, 'scheduled')
  assert.equal(task.kind, 'scheduled_task')
  assert.ok(task.timeoutMs > 0)
})

test('createScheduled emits task.scheduled event', () => {
  const manager = new TaskManager()
  const events = []
  manager.subscribe(event => events.push(event.type))

  const future = Date.now() + 60_000
  manager.createScheduled({
    objective: 'test',
    ownerId: 'owner',
    sessionId: 'voice',
    turnId: 'turn-1',
    schedule: { at: future, recurrence: 'once' },
    type: 'reminder',
    runner: trivialRunner,
  })

  assert.ok(events.includes('task.scheduled'))
})

test('scheduled task is cancellable (CANCELLABLE includes scheduled)', async () => {
  const manager = new TaskManager()
  const future = Date.now() + 60_000

  const task = manager.createScheduled({
    objective: '取消我',
    ownerId: 'owner',
    sessionId: 'voice',
    turnId: 'turn-1',
    schedule: { at: future, recurrence: 'once' },
    type: 'reminder',
    runner: trivialRunner,
  })

  const result = await manager.cancel(task.id, { ownerId: 'owner' })
  assert.equal(result.status, 'cancelled')
  assert.equal(manager.get(task.id).status, 'cancelled')
})

test('scheduled task appears in list output', () => {
  const manager = new TaskManager()
  const future = Date.now() + 60_000

  manager.createScheduled({
    objective: '可见的提醒',
    ownerId: 'owner',
    sessionId: 'voice',
    turnId: 'turn-1',
    schedule: { at: future, recurrence: 'once' },
    type: 'reminder',
    runner: trivialRunner,
  })

  const tasks = manager.list({ ownerId: 'owner' })
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0].status, 'scheduled')
  assert.equal(tasks[0].kind, 'reminder')
})

test('restore re-schedules queued and running reminders for catch-up', () => {
  for (const status of ['queued', 'running']) {
    const saved = persistedReminder(status)
    const store = { load: () => [saved], save: () => {} }
    const manager = new TaskManager({ store })

    const task = manager.get(saved.id)
    assert.equal(task.status, 'scheduled', status)
    assert.equal(task.error, null, status)
    assert.equal(typeof manager.tasks.get(saved.id).runner, 'function', status)
  }
})

test('restore never re-schedules a reminder whose cancellation had started', () => {
  const saved = persistedReminder('cancelling')
  const store = { load: () => [saved], save: () => {} }
  const manager = new TaskManager({ store })

  const task = manager.get(saved.id)
  assert.equal(task.status, 'cancelled')
  assert.equal(task.notificationStatus, 'none')
  assert.equal(manager.tasks.get(saved.id).runner, null)
})

test('restore recovers scheduled tasks with reminder runner rebuilt', () => {
  const future = Date.now() + 60_000
  const saved = [{
    id: 'task_41',
    status: 'scheduled',
    kind: 'reminder',
    objective: '恢复的提醒',
    ownerId: 'owner',
    sessionId: 'voice',
    turnId: 'turn-1',
    priority: 0,
    parentTaskId: null,
    schedule: { type: 'at', at: future, recurrence: 'once' },
    timeoutMs: null,
    createdAt: Date.now(),
    startedAt: null,
    completedAt: null,
    elapsedMs: 0,
    result: null,
    error: null,
    activity: [],
    delegation: null,
    cancellation: null,
    authorization: null,
    notificationStatus: 'none',
    notificationClaimantId: null,
    notificationClaimedAt: null,
    submissionKey: null,
  }]

  const store = { load: () => saved, save: () => {} }
  const manager = new TaskManager({ store })

  const task = manager.get('task_41')
  assert.equal(task.status, 'scheduled')
  assert.equal(task.kind, 'reminder')
  // Runner should be rebuilt for reminder kind
  const internal = manager.tasks.get('task_41')
  assert.equal(typeof internal.runner, 'function')
})

test('restored scheduled_task receives its complete persisted execution context', async () => {
  const future = Date.now() + 60_000
  const saved = [{
    id: 'task_42',
    status: 'scheduled',
    kind: 'scheduled_task',
    objective: '恢复的定时任务',
    ownerId: 'owner',
    sessionId: 'voice',
    turnId: 'turn-1',
    priority: 0,
    parentTaskId: null,
    schedule: { type: 'at', at: future, recurrence: 'once' },
    timeoutMs: 1_800_000,
    createdAt: Date.now(),
    startedAt: null,
    completedAt: null,
    elapsedMs: 0,
    result: null,
    error: null,
    activity: [],
    delegation: null,
    cancellation: null,
    authorization: null,
    notificationStatus: 'none',
    notificationClaimantId: null,
    notificationClaimedAt: null,
    submissionKey: null,
  }]

  const store = { load: () => saved, save: () => {} }
  let receivedContext
  const manager = new TaskManager({ store })
  manager.configureScheduledTaskRunner(async (objective, context) => {
    receivedContext = context
    return trivialRunner(objective)
  })

  const task = manager.get('task_42')
  assert.equal(task.status, 'scheduled')
  assert.equal(task.kind, 'scheduled_task')
  // Runner is null until start() sets it from scheduledTaskRunner
  const internal = manager.tasks.get('task_42')
  assert.equal(internal.runner, null)
  internal.status = 'queued'
  manager.drain()
  const completed = await manager.wait('task_42')
  assert.equal(completed.status, 'completed')
  assert.equal(receivedContext.taskId, 'task_42')
  assert.equal(receivedContext.ownerId, 'owner')
  assert.equal(receivedContext.sessionId, 'voice')
  assert.equal(receivedContext.turnId, 'turn-1')
  assert.equal(receivedContext.kind, 'scheduled_task')
  assert.deepEqual(receivedContext.schedule, saved[0].schedule)
  assert.ok(receivedContext.signal instanceof AbortSignal)
  assert.equal(typeof receivedContext.onEvent, 'function')
})

test('createScheduled does not call drain (scheduled tasks wait)', async () => {
  const manager = new TaskManager()
  const future = Date.now() + 60_000

  manager.createScheduled({
    objective: '不立即执行',
    ownerId: 'owner',
    sessionId: 'voice',
    turnId: 'turn-1',
    schedule: { at: future, recurrence: 'once' },
    type: 'reminder',
    runner: trivialRunner,
  })

  await new Promise(resolve => setImmediate(resolve))
  const tasks = manager.list({ ownerId: 'owner' })
  assert.equal(tasks[0].status, 'scheduled')
})
