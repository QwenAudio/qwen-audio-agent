import assert from 'node:assert/strict'
import test from 'node:test'
import { TaskRepository } from '../src/task/task-repository.mjs'

test('owns persisted records and the durable short job-id cursor', () => {
  const saves = []
  const store = {
    nextJobNumber: 7,
    load: () => [{ id: 'restored' }],
    save: (tasks, state) => saves.push({ tasks, state }),
  }
  const repository = new TaskRepository({
    store,
    serialize: task => ({ id: task.id, status: task.status }),
  })

  assert.deepEqual(repository.load(), [{ id: 'restored' }])
  assert.equal(repository.allocateJobId(), 'job_7')
  repository.set('work-one', { id: 'work-one', status: 'running', secret: true })
  repository.save()

  assert.deepEqual(saves, [{
    tasks: [{ id: 'work-one', status: 'running' }],
    state: { nextJobNumber: 8 },
  }])
})

test('cycles job ids and falls back to synchronous persistence', () => {
  let saved
  const repository = new TaskRepository({
    store: {
      save: (tasks, state) => { saved = { tasks, state } },
    },
  })
  repository.nextJobNumber = 99_999
  repository.set('work-one', { id: 'work-one' })

  assert.equal(repository.allocateJobId(), 'job_99999')
  assert.equal(repository.allocateJobId(), 'job_1')
  repository.saveDeferred()

  assert.deepEqual(saved.state, { nextJobNumber: 2 })
  assert.deepEqual(saved.tasks, [{ id: 'work-one' }])
})

test('uses deferred persistence when the store supports it', () => {
  let deferred
  const repository = new TaskRepository({
    store: {
      saveDeferred: (tasks, state) => { deferred = { tasks, state } },
    },
  })
  repository.set('work-one', { id: 'work-one' })

  repository.saveDeferred()

  assert.deepEqual(deferred, {
    tasks: [{ id: 'work-one' }],
    state: { nextJobNumber: 1 },
  })
})
