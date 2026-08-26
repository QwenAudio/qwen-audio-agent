import assert from 'node:assert/strict'
import test from 'node:test'
import { TaskManager } from '../src/task/task-manager.mjs'
import { TaskScope } from '../src/task/task-state.mjs'

test('keeps system jobs out of user work queries, events, ids, and notifications', async () => {
  const manager = new TaskManager()
  const userEvents = []
  const systemEvents = []
  manager.subscribe(event => userEvents.push(event))
  manager.subscribe(event => systemEvents.push(event), {
    scope: TaskScope.SYSTEM,
  })

  const job = manager.createSystemJob({
    objective: '索引知识文档',
    runner: async () => ({ content: '索引完成' }),
  })
  const completed = await manager.wait(job.id)

  assert.equal(job.scope, TaskScope.SYSTEM)
  assert.equal('taskId' in job, false)
  assert.equal(completed.notificationStatus, 'none')
  assert.equal(manager.get(job.id), null)
  assert.equal(manager.get(job.id, { scope: TaskScope.SYSTEM }).status, 'completed')
  assert.deepEqual(manager.list(), [])
  assert.equal(manager.list({ scope: TaskScope.SYSTEM }).length, 1)
  assert.equal(userEvents.length, 0)
  assert.equal(systemEvents.some(event => event.type === 'task.completed'), true)
  assert.equal(
    systemEvents.some(event => event.type === 'task.notification.pending'),
    false,
  )
})

test('runs system jobs in a pool independent from blocked user work', async () => {
  const manager = new TaskManager({
    maxConcurrent: 1,
    maxConcurrentPerOwner: 1,
    systemMaxConcurrent: 1,
  })
  let releaseUser
  let secondUserStarted = false
  let systemStarted = false
  const firstUser = manager.create({
    objective: '长期用户任务',
    ownerId: 'owner',
    runner: async () => new Promise(resolve => { releaseUser = resolve }),
  })
  const secondUser = manager.create({
    objective: '排队用户任务',
    ownerId: 'owner',
    runner: async () => {
      secondUserStarted = true
      return { content: '完成' }
    },
  })
  const system = manager.createSystemJob({
    objective: '刷新索引',
    runner: async () => {
      systemStarted = true
      return { content: '完成' }
    },
  })

  await new Promise(resolve => setImmediate(resolve))
  assert.equal(systemStarted, true)
  assert.equal(secondUserStarted, false)

  releaseUser({ content: '完成' })
  await Promise.all([
    manager.wait(firstUser.id),
    manager.wait(secondUser.id),
    manager.wait(system.id),
  ])
  assert.equal(secondUserStarted, true)
})

test('persists system scope without consuming user-facing task ids', async () => {
  let saved = []
  const store = {
    nextTaskNumber: 1,
    load: () => structuredClone(saved),
    save(tasks, state) {
      saved = structuredClone(tasks)
      this.nextTaskNumber = state.nextTaskNumber
    },
  }
  const first = new TaskManager({ store })
  const system = first.createSystemJob({
    objective: '重建索引',
    runner: async () => ({ content: '完成' }),
  })
  await first.wait(system.id)
  const user = first.create({
    objective: '用户工作',
    ownerId: 'owner',
    runner: async () => ({ content: '完成' }),
  })
  await first.wait(user.id)

  assert.equal(user.id, 'task_1')

  const restored = new TaskManager({ store })
  assert.equal(restored.list().length, 1)
  assert.equal(restored.list({ scope: TaskScope.SYSTEM }).length, 1)
  assert.equal(
    restored.list({ scope: TaskScope.SYSTEM })[0].id.startsWith('system_'),
    true,
  )
})
