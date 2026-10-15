import assert from 'node:assert/strict'
import test from 'node:test'
import { TaskManager } from '../src/task/task-manager.mjs'
import { taskRecoveryAction, TaskRecoveryAction } from '../src/task/task-recovery.mjs'

const targets = [
  { id: 'run-one', sessionId: 'project-one', title: 'First project' },
  { id: 'run-two', sessionId: 'project-two', title: 'Second project' },
]

function savedWork(overrides = {}) {
  return {
    id: 'task_1', ownerId: 'owner', sessionId: 'voice', scope: 'user', kind: 'work',
    objective: 'Finish both projects', status: 'delegated', createdAt: 10, startedAt: 20,
    completedAt: null, elapsedMs: 0, activity: [], artifacts: [], notificationStatus: 'none',
    delegation: { targets, coordinatorSessionId: 'coordinator', title: 'Both projects' },
    ...overrides,
  }
}

test('single and complete multi-target checkpoints reattach in delegated and finalizing states', () => {
  for (const status of ['delegated', 'finalizing']) {
    for (const delegation of [targets[0], { targets }, { targets: [targets[0]] }]) {
      assert.equal(taskRecoveryAction(savedWork({ status, delegation })), TaskRecoveryAction.REATTACH)
    }
  }
})

test('invalid or incomplete aggregate checkpoints fail as a whole without top-level fallback', () => {
  for (const delegation of [
    null, {}, { targets: [] }, { targets: null }, { targets: 'bad' },
    { targets: [targets[0], null] }, { targets: [targets[0], { id: 'missing-session' }] },
    { targets: [targets[0], { sessionId: 'missing-run' }] },
    { targets: [targets[0], { id: ' ', sessionId: 'project-two' }] },
    { targets: [targets[0], { id: 'run-two', sessionId: 42 }] },
    { ...targets[0], targets: [] }, { ...targets[0], targets: [targets[1], {}] },
  ]) {
    assert.equal(taskRecoveryAction(savedWork({ delegation })), TaskRecoveryAction.FAIL)
  }
})

test('aggregate checkpoints do not override cancellation, terminal, scope or replay rules', () => {
  assert.equal(taskRecoveryAction(savedWork({ status: 'cancelling' })), TaskRecoveryAction.CANCEL)
  for (const status of ['completed', 'failed', 'cancelled']) {
    assert.equal(taskRecoveryAction(savedWork({ status })), TaskRecoveryAction.RESTORE)
  }
  for (const status of ['running', 'queued']) {
    assert.equal(taskRecoveryAction(savedWork({ status })), TaskRecoveryAction.FAIL)
    assert.equal(taskRecoveryAction(savedWork({ status, kind: 'reminder' })), TaskRecoveryAction.RESCHEDULE)
  }
  assert.equal(taskRecoveryAction(savedWork({ scope: 'system' })), TaskRecoveryAction.FAIL)
  assert.equal(taskRecoveryAction(savedWork({ status: 'scheduled' })), TaskRecoveryAction.RESCHEDULE)
})

test('TaskManager persists the whole aggregate until recovery admission and invokes only its recovery runner', async () => {
  let stored = [savedWork()]
  const manager = new TaskManager({
    store: { load: () => structuredClone(stored), save: records => { stored = structuredClone(records) } },
  })
  assert.equal(manager.get('task_1').status, 'queued')
  assert.equal(stored[0].status, 'delegated')
  assert.deepEqual(stored[0].delegation.targets, targets)
  let recoveries = 0
  manager.recoverDelegated({
    canRecover: task => task.delegation.targets.length === 2,
    runner: async task => {
      recoveries += 1
      assert.deepEqual(task.delegation.targets, targets)
      return { content: 'Both recovered' }
    },
  })
  const result = await manager.wait('task_1')
  assert.equal(result.status, 'completed')
  assert.equal(result.result, 'Both recovered')
  assert.equal(recoveries, 1)
  assert.equal(stored[0].status, 'completed')
})

test('an unsupported aggregate adapter fails recovery instead of replaying the original objective', async () => {
  const manager = new TaskManager({ store: { load: () => [savedWork()], save() {} } })
  let recoveries = 0
  manager.recoverDelegated({ canRecover: () => false, runner: async () => { recoveries += 1 } })
  assert.equal((await manager.wait('task_1')).status, 'failed')
  assert.equal(recoveries, 0)
})
