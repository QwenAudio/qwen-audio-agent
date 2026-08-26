import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { TaskManager } from '../src/task/task-manager.mjs'
import { TaskStore } from '../src/task/task-store.mjs'

test('persists final work and notification delivery state', async () => {
  const filePath = join(mkdtempSync(join(tmpdir(), 'qwen-audio-agent-')), 'tasks.json')
  const first = new TaskManager({ store: new TaskStore({ filePath }) })
  const work = first.create({
    objective: '保存结果',
    ownerId: 'owner',
    sessionId: 'voice',
    runner: async () => ({ content: '完成' }),
  })
  await first.wait(work.id)
  const claimed = first.claimNotifications({
    ownerId: 'owner',
    sessionId: 'voice',
    claimantId: 'client',
  })
  first.markNotificationsDelivered([claimed[0].id], { claimantId: 'client' })

  const restored = new TaskManager({ store: new TaskStore({ filePath }) })
  assert.equal(restored.get(work.id).result, '完成')
  assert.equal(restored.get(work.id).notificationStatus, 'delivered')
})

test('continues short task numbering after restart', () => {
  const filePath = join(mkdtempSync(join(tmpdir(), 'qwen-audio-agent-')), 'tasks.json')
  const first = new TaskManager({ store: new TaskStore({ filePath }) })
  const initial = first.create({ objective: 'first', ownerId: 'owner' })
  assert.equal(initial.id, 'task_1')

  const restored = new TaskManager({ store: new TaskStore({ filePath }) })
  const next = restored.create({ objective: 'second', ownerId: 'owner' })

  assert.equal(restored.get(initial.id).id, 'task_1')
  assert.equal(next.id, 'task_2')
})

test('migrates the former work and job identity into one task id', () => {
  let saved
  const store = {
    nextJobNumber: 8,
    load: () => [{
      id: 'work_legacy_uuid',
      jobId: 'job_7',
      status: 'completed',
      objective: '旧任务',
      ownerId: 'owner',
      createdAt: Date.now(),
      completedAt: Date.now(),
      notificationStatus: 'delivered',
    }],
    save: (tasks, state) => { saved = { tasks, state } },
  }

  const manager = new TaskManager({ store })

  assert.equal(manager.get('task_7').id, 'task_7')
  assert.equal('jobId' in manager.get('task_7'), false)
  assert.equal(saved.tasks[0].id, 'task_7')
  assert.equal(saved.state.nextTaskNumber, 8)
})

test('marks interrupted queued or running work as failed after restart', () => {
  const store = {
    load: () => [{
      id: 'task_41',
      status: 'running',
      objective: '未完成',
      ownerId: 'owner',
      sessionId: 'voice',
      createdAt: Date.now(),
      startedAt: Date.now(),
    }],
    save: () => {},
  }
  const manager = new TaskManager({ store })
  assert.equal(manager.get('task_41').status, 'failed')
  assert.match(manager.get('task_41').error, /重启/)
  assert.equal(manager.get('task_41').notificationStatus, 'pending')
})

test('reattaches a persisted delegated run when its adapter supports recovery', async () => {
  let saved = [{
    id: 'task_42',
    status: 'delegated',
    objective: '继续项目',
    ownerId: 'owner',
    sessionId: 'voice',
    createdAt: Date.now(),
    startedAt: Date.now(),
    delegation: {
      id: 'run-one',
      sessionId: 'agent:child:one',
      directory: '/project',
      title: '项目任务',
    },
  }]
  const manager = new TaskManager({
    store: {
      load: () => structuredClone(saved),
      save: tasks => {
        saved = structuredClone(tasks)
      },
    },
  })

  manager.recoverDelegated({
    canRecover: task => task.delegation.id === 'run-one',
    runner: async (task, { onEvent }) => {
      onEvent({
        type: 'backend.delegated',
        delegation: task.delegation,
      })
      onEvent({
        type: 'backend.delegation.completed',
        delegation: task.delegation,
      })
      return { content: '恢复后的结果' }
    },
  })

  const result = await manager.wait('task_42')
  assert.equal(result.status, 'completed')
  assert.equal(result.result, '恢复后的结果')
  assert.equal(saved[0].delegation.id, 'run-one')
  assert.equal(saved[0].delegation.sessionId, 'agent:child:one')
})

test('coalesces high-frequency task activity into a deferred atomic write', async () => {
  const filePath = join(mkdtempSync(
    join(tmpdir(), 'qwen-audio-agent-'),
  ), 'tasks.json')
  const store = new TaskStore({ filePath, deferredDelayMs: 60_000 })

  store.saveDeferred([{ id: 'work-one', activity: ['first'] }])
  store.saveDeferred([{ id: 'work-one', activity: ['latest'] }])

  assert.throws(() => readFileSync(filePath, 'utf8'), { code: 'ENOENT' })
  await store.flush()

  const saved = JSON.parse(readFileSync(filePath, 'utf8'))
  assert.deepEqual(saved.tasks[0].activity, ['latest'])
})

test('a synchronous terminal save supersedes an older deferred activity write', async () => {
  const filePath = join(mkdtempSync(
    join(tmpdir(), 'qwen-audio-agent-'),
  ), 'tasks.json')
  const store = new TaskStore({ filePath, deferredDelayMs: 60_000 })

  store.saveDeferred([{ id: 'work-one', status: 'running' }])
  store.save([{ id: 'work-one', status: 'completed' }])
  await store.flush()

  const saved = JSON.parse(readFileSync(filePath, 'utf8'))
  assert.equal(saved.tasks[0].status, 'completed')
})
