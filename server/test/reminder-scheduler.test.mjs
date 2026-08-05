import assert from 'node:assert/strict'
import test from 'node:test'
import { TaskManager } from '../src/task/task-manager.mjs'
import { ReminderScheduler } from '../src/task/reminder-scheduler.mjs'

function createScheduledTask(manager, { at, objective = 'test', ownerId = 'owner', type = 'reminder', runner = null } = {}) {
  return manager.createScheduled({
    objective,
    ownerId,
    sessionId: 'voice',
    turnId: 'turn-1',
    schedule: { at, recurrence: 'once' },
    type,
    runner,
  })
}

test('reschedule registers a timer for the nearest future scheduled task', () => {
  const manager = new TaskManager()
  const scheduler = new ReminderScheduler({ taskManager: manager, staggerMs: 100 })

  const future = Date.now() + 60_000
  createScheduledTask(manager, { at: future })

  scheduler.reschedule()
  assert.equal(scheduler.timer !== null, true)

  clearTimeout(scheduler.timer)
})

test('fire transitions all due scheduled tasks to queued and re-arms', async () => {
  const manager = new TaskManager()
  const events = []
  manager.subscribe(event => events.push(event.type))

  let resolveRunner
  const runner = () => new Promise(resolve => {
    resolveRunner = resolve
  })

  const past = Date.now() - 1000
  const task = createScheduledTask(manager, {
    at: past,
    objective: 'past reminder',
    runner,
  })

  assert.equal(manager.get(task.id).status, 'scheduled')

  const scheduler = new ReminderScheduler({ taskManager: manager })
  scheduler.fire()

  // After fire(), the task is no longer scheduled. drain() may have
  // already started it (status=running).
  const status = manager.get(task.id).status
  assert.ok(['queued', 'running'].includes(status), `expected queued or running, got ${status}`)
  assert.ok(events.includes('task.running'))

  // Wait for the runner to start (it runs in a microtask scheduled by start())
  await new Promise(resolve => setImmediate(resolve))

  // Complete the task
  resolveRunner({ content: 'done' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(manager.get(task.id).status, 'completed')
})

test('restoreOverdue staggers overdue tasks with increasing delays', async () => {
  const manager = new TaskManager()
  const now = Date.now()

  // Blocking runners so tasks stay running after fire
  let resolveFirst, resolveSecond
  const firstRunner = () => new Promise(r => { resolveFirst = r })
  const secondRunner = () => new Promise(r => { resolveSecond = r })

  const first = createScheduledTask(manager, { at: now - 1000, objective: 'first', runner: firstRunner })
  const second = createScheduledTask(manager, { at: now - 500, objective: 'second', runner: secondRunner })

  const scheduler = new ReminderScheduler({ taskManager: manager, staggerMs: 50 })
  scheduler.restoreOverdue()

  // Immediately, neither should have fired yet (delay > 0 for the second)
  assert.equal(manager.get(first.id).status, 'scheduled')

  // After stagger delay (index 0 → delay 0), the first should fire
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.ok(['queued', 'running'].includes(manager.get(first.id).status))

  // Second fires after stagger (index 1 → delay 50ms)
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.ok(['queued', 'running'].includes(manager.get(second.id).status))

  // Cleanup
  resolveFirst?.({ content: 'done' })
  resolveSecond?.({ content: 'done' })
})

test('reschedule re-arms when a scheduled task is cancelled', async () => {
  const manager = new TaskManager()
  const runner = async objective => ({
    content: objective,
    metadata: { presentation: { speech: objective } },
  })

  const future = Date.now() + 60_000
  const task = createScheduledTask(manager, { at: future, runner })

  const scheduler = new ReminderScheduler({ taskManager: manager })
  scheduler.reschedule()
  assert.ok(scheduler.timer !== null)

  await manager.cancel(task.id, { ownerId: 'owner' })

  // After cancellation, reschedule should have been called by the subscriber
  // and the timer should be null (no more future tasks)
  assert.equal(scheduler.timer, null)
})

test('reschedule does nothing when no future scheduled tasks exist', () => {
  const manager = new TaskManager()
  const scheduler = new ReminderScheduler({ taskManager: manager })
  scheduler.reschedule()
  assert.equal(scheduler.timer, null)
})
