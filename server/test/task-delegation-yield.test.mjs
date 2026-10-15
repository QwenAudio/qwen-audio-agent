import assert from 'node:assert/strict'
import test from 'node:test'
import { BackendEventType } from '../src/core/backend-events.mjs'
import { TaskManager } from '../src/task/task-manager.mjs'
import { TaskOperations } from '../src/orchestration/task-operations.mjs'
import { persistedTask } from '../src/task/task-state.mjs'

const identity = { ownerId: 'personal', sessionId: 'voice' }
const tick = () => new Promise(resolve => setImmediate(resolve))

function harness(t, options) {
  const manager = new TaskManager(options)
  const runs = new Map()
  const releases = []
  const release = manager.scheduler.release.bind(manager.scheduler)
  manager.scheduler.release = task => {
    releases.push(task.id)
    release(task)
  }
  const execute = (input, context) => {
    const pending = Promise.withResolvers()
    const run = { ...pending, ...context, input }
    const executions = runs.get(context.taskId) || []
    executions.push(run)
    runs.set(context.taskId, executions)
    context.signal.addEventListener('abort', () => {
      pending.reject(new Error('cancelled'))
    }, { once: true })
    return pending.promise
  }
  const updates = []
  const backendRuntime = {
    run: execute,
    async cancel() { return { state: 'cancelled' } },
    canUpdate: () => true,
    update(taskId, input) {
      updates.push({ taskId, input })
      return { completion: Promise.resolve() }
    },
  }
  const operations = new TaskOperations({ taskManager: manager, backendRuntime })
  t.after(async () => {
    backendRuntime.cancel = async () => ({ state: 'cancelled' })
    await Promise.all(manager.list({ ownerId: identity.ownerId, active: true })
      .map(task => manager.cancel(task.id, identity)))
    await tick()
  })
  return {
    manager, operations, backendRuntime, runs, releases, execute, updates,
    create: objective => operations.submit({ objective }, identity),
    latest: taskId => runs.get(taskId)?.at(-1),
  }
}

function delegate(run, extra = {}) {
  run.onEvent({
    type: BackendEventType.DELEGATED,
    delegation: { id: `child-${run.taskId}`, sessionId: `project-${run.taskId}` },
    ...extra,
  })
}

test('explicit yields admit more work while independent delegated Tasks remain pending', async t => {
  const h = harness(t)
  const tasks = ['A', 'B', 'C'].map(h.create)
  await tick()
  let firstFinished = false
  h.manager.wait(tasks[0].id).then(() => { firstFinished = true })

  for (const [index, task] of tasks.entries()) {
    assert.equal(h.runs.size, index + 1)
    assert.deepEqual([...h.manager.scheduler.active.keys()], [task.id])
    delegate(h.latest(task.id), { yielded: true })
    await tick()
    assert.equal(h.operations.get(task.id, identity).status, 'delegated')
    assert.equal(h.operations.get(task.id, identity).workState, 'working')
    assert.equal(h.manager.tasks.get(task.id).schedulerHeld, false)
    assert.equal(firstFinished, false)
  }
  assert.equal(h.manager.scheduler.active.size, 0)
  assert.equal(h.operations.list(identity, { active: true }).length, 3)
  assert.deepEqual(h.releases, tasks.map(task => task.id))

  for (const task of [tasks[2], tasks[0], tasks[1]]) {
    h.latest(task.id).resolve({ content: `${task.objective} done` })
    const result = await h.manager.wait(task.id)
    assert.equal(result.result, `${task.objective} done`)
    assert.equal(result.status, 'completed')
  }
  assert.deepEqual(h.releases, tasks.map(task => task.id))
})

test('unmarked and non-boolean yields retain ordinary delegated/A2A admission', async t => {
  const h = harness(t)
  const a = h.create('ordinary delegated work')
  const b = h.create('next work')
  await tick()
  for (const extra of [{}, { yielded: false }, { yielded: 'true' }, { yielded: 1 }, {
    delegation: { id: 'child', sessionId: 'project', yielded: true },
  }]) {
    delegate(h.latest(a.id), extra)
    await tick()
    assert.equal(h.runs.has(b.id), false)
    assert.deepEqual([...h.manager.scheduler.active.keys()], [a.id])
  }
  h.latest(a.id).onEvent({ type: BackendEventType.MESSAGE, message: 'still running', yielded: true })
  h.latest(a.id).onEvent({ type: BackendEventType.DELEGATED, yielded: true })
  await tick()
  assert.equal(h.runs.has(b.id), false)
  assert.deepEqual(h.releases, [])
  h.latest(a.id).resolve({ content: 'finished' })
  await h.manager.wait(a.id)
  await tick()
  assert.equal(h.runs.has(b.id), true)
})

test('an aggregate delegation keeps all targets without persisting its admission yield', async t => {
  const h = harness(t)
  const a = h.create('parallel children')
  const b = h.create('next coordination')
  const delegation = {
    title: 'two independent project tasks',
    targets: [
      { id: 'child-one', sessionId: 'project-one' },
      { id: 'child-two', sessionId: 'project-two' },
    ],
  }
  await tick()
  delegate(h.latest(a.id), { yielded: true, delegation })
  await tick()
  assert.equal(h.runs.has(b.id), true)
  const saved = persistedTask(h.manager.tasks.get(a.id))
  assert.deepEqual(saved.delegation, delegation)
  assert.equal(Object.hasOwn(saved, 'yielded'), false)
  assert.equal(Object.hasOwn(saved, 'schedulerHeld'), false)
  assert.equal(h.operations.get(a.id, identity).delegation.title, delegation.title)
  h.latest(a.id).onEvent({ type: BackendEventType.DELEGATION_COMPLETED, delegation })
  assert.equal(h.operations.get(a.id, identity).status, 'finalizing')
  assert.deepEqual(h.manager.tasks.get(a.id).delegation.targets, delegation.targets)
  assert.deepEqual([...h.manager.scheduler.active.keys()], [b.id])
})

for (const outcome of ['completed', 'failed', 'cancelled', 'cancel_failed']) {
  test(`duplicate yields, updates and ${outcome} never release another Task's admission`, async t => {
    const h = harness(t)
    const a = h.create('delegated A')
    const b = h.create('coordinating B')
    const c = h.create('queued C')
    await tick()
    delegate(h.latest(a.id), { yielded: true })
    await tick()
    delegate(h.latest(a.id), { yielded: true })
    const receipt = h.operations.update({ taskId: a.id, instruction: 'Change the child requirements' }, identity)
    assert.equal(receipt.status, 'accepted')
    assert.equal(h.updates[0].taskId, a.id)
    await tick()
    assert.equal(h.operations.get(a.id, identity).updates[0].status, 'delivered')
    assert.deepEqual([...h.manager.scheduler.active.keys()], [b.id])

    if (outcome === 'completed') {
      h.latest(a.id).onEvent({
        type: BackendEventType.DELEGATION_COMPLETED,
        delegation: { id: 'child', sessionId: 'project' },
      })
      assert.equal(h.operations.get(a.id, identity).status, 'finalizing')
      h.latest(a.id).resolve({ content: 'A done' })
    } else if (outcome === 'failed') {
      h.latest(a.id).reject(new Error('child failed'))
    } else {
      if (outcome === 'cancel_failed') {
        h.backendRuntime.cancel = async () => { throw new Error('cannot confirm cancellation') }
      }
      await h.operations.cancel(a.id, identity)
    }
    const result = await h.manager.wait(a.id)
    assert.equal(result.status, outcome === 'cancel_failed' ? 'failed' : outcome)
    await tick()
    assert.deepEqual(h.releases, [a.id])
    assert.deepEqual([...h.manager.scheduler.active.keys()], [b.id])
    assert.equal(h.runs.has(c.id), false)
    assert.equal(h.latest(b.id).signal.aborted, false)
  })
}

test('a yield received while cancelling cannot release an unconfirmed coordinator', async t => {
  const h = harness(t)
  const a = h.create('A')
  const b = h.create('B')
  const cancellation = Promise.withResolvers()
  h.backendRuntime.cancel = () => cancellation.promise
  await tick()
  const cancelling = h.operations.cancel(a.id, identity)
  delegate(h.latest(a.id), { yielded: true })
  await tick()
  assert.equal(h.operations.get(a.id, identity).status, 'cancelling')
  assert.deepEqual([...h.manager.scheduler.active.keys()], [a.id])
  assert.equal(h.runs.has(b.id), false)
  cancellation.resolve({ state: 'cancelled' })
  await cancelling
  await tick()
  assert.deepEqual(h.releases, [a.id])
  assert.deepEqual([...h.manager.scheduler.active.keys()], [b.id])
})

test('recovery must freshly yield; saved delegation cannot bypass admission', async t => {
  const saved = [1, 2, 3].map(index => ({
    id: `task_${index}`, ownerId: identity.ownerId, sessionId: identity.sessionId,
    objective: `recovered ${index}`, scope: 'user', kind: 'work',
    status: 'delegated', createdAt: index,
    delegation: { id: `child-${index}`, sessionId: `project-${index}`, yielded: true },
  }))
  const h = harness(t, { store: { load: () => saved, save() {} } })
  h.manager.recoverDelegated({
    canRecover: () => true,
    runner: (task, context) => h.execute({ recovered: task.id }, context),
  })
  await tick()
  assert.deepEqual([...h.runs.keys()], ['task_1'])
  assert.equal(persistedTask(h.manager.tasks.get('task_2')).status, 'delegated')
  delegate(h.latest('task_1'))
  await tick()
  assert.deepEqual([...h.runs.keys()], ['task_1'])

  delegate(h.latest('task_1'), { yielded: true })
  await tick()
  assert.deepEqual([...h.runs.keys()], ['task_1', 'task_2'])
  delegate(h.latest('task_2'), { yielded: true })
  await tick()
  assert.deepEqual([...h.runs.keys()], ['task_1', 'task_2', 'task_3'])
  assert.deepEqual([...h.manager.scheduler.active.keys()], ['task_3'])
  assert.equal(h.manager.get('task_1').status, 'delegated')
  assert.equal(h.manager.get('task_2').status, 'delegated')
})

test('a resumed Task reacquires admission and ignores a previous execution yield', async t => {
  const h = harness(t)
  const a = h.create('A')
  const b = h.create('B')
  await tick()
  const original = h.latest(a.id)
  delegate(original, { yielded: true })
  await tick()
  original.resolve({ content: 'A done' })
  await h.manager.wait(a.id)
  h.manager.resume(h.manager.tasks.get(a.id), {
    runner: (_objective, context) => h.execute({ resumed: true }, context),
  })
  await tick()
  assert.equal(h.operations.get(a.id, identity).status, 'queued')
  assert.deepEqual([...h.manager.scheduler.active.keys()], [b.id])
  h.latest(b.id).resolve({ content: 'B done' })
  await h.manager.wait(b.id)
  await tick()
  const current = h.latest(a.id)
  assert.notEqual(current, original)
  assert.deepEqual([...h.manager.scheduler.active.keys()], [a.id])
  const c = h.create('C')
  original.onEvent({ type: BackendEventType.DELEGATED, yielded: true, delegation: { id: 'obsolete' } })
  await tick()
  assert.equal(h.runs.has(c.id), false)
  assert.equal(h.operations.get(a.id, identity).status, 'running')
  assert.deepEqual([...h.manager.scheduler.active.keys()], [a.id])
  delegate(current, { yielded: true })
  await tick()
  assert.deepEqual([...h.manager.scheduler.active.keys()], [c.id])
  current.resolve({ content: 'A continued' })
  assert.equal((await h.manager.wait(a.id)).result, 'A continued')
  assert.deepEqual(h.releases, [a.id, b.id, a.id])
})
