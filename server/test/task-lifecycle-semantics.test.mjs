import assert from 'node:assert/strict'
import test from 'node:test'
import { TaskDomainEvent } from '../src/task/task-events.mjs'
import { TaskManager } from '../src/task/task-manager.mjs'

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

function memoryStore(records) {
  let state = structuredClone(records)
  return {
    get state() { return structuredClone(state) },
    load: () => structuredClone(state),
    save: tasks => { state = structuredClone(tasks) },
  }
}

function savedWork(overrides = {}) {
  return {
    id: 'task_1',
    scope: 'user',
    kind: 'work',
    status: 'running',
    objective: '完成工作',
    ownerId: 'owner',
    sessionId: 'voice',
    createdAt: 10,
    startedAt: 20,
    completedAt: null,
    elapsedMs: 0,
    activity: [],
    notificationStatus: 'none',
    ...overrides,
  }
}

test('restart durably preserves cancellation intent without a notification', () => {
  const store = memoryStore([savedWork({
    status: 'cancelling',
    notificationStatus: 'pending',
  })])

  const manager = new TaskManager({ store })

  assert.equal(manager.get('task_1').status, 'cancelled')
  assert.equal(manager.get('task_1').notificationStatus, 'none')
  assert.equal(store.state[0].status, 'cancelled')
  assert.equal(store.state[0].notificationStatus, 'none')
  assert.deepEqual(manager.claimNotifications({
    ownerId: 'owner',
    claimantId: 'desktop',
  }), [])
})

test('a recoverable delegation stays attachable across the recovery checkpoint', async () => {
  const store = memoryStore([savedWork({
    status: 'delegated',
    delegation: {
      id: 'delegation-one',
      sessionId: 'backend-session-one',
    },
  })])
  const manager = new TaskManager({ store })

  assert.equal(manager.get('task_1').status, 'queued')
  assert.equal(store.state[0].status, 'delegated')

  manager.recoverDelegated({
    canRecover: () => true,
    runner: async () => ({ content: '恢复完成' }),
  })

  const completed = await manager.wait('task_1')
  assert.equal(completed.status, 'completed')
  assert.equal(completed.result, '恢复完成')
  assert.equal(store.state[0].status, 'completed')
})

test('interrupted work becomes one durable failure delivery after restart', () => {
  const store = memoryStore([savedWork()])
  const first = new TaskManager({ store })

  assert.equal(first.get('task_1').status, 'failed')
  assert.equal(first.get('task_1').notificationStatus, 'pending')
  assert.equal(store.state[0].status, 'failed')

  const second = new TaskManager({ store })
  const claimed = second.claimNotifications({
    ownerId: 'owner',
    sessionId: 'voice',
    claimantId: 'desktop',
  })
  assert.deepEqual(claimed.map(item => item.id), ['task_1'])
  assert.equal(second.markNotificationsDelivered(
    ['task_1'],
    { claimantId: 'desktop' },
  ), 1)
  assert.equal(second.markNotificationsDelivered(
    ['task_1'],
    { claimantId: 'desktop' },
  ), 0)

  const third = new TaskManager({ store })
  assert.equal(third.get('task_1').notificationStatus, 'delivered')
  assert.deepEqual(third.claimNotifications({
    ownerId: 'owner',
    claimantId: 'replacement',
  }), [])
})

test('concurrent cancellation wins the runner race and completes once', async () => {
  const runner = deferred()
  const cancellation = deferred()
  let cancellationCalls = 0
  const terminalEvents = []
  const manager = new TaskManager()
  manager.subscribe(event => {
    if ([
      TaskDomainEvent.COMPLETED,
      TaskDomainEvent.FAILED,
      TaskDomainEvent.CANCELLED,
    ].includes(event.type)) terminalEvents.push(event.type)
  })
  const work = manager.create({
    objective: '取消竞态',
    ownerId: 'owner',
    runner: () => runner.promise,
    canceler: async () => {
      cancellationCalls += 1
      await cancellation.promise
    },
  })
  await new Promise(resolve => setImmediate(resolve))

  const first = manager.cancel(work.id, { ownerId: 'owner' })
  const second = manager.cancel(work.id, { ownerId: 'owner' })
  runner.resolve({ content: '不应完成' })
  cancellation.resolve()
  await Promise.all([first, second])

  assert.equal(cancellationCalls, 1)
  assert.equal(manager.get(work.id).status, 'cancelled')
  assert.equal(manager.get(work.id).result, null)
  assert.equal(manager.get(work.id).notificationStatus, 'none')
  assert.deepEqual(terminalEvents, [TaskDomainEvent.CANCELLED])
})
