import assert from 'node:assert/strict'
import test from 'node:test'
import { TaskManager } from '../src/task/task-manager.mjs'
import { backendPermissionDecision } from '../../shared/permission-decisions.mjs'
import {
  PermissionPolicy,
} from '../src/task/permission-policy.mjs'

test('keeps task and session grants scoped to one owner and frontend session', () => {
  const policy = new PermissionPolicy()

  assert.equal(policy.mode('owner-one', 'voice-one'), 'ask')
  policy.applyDecision('owner-one', 'voice-one', 'always')
  assert.equal(policy.shouldAutoAllow('owner-one', 'voice-one'), true)
  assert.equal(policy.shouldAutoAllow('owner-one', 'voice-two'), false)
  assert.equal(policy.shouldAutoAllow('owner-two', 'voice-one'), false)

  policy.applyDecision('owner-one', 'voice-one', 'reject')
  assert.equal(policy.mode('owner-one', 'voice-one'), 'ask')

  policy.applyDecision('owner-one', 'voice-one', 'task', 'task_1')
  assert.equal(policy.mode('owner-one', 'voice-one'), 'ask')
  assert.equal(policy.shouldAutoAllow('owner-one', 'voice-one', 'task_1'), true)
  assert.equal(policy.shouldAutoAllow('owner-one', 'voice-one', 'task_2'), false)
})

test('expires inactive frontend permission sessions', () => {
  let now = 100
  const policy = new PermissionPolicy({
    ttlMs: 50,
    now: () => now,
  })
  policy.applyDecision('owner', 'voice', 'always')
  now = 151

  assert.equal(policy.shouldAutoAllow('owner', 'voice'), false)
})

const tick = () => new Promise(resolve => setImmediate(resolve))
const context = { ownerId: 'owner', sessionId: 'voice', taskId: 'task_1' }
const request = id => ({ type: 'backend.permission.requested', permission: { id, status: 'pending' } })

test('public task/session grants map only to per-operation backend decisions', () => {
  assert.equal(backendPermissionDecision('task'), 'once')
  assert.equal(backendPermissionDecision('always'), 'once')
  assert.equal(backendPermissionDecision('reject'), 'reject')
  assert.throws(() => backendPermissionDecision('once'), /Invalid permission decision/)
})

test('only approved task requests are intercepted; queued requests are drained without another prompt', async () => {
  const policy = new PermissionPolicy()
  const events = []
  const approvals = []
  const publish = event => events.push(event)
  const respond = async (taskId, id, decision, options) => {
    approvals.push({ taskId, id, decision, options })
    policy.forwardBackendEvent(context, {
      type: 'backend.permission.resolved', permission: { id, status: 'approved' },
    }, publish, respond)
  }
  const send = (id, fields = context) => policy.forwardBackendEvent(fields, request(id), publish, respond)
  send('auth-1')
  send('auth-2')
  assert.equal(approvals.length, 0) // Delivering a request never grants permission.
  policy.applyDecision('owner', 'voice', 'task', 'task_1')
  policy.flushPending('owner', 'voice')
  await tick()
  assert.deepEqual(approvals.map(item => item.id), ['auth-1', 'auth-2'])
  assert.equal(events.filter(event => event.type.endsWith('.resolved')).length, 2)
  send('auth-3')
  await tick()
  assert.equal(events.length, 4) // Neither request nor resolution leaked to the frontend.
  assert.equal(approvals.length, 3)
  assert.ok(approvals.every(item => item.decision === 'once'))
  for (const fields of [
    { ...context, taskId: 'task_2' }, // Includes independent child Tasks.
    { ...context, sessionId: 'another-session' },
    { ...context, ownerId: 'another-owner' },
  ]) send(`auth-${events.length}`, fields)
  await tick()
  assert.equal(events.length, 7)
  assert.equal(approvals.length, 3)
  assert.equal(policy.pending.size, 3)
  policy.close()
})

test('task grant is removed on completion, failure or cancellation for every task kind', async t => {
  for (const kind of ['work', 'control', 'scheduled']) {
    for (const outcome of ['completed', 'failed', 'cancelled']) {
      await t.test(`${kind}: ${outcome}`, async () => {
        const manager = new TaskManager()
        const policy = new PermissionPolicy({ taskManager: manager })
        let finish, fail
        const task = manager.create({
          ownerId: 'owner', sessionId: 'voice', objective: 'test', kind,
          runner: () => new Promise((resolve, reject) => { finish = resolve; fail = reject }),
        })
        await tick()
        const rollback = policy.applyDecision('owner', 'voice', 'task', task.id)
        assert.equal(policy.shouldAutoAllow('owner', 'voice', task.id), true)
        if (outcome === 'cancelled') {
          const cancel = manager.cancel(task.id, { ownerId: 'owner' })
          assert.equal(policy.shouldAutoAllow('owner', 'voice', task.id), false)
          finish({ content: 'late result' })
          await cancel
        } else if (outcome === 'failed') fail(new Error('test failure'))
        else finish({ content: 'done' })
        await manager.wait(task.id)
        assert.equal(policy.tasks.size, 0)
        assert.equal(policy.shouldAutoAllow('owner', 'voice', task.id), false)
        rollback()
        assert.equal(policy.tasks.size, 0)
        policy.close()
      })
    }
  }
})

test('failed delivery rollback cannot undo a newer grant; task grants are not restored after restart', () => {
  const policy = new PermissionPolicy()
  const rollback = policy.applyDecision('owner', 'voice', 'task', 'task_1')
  rollback()
  assert.equal(policy.shouldAutoAllow('owner', 'voice', 'task_1'), false)
  const rollbackEarlier = policy.applyDecision('owner', 'voice', 'always', 'task_1')
  policy.applyDecision('owner', 'voice', 'always', 'task_1')
  rollbackEarlier()
  assert.equal(policy.shouldAutoAllow('owner', 'voice', 'task_2'), true)
  policy.applyDecision('owner', 'voice', 'reject', 'task_1')
  assert.equal(policy.shouldAutoAllow('owner', 'voice', 'task_1'), false)
  assert.equal(policy.shouldAutoAllow('owner', 'voice', 'task_2'), false)
  policy.close()
  assert.equal(new PermissionPolicy().shouldAutoAllow('owner', 'voice', 'task_1'), false)
})

test('automatic delivery failure publishes the actual request once and does not retry in a loop', async () => {
  const policy = new PermissionPolicy()
  const events = []
  let attempts = 0
  policy.applyDecision('owner', 'voice', 'task', 'task_1')
  policy.forwardBackendEvent(context, request('auth-failure'), event => events.push(event), async () => {
    attempts++
    throw new Error('disconnected')
  })
  await tick()
  await tick()
  assert.equal(attempts, 1)
  assert.deepEqual(events, [request('auth-failure')])
  policy.close()
})
