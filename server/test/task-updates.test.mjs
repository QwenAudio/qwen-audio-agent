import assert from 'node:assert/strict'
import test from 'node:test'
import { TaskManager } from '../src/task/task-manager.mjs'
import { TaskOperations } from '../src/orchestration/task-operations.mjs'
import { PermissionPolicy } from '../src/task/permission-policy.mjs'
import { GatewayClientCommandRuntime } from '../src/client/client-command-runtime.mjs'
import { ToolCallHandler } from '../src/frontend/tools/tool-call-handler.mjs'
import { TurnTranscripts } from '../src/frontend/tools/turn-transcripts.mjs'
import { persistedTask, publicTask } from '../src/task/task-state.mjs'

const context = { ownerId: 'owner', sessionId: 'conversation', turnId: 'turn-A' }
const tick = () => new Promise(resolve => setImmediate(resolve))
const continuation = { adapter: 'fake', token: 'opaque-context' }
function setup(t, options) {
  const manager = new TaskManager(options)
  const policy = new PermissionPolicy({ taskManager: manager })
  const calls = []
  const updates = []
  const backend = {
    canUpdate: () => true,
    run(input, execution) {
      const pending = Promise.withResolvers()
      calls.push({ ...pending, input, execution })
      execution.signal.addEventListener('abort', () => pending.reject(new Error('cancelled')), { once: true })
      return pending.promise
    },
    update(taskId, input, identity) {
      const pending = Promise.withResolvers()
      updates.push({ taskId, input, identity, ...pending })
      return { completion: pending.promise }
    },
    async cancel() { return { state: 'cancelled' } },
  }
  const ops = new TaskOperations({ taskManager: manager, backendRuntime: backend, permissionPolicy: policy })
  t.after(async () => {
    await Promise.all(ops.list(context, { active: true }).map(task => ops.cancel(task.id, context)))
    updates.forEach(update => update.resolve())
    policy.close()
  })
  const create = objective => ops.submit({ objective }, context)
  const update = (id, instruction = 'adjust', extra = {}) => ops.update({ taskId: id, instruction, ...extra }, context)
  return { manager, ops, backend, calls, updates, policy, create, update }
}

test('explicit capacity two runs two works; a third queues and updates target only the original work', async t => {
  const h = setup(t, { maxConcurrent: 2, maxConcurrentPerOwner: 2 })
  const a = h.create('A')
  await tick()
  const b = h.create('B')
  const c = h.create('C')
  await tick()
  assert.equal(h.update(a.id).status, 'accepted')
  assert.equal(h.ops.get(b.id, context).status, 'running')
  assert.equal(h.ops.get(c.id, context).status, 'queued')
  assert.equal(h.calls.length, 2)
  assert.equal(h.updates[0].taskId, a.id)
  h.updates[0].resolve()
  await tick()
  assert.equal(h.ops.get(a.id, context).updates[0].status, 'delivered')
  h.calls[0].resolve({ content: 'A done', continuation })
  await h.manager.tasks.get(a.id).promise
  await tick()
  assert.equal(h.calls[2].execution.taskId, c.id)
  assert.equal(h.ops.get(b.id, context).status, 'running')
})

test('default queued updates stay queued without another worker while the current task can still be steered', async t => {
  const h = setup(t)
  const a = h.create('A')
  const b = h.create('B')
  await tick()
  assert.equal(h.update(b.id, 'B new requirement').status, 'accepted')
  assert.equal(h.ops.get(b.id, context).status, 'queued')
  assert.equal(h.calls.length, 1)
  assert.equal(h.updates.length, 0)
  assert.equal(h.manager.scheduler.active.size, 1)
  assert.equal(h.update(a.id, 'A adjusted requirement').status, 'accepted')
  assert.equal(h.updates.length, 1)
  assert.equal(h.updates[0].taskId, a.id)
  assert.equal(h.calls.length, 1)
  h.updates[0].resolve()
  await tick()
  assert.equal(h.ops.get(a.id, context).updates[0].status, 'delivered')
  h.calls[0].resolve({ content: 'A done', continuation })
  await h.manager.tasks.get(a.id).promise
  await tick()
  assert.equal(h.calls.length, 2)
  assert.equal(h.calls[1].execution.taskId, b.id)
  assert.match(h.calls[1].input.instruction, /B new requirement/u)
  assert.equal(h.updates.length, 1)
  h.calls[1].resolve({ content: 'B done', continuation })
  await h.manager.tasks.get(b.id).promise
  assert.equal(h.ops.get(b.id, context).updates[0].status, 'delivered')
})

test('immediate updates before runner admission are included, not rejected as missing active work', async t => {
  const h = setup(t)
  const a = h.create('A')
  assert.equal(h.update(a.id, 'immediate change').status, 'accepted')
  await tick()
  assert.equal(h.updates.length, 0)
  assert.match(h.calls[0].input.instruction, /immediate change/u)
})

test('recovered delegated work rejects updates instead of accepting undeliverable queued instructions', async t => {
  const saved = {
    id: 'task_1', ownerId: context.ownerId, sessionId: context.sessionId,
    objective: 'recover existing project work', scope: 'user', kind: 'work',
    status: 'delegated', createdAt: Date.now(),
    delegation: { id: 'child-task', sessionId: 'project-session' },
  }
  const manager = new TaskManager({ store: { load: () => [saved], save() {} } })
  const done = Promise.withResolvers()
  manager.recoverDelegated({
    canRecover: () => true,
    runner: (_task, execution) => {
      execution.onEvent({ type: 'backend.delegated', delegation: saved.delegation })
      return done.promise
    },
  })
  t.after(async () => {
    done.resolve({ content: 'recovered work finished' })
    await manager.wait(saved.id)
  })
  await tick()
  let deliveries = 0
  const ops = new TaskOperations({ taskManager: manager, backendRuntime: {
    canUpdate: () => true,
    update() { deliveries += 1; return { completion: Promise.resolve() } },
  } })
  assert.equal(ops.get(saved.id, context).status, 'delegated')
  assert.throws(() => ops.update({ taskId: saved.id, instruction: 'new requirement' }, context), {
    code: 'update_unsupported',
  })
  assert.equal(deliveries, 0)
  assert.equal(ops.get(saved.id, context).updates, undefined)
})

test('active delegated work still lets its adapter decide whether updates are supported', async t => {
  const h = setup(t)
  const task = h.create('delegated work')
  await tick()
  h.calls[0].execution.onEvent({
    type: 'backend.delegated', delegation: { id: 'child-task', sessionId: 'project-session' },
  })
  assert.equal(h.update(task.id, 'new requirement').status, 'accepted')
  assert.equal(h.updates.length, 1)
  assert.equal(h.updates[0].taskId, task.id)
})

test('cannot continue while the old result has an active announcement lease', async t => {
  const h = setup(t)
  const a = h.create('A')
  await tick()
  h.calls[0].resolve({ content: 'done', continuation })
  await h.manager.tasks.get(a.id).promise
  h.manager.claimNotifications({ ownerId: context.ownerId, claimantId: 'voice' })
  assert.throws(() => h.update(a.id), { code: 'update_busy' })
  assert.equal(h.ops.get(a.id, context).status, 'completed')
})

test('completed continuation reuses the Task, keeps prior result, and ignores stale execution events', async t => {
  const h = setup(t)
  const a = h.create('A')
  await tick()
  h.calls[0].resolve({ content: 'first result', continuation })
  await h.manager.tasks.get(a.id).promise
  h.update(a.id, 'continue A')
  await tick()
  assert.equal(h.ops.list(context).length, 1)
  assert.equal(h.calls[1].execution.taskId, a.id)
  assert.deepEqual(h.calls[1].input.resumeContext, continuation)
  assert.match(h.calls[1].input.instruction, /continue A/u)
  h.calls[0].execution.onEvent({ type: 'backend.message', message: 'obsolete event' })
  assert.equal(h.ops.get(a.id, context).message, null)
  assert.equal(h.manager.tasks.get(a.id).previousResults[0].result, 'first result')
  assert.equal('backendContext' in publicTask(h.manager.tasks.get(a.id)), false)
})

test('a late cancelled execution cannot clear permissions from a newer continuation', async t => {
  const h = setup(t)
  const task = h.create('work')
  await tick()
  h.calls[0].resolve({ content: 'first result', continuation })
  await h.manager.wait(task.id)
  h.backend.run = (input, execution) => {
    const pending = Promise.withResolvers()
    h.calls.push({ ...pending, input, execution })
    return pending.promise
  }
  t.after(() => h.calls.forEach(call => call.resolve({ content: 'done' })))
  h.update(task.id, 'first continuation')
  await tick()
  await h.ops.cancel(task.id, context)
  h.update(task.id, 'second continuation')
  await tick()
  for (const id of ['new-permission-one', 'new-permission-two']) {
    h.calls[2].execution.onEvent({ type: 'backend.permission.requested', permission: {
      id, status: 'pending', category: 'read', summary: id,
    } })
  }
  h.calls[1].resolve({ content: 'late cancelled result' })
  await tick()
  assert.deepEqual([...h.ops.pendingPermissions(context).keys()], ['new-permission-one', 'new-permission-two'])
})

for (const cancelSeries of [false, true]) {
  test(`late ${cancelSeries ? 'series' : 'task'} cancellation cleanup cannot clear a newer execution's permissions`, async t => {
    const h = setup(t)
    const task = h.create('work')
    await tick()
    h.calls[0].resolve({ content: 'first result', continuation })
    await h.manager.wait(task.id)
    h.update(task.id, 'first continuation')
    await tick()
    const acknowledgement = Promise.withResolvers()
    t.after(() => acknowledgement.resolve())
    const method = cancelSeries ? 'cancelSeries' : 'cancel'
    const cancel = h.manager[method].bind(h.manager)
    h.manager[method] = async (...args) => {
      const result = await cancel(...args)
      await acknowledgement.promise
      return result
    }
    if (cancelSeries) h.manager.tasks.get(task.id).seriesId = 'test-series'
    const cancelled = cancelSeries
      ? h.ops.cancelSeries('test-series', context)
      : h.ops.cancel(task.id, context)
    await tick()
    assert.equal(h.ops.get(task.id, context).status, 'cancelled')
    h.update(task.id, 'second continuation')
    await tick()
    for (const id of ['new-permission-one', 'new-permission-two']) {
      h.calls[2].execution.onEvent({ type: 'backend.permission.requested', permission: {
        id, status: 'pending', category: 'read', summary: id,
      } })
    }
    acknowledgement.resolve()
    await cancelled
    assert.deepEqual([...h.ops.pendingPermissions(context).keys()], ['new-permission-one', 'new-permission-two'])
  })
}

for (const cancellationFails of [false, true]) {
  test(`immediate continuation from ${cancellationFails ? 'failed cancellation' : 'cancellation'} event keeps old and new execution promises separate`, async t => {
    const h = setup(t)
    const task = h.create('work')
    await tick()
    h.calls[0].resolve({ content: 'first result', continuation })
    await h.manager.wait(task.id)
    h.update(task.id, 'first continuation')
    await tick()
    if (cancellationFails) h.backend.cancel = async () => { throw new Error('cancel acknowledgement failed') }
    const eventType = cancellationFails ? 'task.failed' : 'task.cancelled'
    let nextExecution
    const unsubscribe = h.manager.subscribe(event => {
      if (event.type !== eventType || event.task.id !== task.id) return
      unsubscribe()
      h.update(task.id, 'immediate continuation after cancellation')
      nextExecution = h.manager.wait(task.id)
    })
    t.after(unsubscribe)
    const cancelled = await h.ops.cancel(task.id, context)
    assert.equal(cancelled.status, cancellationFails ? 'failed' : 'cancelled')
    assert.ok(nextExecution)
    let nextSettled = false
    nextExecution.then(() => { nextSettled = true })
    await tick()
    assert.equal(nextSettled, false)
    assert.equal(h.ops.get(task.id, context).status, 'running')
    h.calls[2].resolve({ content: 'new execution result', continuation })
    const result = await nextExecution
    assert.equal(result.status, 'completed')
    assert.equal(result.result, 'new execution result')
  })
}

test('ownership, exact target, capabilities, and pending questions are enforced before admitting updates', async t => {
  const h = setup(t)
  const a = h.create('A')
  assert.throws(() => h.ops.update({ taskId: a.id, instruction: 'x' }, { ownerId: 'other' }), { code: 'task_not_found' })
  assert.throws(() => h.update('missing'), { code: 'task_not_found' })
  h.backend.canUpdate = () => false
  assert.throws(() => h.update(a.id), { code: 'update_unsupported' })
  h.backend.canUpdate = () => true
  h.manager.tasks.get(a.id).inputRequest = { status: 'pending' }
  assert.throws(() => h.update(a.id), { code: 'input_response_required' })
  assert.equal(h.manager.tasks.get(a.id).updates, undefined)
})

test('duplicate receipt does not enqueue twice; delivery failure is visible in Task state', async t => {
  const h = setup(t)
  const a = h.create('A')
  await tick()
  assert.equal(h.update(a.id, 'x', { submissionKey: 'call' }).status, 'accepted')
  assert.equal(h.update(a.id, 'x', { submissionKey: 'call' }).status, 'duplicate')
  assert.equal(h.updates.length, 1)
  h.updates[0].reject(new Error('delivery unconfirmed'))
  await tick()
  assert.equal(h.ops.get(a.id, context).updates[0].status, 'failed')
  assert.equal(h.ops.get(a.id, context).updates[0].error, 'delivery unconfirmed')
})

test('changed requirements invalidate per-task permission but not the session grant', async t => {
  const h = setup(t)
  const a = h.create('A')
  h.policy.applyDecision(context.ownerId, context.sessionId, 'task', a.id)
  assert.equal(h.policy.tasks.size, 1)
  h.update(a.id)
  assert.equal(h.policy.tasks.size, 0)
  h.policy.applyDecision(context.ownerId, context.sessionId, 'always', a.id)
  h.update(a.id, 'another requirement')
  assert.equal(h.policy.mode(context.ownerId, context.sessionId), 'auto_allow')
})

test('voice and WS update share admission and return a generic acceptance, never execution details', async t => {
  const h = setup(t)
  const a = h.create('A')
  await tick()
  const outputs = []
  const transcripts = new TurnTranscripts({ waitMs: 1 })
  t.after(() => transcripts.close())
  const voice = new ToolCallHandler({
    ...context, taskManager: h.manager, taskOperations: h.ops, transcripts,
    getFrontend: () => ({ sendFunctionOutput: async (...args) => outputs.push(args) }),
    getTurnId: () => context.turnId, getTurnGeneration: () => 1,
  })
  await voice.handle({ name: 'update_agent_task', call_id: 'update-call', arguments: JSON.stringify({ task_id: a.id, instruction: 'new requirement' }) })
  assert.deepEqual(outputs[0][1], {
    status: 'accepted', task_id: a.id, message: '请求已受理，执行结果另行返回。本次只需自然确认受理。',
  })
  const client = new GatewayClientCommandRuntime({
    taskManager: h.manager, taskOperations: h.ops, conversationHistory: { messages: () => [] },
  })
  const request = { type: 'task.update', event_id: 'update-event', task_id: a.id, message: { parts: [{ type: 'text', text: 'later requirement' }] } }
  const result = await client.execute(request, context)
  assert.equal(result.type, 'task.update.result')
  assert.equal(result.status, 'accepted')
  assert.equal((await client.execute(request, context)).status, 'duplicate')
  assert.equal(h.updates.length, 2)
})

test('restart retains update intent without automatically replaying ambiguous deliveries', async t => {
  const h = setup(t)
  const a = h.create('A')
  await tick()
  h.update(a.id)
  const saved = structuredClone(persistedTask(h.manager.tasks.get(a.id)))
  const restored = new TaskManager({ store: { load: () => [saved], save() {} } })
  const task = restored.get(a.id, context)
  assert.equal(task.status, 'failed')
  assert.equal(task.updates[0].status, 'failed')
  assert.match(task.updates[0].error, /没有自动重发/u)
})
