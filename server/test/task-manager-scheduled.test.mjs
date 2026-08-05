import assert from 'node:assert/strict'
import test from 'node:test'
import { TaskManager } from '../src/task/task-manager.mjs'

const trivialRunner = async objective => ({
  content: objective,
  metadata: { presentation: { speech: objective } },
})

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
  assert.equal(reminder.progressCheckMs, null)
  assert.equal(reminder.reused, false)
})

test('createScheduled with type=task sets timeoutMs and progressCheckMs', () => {
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
  assert.ok(task.progressCheckMs > 0)
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

test('restore recovers scheduled tasks with reminder runner rebuilt', () => {
  const future = Date.now() + 60_000
  const saved = [{
    id: 'work_restored',
    status: 'scheduled',
    kind: 'reminder',
    objective: '恢复的提醒',
    ownerId: 'owner',
    sessionId: 'voice',
    turnId: 'turn-1',
    priority: 0,
    parentWorkId: null,
    schedule: { type: 'at', at: future, recurrence: 'once' },
    timeoutMs: null,
    progressCheckMs: null,
    createdAt: Date.now(),
    startedAt: null,
    completedAt: null,
    elapsedMs: 0,
    result: null,
    error: null,
    resultMetadata: null,
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

  const task = manager.get('work_restored')
  assert.equal(task.status, 'scheduled')
  assert.equal(task.kind, 'reminder')
  // Runner should be rebuilt for reminder kind
  const internal = manager.tasks.get('work_restored')
  assert.equal(typeof internal.runner, 'function')
})

test('restore recovers scheduled_task with null runner (set from scheduledTaskRunner)', () => {
  const future = Date.now() + 60_000
  const saved = [{
    id: 'work_restored_task',
    status: 'scheduled',
    kind: 'scheduled_task',
    objective: '恢复的定时任务',
    ownerId: 'owner',
    sessionId: 'voice',
    turnId: 'turn-1',
    priority: 0,
    parentWorkId: null,
    schedule: { type: 'at', at: future, recurrence: 'once' },
    timeoutMs: 1_800_000,
    progressCheckMs: 300_000,
    createdAt: Date.now(),
    startedAt: null,
    completedAt: null,
    elapsedMs: 0,
    result: null,
    error: null,
    resultMetadata: null,
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
  manager.configureScheduledTaskRunner(trivialRunner)

  const task = manager.get('work_restored_task')
  assert.equal(task.status, 'scheduled')
  assert.equal(task.kind, 'scheduled_task')
  // Runner is null until start() sets it from scheduledTaskRunner
  const internal = manager.tasks.get('work_restored_task')
  assert.equal(internal.runner, null)
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
