import assert from 'node:assert/strict'
import test from 'node:test'
import { TaskManager } from '../src/task/task-manager.mjs'
import { PermissionPolicy } from '../src/task/permission-policy.mjs'
import { TaskOperations } from '../src/orchestration/task-operations.mjs'
import { GatewayClientCommandRuntime } from '../src/client/client-command-runtime.mjs'
import { ToolCallHandler } from '../src/frontend/tools/tool-call-handler.mjs'
import { TurnTranscripts } from '../src/frontend/tools/turn-transcripts.mjs'

const context = { ownerId: 'owner', sessionId: 'conversation', turnId: 'turn' }
const tick = () => new Promise(resolve => setImmediate(resolve))
function deferred() {
  let resolve
  let reject
  const promise = new Promise((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

function harness(t) {
  const manager = new TaskManager()
  const policy = new PermissionPolicy({ taskManager: manager })
  const runs = new Map()
  const decisions = []
  const inputs = []
  const permissionAck = deferred()
  const backendRuntime = {
    run: async (input, execution) => {
      const pending = deferred()
      runs.set(execution.taskId, { ...pending, input, ...execution })
      execution.signal.addEventListener('abort', () => pending.reject(execution.signal.reason), { once: true })
      return pending.promise
    },
    cancel: async () => ({ layer: 'backend', state: 'cancelled' }),
  }
  const operations = new TaskOperations({
    taskManager: manager, backendRuntime, permissionPolicy: policy,
    respondAuthorization: async (taskId, id, decision, identity) => {
      decisions.push({ taskId, id, decision, identity })
      await permissionAck.promise
      const permission = { id, status: decision === 'reject' ? 'rejected' : 'approved' }
      runs.get(taskId)?.onEvent({ type: 'backend.permission.resolved', permission })
      return permission
    },
    respondInput: async (...args) => { inputs.push(args); return { status: 'accepted' } },
  })
  const client = new GatewayClientCommandRuntime({
    taskManager: manager, taskOperations: operations,
    conversationHistory: { messages: () => [] },
  })
  const outputs = []
  const transcripts = new TurnTranscripts({ waitMs: 1 })
  const voice = new ToolCallHandler({
    ...context, taskManager: manager, taskOperations: operations, transcripts,
    getFrontend: () => ({ sendFunctionOutput: async (...args) => outputs.push(args) }),
    getTurnId: () => context.turnId, getTurnGeneration: () => 1,
  })
  t.after(async () => {
    permissionAck.resolve()
    await Promise.all(operations.list(context, { sessionId: undefined, active: true })
      .map(task => operations.cancel(task.id, context)))
    policy.close()
    transcripts.close()
  })
  const create = (objective = 'client work', identity = context) => client.createTask({
    event_id: objective, message: { parts: [{ type: 'text', text: objective }] },
  }, identity)
  const permission = (taskId, id) => runs.get(taskId).onEvent({
    type: 'backend.permission.requested', permission: { id, status: 'pending', summary: 'read a file' },
  })
  return { manager, operations, policy, runs, decisions, inputs, permissionAck, client, voice, outputs, transcripts, create, permission }
}

test('voice and client submission share one owner lane, deduplication and task identity', async t => {
  const h = harness(t)
  h.transcripts.record(context.turnId, 'read memory')
  await h.voice.handle({ call_id: 'spawn', name: 'spawn_thinking', arguments: '{"objective":"read memory"}' })
  const receipt = h.outputs[0][1]
  assert.equal(receipt.status, 'accepted')
  assert.match(receipt.task_id, /^task_\d+$/u)
  await tick()
  const first = h.client.getTask(receipt.task_id, context)
  assert.equal(first.turnId, context.turnId)
  assert.equal(first.status, 'running')
  assert.equal(h.runs.get(first.id).input.objective, 'read memory')
  const queued = h.create()
  assert.equal(h.create().id, queued.id)
  await tick()
  assert.equal(h.client.getTask(queued.id, context).status, 'queued')
  assert.equal(h.runs.size, 1)
  await h.voice.handle({ call_id: 'duplicate', name: 'spawn_thinking', arguments: '{"objective":"read memory"}' })
  assert.equal(h.outputs.at(-1)[1].status, 'duplicate')
  assert.equal(h.outputs.at(-1)[1].task_id, first.id)
  h.runs.get(first.id).resolve({ content: '24 GB' })
  await h.manager.wait(first.id)
  await tick()
  assert.equal(h.runs.size, 2)
  assert.equal(h.client.getTask(first.id, context).notificationStatus, 'pending')
  const count = h.runs.size
  await h.voice.getAgentTaskStatus('status', context.turnId, { task_id: first.id })
  assert.equal(h.outputs.at(-1)[1].result, '24 GB')
  assert.equal(h.runs.size, count, 'status reads do not run the backend')
})

test('cancellation preserves finalizing semantics and does not become a completion delivery', async t => {
  const h = harness(t)
  const task = h.create()
  await tick()
  const run = h.runs.get(task.id)
  run.onEvent({ type: 'backend.delegated', delegation: { id: 'child', sessionId: 'project' } })
  run.onEvent({ type: 'backend.delegation.completed', delegation: { id: 'child', sessionId: 'project' } })
  assert.equal(h.operations.get(task.id, context).status, 'finalizing')
  const receipt = await h.client.cancelTask(task.id, context)
  assert.equal(receipt.status, 'cancelling')
  const cancelled = await h.manager.wait(task.id)
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(h.manager.tasks.get(task.id).cancellation.layer, 'finalizing')
  assert.equal(cancelled.notificationStatus, 'none')
  assert.equal(run.signal.aborted, true)
})

test('voice approval of a client-created task is immediate; card waits on the same decision', async t => {
  const h = harness(t)
  const task = h.create()
  await tick()
  h.permission(task.id, 'p1')
  h.transcripts.record(context.turnId, 'allow this work')
  await h.voice.handle({ call_id: 'approve', name: 'respond_permission', arguments: '{"decision":"task"}' })
  assert.equal(h.outputs.at(-1)[1].status, 'submitted')
  assert.equal(h.policy.shouldAutoAllow(context.ownerId, context.sessionId, task.id), true)
  let cardFinished = false
  const card = h.client.respondPermission({ permission_id: 'p1', decision: 'task' }, context)
    .then(result => { cardFinished = true; return result })
  await tick()
  assert.equal(cardFinished, false)
  assert.equal(h.decisions.length, 1)
  assert.throws(() => h.operations.submitPermission('p1', 'reject', context), { code: 'permission_already_submitted' })
  h.permissionAck.resolve()
  assert.equal((await card).status, 'approved')
  h.permission(task.id, 'p2')
  await tick()
  assert.deepEqual(h.decisions.map(item => item.id), ['p1', 'p2'])
  assert.equal(h.manager.get(task.id).authorization, null)
  h.runs.get(task.id).resolve({ content: 'done' })
  await h.manager.wait(task.id)
  assert.equal(h.operations.permissions.size, 0)
  assert.equal(h.policy.tasks.size, 0)
})

test('task operations enforce ownership/session permissions and explicit input correlation', async t => {
  const h = harness(t)
  const task = h.create()
  await tick()
  h.permission(task.id, 'p1')
  for (const identity of [{ ownerId: 'another' }, { ...context, sessionId: 'other' }]) {
    assert.equal(h.operations.pendingPermissions(identity).size, 0)
    assert.throws(() => h.operations.submitPermission('p1', 'always', identity), { code: 'permission_not_found' })
  }
  assert.equal(h.operations.get(task.id, { ownerId: 'another' }), null)
  assert.equal(await h.operations.cancel(task.id, { ownerId: 'another' }), null)
  assert.throws(() => h.operations.list({}), { code: 'unauthorized' })
  assert.throws(() => h.operations.submitPermission('p1', 'unknown', context), { code: 'invalid_permission_response' })
  h.runs.get(task.id).onEvent({ type: 'backend.input.requested', input: {
    id: 'input-one', status: 'pending', prompt: 'Which directory?', mode: 'text',
  } })
  assert.throws(() => h.operations.respondToInput(task.id, 'wrong', {}, context), { code: 'input_not_found' })
  assert.throws(() => h.operations.respondToInput(task.id, 'input-one', {}, { ownerId: 'other' }), { code: 'input_not_found' })
  await h.client.respondToInput({ task_id: task.id, input_request_id: 'input-one', action: 'accept', text: '/tmp/project' }, context)
  assert.equal(h.inputs.length, 1)
  assert.equal(h.inputs[0][0], task.id)
  assert.equal(h.runs.size, 1)
  h.runs.get(task.id).resolve({ content: 'Would you like anything else?' })
  const completed = await h.manager.wait(task.id)
  assert.equal(completed.status, 'completed')
  assert.equal(completed.inputRequest, null, 'natural language does not create an input request')
})

test('card acknowledgements stay request-specific and do not wait for a slower concurrent permission', async t => {
  const h = harness(t)
  const task = h.create()
  await tick()
  h.permission(task.id, 'slow')
  h.permission(task.id, 'fast')
  const slow = deferred()
  const fast = deferred()
  h.operations.respondAuthorization = (_taskId, id) => id === 'slow' ? slow.promise : fast.promise
  const admission = h.operations.submitPermission('slow', 'task', context)
  const card = h.client.respondPermission({ permission_id: 'fast', decision: 'task' }, context)
  fast.resolve({ id: 'fast', status: 'approved' })
  assert.deepEqual(await card, { id: 'fast', status: 'approved' })
  assert.equal(h.operations.decisions.has('slow'), true)
  slow.resolve({ id: 'slow', status: 'approved' })
  await admission.completion
  assert.equal(h.operations.decisions.size, 0)
})

test('all concurrent permission requests are retained and failed decisions roll back policy', async t => {
  const h = harness(t)
  const task = h.create()
  await tick()
  h.permission(task.id, 'p1')
  h.permission(task.id, 'p2')
  assert.equal(h.operations.pendingPermissions(context).size, 2)
  const failed = []
  const admitted = h.operations.submitPermission('p1', 'always', context, {
    onFailure: event => failed.push(event.permissionId),
  })
  const joinedFailures = []
  h.operations.submitPermission('p1', 'always', context, {
    onFailure: event => joinedFailures.push(event.permissionId),
  })
  h.permissionAck.reject(new Error('backend disconnected'))
  await assert.rejects(admitted.completion, /backend disconnected/u)
  assert.equal(h.policy.shouldAutoAllow(context.ownerId, context.sessionId, task.id), false)
  assert.deepEqual(failed.sort(), ['p1', 'p2'])
  assert.deepEqual(joinedFailures.sort(), ['p1', 'p2'])
  assert.equal(h.operations.decisions.size, 0)
  assert.equal(h.operations.pendingPermissions(context).size, 2)
})

test('scheduled execution reuses permission forwarding and cleans pending requests on failure', async t => {
  const h = harness(t)
  h.manager.configureScheduledTaskRunner((objective, execution) => h.operations.runScheduled(objective, execution))
  const task = h.manager.createScheduled({
    ...context, objective: 'check tomorrow', type: 'task', schedule: { at: Date.now() + 60_000 },
  })
  // Exercise the restart path: functions are not part of persisted Task data.
  const restored = h.manager.tasks.get(task.id)
  restored.runner = null
  restored.status = 'queued'
  h.manager.drain()
  await tick()
  assert.equal(h.runs.get(task.id).turnId, context.turnId)
  h.permission(task.id, 'scheduled-permission')
  assert.equal(h.operations.pendingPermissions(context).size, 1)
  h.runs.get(task.id).reject(new Error('execution failed'))
  const failed = await h.manager.wait(task.id)
  assert.equal(failed.status, 'failed')
  assert.equal(failed.notificationStatus, 'pending')
  assert.equal(h.operations.permissions.size, 0)
})

test('closing a frontend transcript does not cancel accepted work; a replacement can query it', async t => {
  const h = harness(t)
  const task = h.voice.createWork({ objective: 'continue without voice', turnId: context.turnId })
  await tick()
  h.transcripts.close()
  const replacement = new GatewayClientCommandRuntime({
    taskManager: h.manager, taskOperations: h.operations,
    conversationHistory: { messages: () => [] },
  })
  assert.equal(replacement.getTask(task.id, context).status, 'running')
  assert.equal(h.runs.get(task.id).signal.aborted, false)
  h.runs.get(task.id).resolve({ content: 'done while disconnected' })
  await h.manager.wait(task.id)
  assert.equal(replacement.getTask(task.id, context).notificationStatus, 'pending')
  assert.equal(h.runs.size, 1)
})
