import assert from 'node:assert/strict'
import test from 'node:test'
import { AcpBackendAdapter } from '../src/backend/adapters/acp/backend-adapter.mjs'
import { BackendEventType } from '../src/core/backend-events.mjs'
import { TaskManager } from '../src/task/task-manager.mjs'

const tick = () => new Promise(resolve => setImmediate(resolve))
const identity = { ownerId: 'owner', sessionId: 'voice' }

function nativeHarness({ deferCancellation = false } = {}) {
  const cancellations = []
  const cancellation = Promise.withResolvers()
  if (!deferCancellation) cancellation.resolve()
  let remoteStopped = false
  return {
    cancellations,
    get remoteStopped() { return remoteStopped },
    confirmCancellation: () => cancellation.resolve(),
    adapter: {
      wait({ signal }) {
        return new Promise((_resolve, reject) => {
          const abort = () => reject(signal.reason)
          signal.addEventListener('abort', abort, { once: true })
          if (signal.aborted) abort()
        })
      },
      async cancel(input) {
        cancellations.push(input)
        await cancellation.promise
        remoteStopped = true
      },
    },
  }
}

function harness(t, { native, settleOnlyOnClose = false, cancelTimeoutMs = 100 } = {}) {
  const calls = []
  const sessions = new Map()
  const active = new Map()
  const registrations = []
  let clientCloseCalls = 0
  const client = {
    connectionGeneration: 1,
    async start() { return { agentCapabilities: { mcpCapabilities: { http: true } } } },
    async newSession(input) {
      const session = { sessionId: `session-${sessions.size + 1}`, cwd: input.cwd,
        connectionGeneration: 1, response: {}, input }
      sessions.set(session.sessionId, session)
      return session
    },
    async resumeSession(sessionId) { return sessions.get(sessionId) },
    prompt(sessionId, prompt, input = {}) {
      assert.equal(active.has(sessionId), false, `concurrent prompt in ${sessionId}`)
      const gate = Promise.withResolvers()
      const call = { sessionId, prompt, input, gate }
      calls.push(call)
      active.set(sessionId, call)
      const abort = () => {
        if (!settleOnlyOnClose) gate.resolve({ content: '', response: { stopReason: 'cancelled' } })
      }
      input.signal?.addEventListener('abort', abort, { once: true })
      if (input.signal?.aborted) abort()
      return gate.promise.finally(() => {
        input.signal?.removeEventListener('abort', abort)
        active.delete(sessionId)
      })
    },
    async cancelSession() {},
    async close() {
      clientCloseCalls += 1
      for (const call of active.values()) {
        call.gate.resolve({ content: '', response: { stopReason: 'cancelled' } })
      }
    },
  }
  const sessionToolServer = {
    async register(context) {
      const registration = {
        context,
        descriptor: { type: 'http', name: 'test', url: 'http://test/tools', headers: [] },
        update(next) { this.context = next },
        release() {},
      }
      registrations.push(registration)
      return registration
    },
    async close() {},
  }
  const backend = new AcpBackendAdapter({
    protocol: 'acp', directory: '/project', client, sessionStatePath: null,
    builtinMcp: [], sessionToolServer, nativeDelegationAdapter: native?.adapter,
    cancelTimeoutMs,
    profile: { label: 'Test ACP', externalMcp: true, capabilities: {},
      acpConnection: { kind: 'process' } },
  })
  t.after(async () => {
    native?.confirmCancellation()
    await client.close()
    await backend.close().catch(() => {})
    await tick()
  })
  const submit = (id, input = {}) => {
    const result = backend.submit({ id, ownerId: identity.ownerId, objective: `work ${id}`, ...input })
    result.catch(() => {})
    return result
  }
  return {
    backend, client, calls, active, submit,
    get clientCloseCalls() { return clientCloseCalls },
    context: () => registrations[0].context,
    finish: (index, content = 'done') => calls[index].gate.resolve({
      content, response: { stopReason: 'end_turn' },
    }),
  }
}

function registerNative(h, taskId) {
  return h.backend.createNativeDelegation(h.backend.coordinationRuns.get(taskId), {
    delegationId: 'native-run', sessionId: 'native-project', directory: '/project', title: 'Native work',
  })
}

for (const kind of ['acp', 'native']) {
  for (const outcome of ['failure', 'cancellation']) {
    test(`direct continuation invalidates context immediately when ${kind} child starts before coordinator ${outcome}`, async t => {
      const native = kind === 'native' ? nativeHarness() : undefined
      const h = harness(t, { native })
      let persisted = []
      const manager = new TaskManager({ store: {
        load: () => [],
        save: tasks => { persisted = structuredClone(tasks) },
      } })
      const events = []
      const runner = resumeContext => (objective, context) => h.backend.submit({
        id: context.taskId, ownerId: identity.ownerId, objective, resumeContext,
      }, {
        signal: context.signal,
        onEvent: event => { events.push(event); context.onEvent(event) },
      })
      const created = manager.create({ ...identity, objective: 'Original direct answer', runner: runner() })
      await tick()
      h.finish(0, 'Original direct result')
      await manager.wait(created.id)
      const task = manager.tasks.get(created.id)
      assert.deepEqual(task.backendContext, {
        adapter: 'acp', version: 1, token: h.calls[0].sessionId, projects: [],
      })
      const originalContext = structuredClone(task.backendContext)
      assert.deepEqual(persisted.find(item => item.id === task.id).backendContext, originalContext)
      manager.resume(task, {
        runner: runner(originalContext),
        canceler: () => h.backend.cancel(task.id, identity),
      })
      await tick()
      assert.equal(h.calls.length, 2)
      let nextStarted = false
      const next = manager.create({ ...identity, objective: 'Queued work', runner: async () => {
        nextStarted = true
        return { content: 'Next work done' }
      } })
      if (kind === 'native') registerNative(h, task.id)
      else await h.context().startSession({ prompt: 'New child work', title: 'New child' })

      assert.equal(task.backendContext, null, 'child creation must revoke the prior direct continuation immediately')
      assert.equal(persisted.find(item => item.id === task.id).backendContext, undefined,
        'the invalidation must be durable before the initial coordinator turn ends')
      const delegated = events.filter(event => event.type === BackendEventType.DELEGATED)
      assert.equal(delegated.length, 1)
      assert.equal(delegated[0].yielded, false, 'topology notification is not a coordinator yield')
      assert.equal(task.schedulerHeld, true)
      assert.deepEqual([...manager.scheduler.active.keys()], [task.id])
      await tick()
      assert.equal(nextStarted, false, 'a child must not release admission while its coordinator is still running')
      assert.equal(manager.get(next.id).status, 'queued')

      if (outcome === 'failure') h.calls[1].gate.reject(new Error('initial coordinator failed'))
      else await manager.cancel(task.id, identity)
      const terminal = await manager.wait(task.id)
      assert.equal(terminal.status, outcome === 'failure' ? 'failed' : 'cancelled')
      assert.equal(task.backendContext, null)
      assert.equal(persisted.find(item => item.id === task.id).backendContext, undefined)
      await manager.wait(next.id)
      assert.equal(nextStarted, true)
      assert.equal(h.backend.coordinationRuns.has(task.id), false)
      if (native) assert.deepEqual(native.cancellations.map(item => item.runId), ['native-run'])
      else assert.equal(h.active.size, 0)
    })
  }
}

async function startNativeWork(h) {
  const result = h.submit('native-work')
  await tick()
  registerNative(h, 'native-work')
  h.finish(0, 'Native work delegated')
  await tick()
  return { result }
}

test('close waits for native cancellation confirmation and repeated close does not cancel twice', { timeout: 3_000 }, async t => {
  const native = nativeHarness({ deferCancellation: true })
  const h = harness(t, { native, cancelTimeoutMs: 1_000 })
  const { result } = await startNativeWork(h)
  let workSettled = false
  result.finally(() => { workSettled = true }).catch(() => {})
  let closeSettled = false
  const closing = h.backend.close()
  closing.finally(() => { closeSettled = true }).catch(() => {})
  const repeated = h.backend.close()
  repeated.catch(() => {})
  await tick()
  assert.deepEqual(native.cancellations.map(item => item.runId), ['native-run'])
  assert.equal(closeSettled, false)
  assert.equal(workSettled, false)
  assert.equal(native.remoteStopped, false)
  assert.notEqual(h.backend.runtimeState.status().status, 'stopped')
  await assert.rejects(h.submit('after-close'))
  assert.equal(h.calls.length, 1, 'closing adapters must reject new Work before starting a prompt')

  native.confirmCancellation()
  await Promise.all([closing, repeated])
  await assert.rejects(result)
  assert.equal(native.remoteStopped, true)
  assert.equal(workSettled, true)
  assert.equal(h.backend.coordinationRuns.size, 0)
  assert.equal(h.backend.runtimeState.status().status, 'stopped')
  assert.equal(h.clientCloseCalls, 1)
  await h.backend.close()
  assert.equal(native.cancellations.length, 1)
  assert.equal(h.clientCloseCalls, 1)
})

test('unconfirmed native shutdown rejects after its bound, stays failed and is idempotent', { timeout: 3_000 }, async t => {
  const native = nativeHarness({ deferCancellation: true })
  const h = harness(t, { native, cancelTimeoutMs: 25 })
  const { result } = await startNativeWork(h)
  const closing = h.backend.close()
  const repeated = h.backend.close()
  await Promise.all([closing, repeated].map(promise => assert.rejects(promise, {
    code: 'cancellation_unconfirmed',
  })))
  assert.equal(native.remoteStopped, false)
  assert.equal(h.clientCloseCalls, 1, 'timeout must still close the ACP transport')
  assert.equal(h.backend.runtimeState.status().status, 'failed')
  assert.deepEqual(native.cancellations.map(item => item.runId), ['native-run'])
  await assert.rejects(h.backend.close(), { code: 'cancellation_unconfirmed' })
  assert.equal(native.cancellations.length, 1)
  assert.equal(h.clientCloseCalls, 1)
  native.confirmCancellation()
  await assert.rejects(result)
  assert.equal(h.backend.runtimeState.status().status, 'failed', 'late confirmation cannot rewrite the failed close result')
})

test('ACP prompt that only settles on connection close cannot deadlock bounded shutdown', { timeout: 3_000 }, async t => {
  const h = harness(t, { settleOnlyOnClose: true, cancelTimeoutMs: 25 })
  const result = h.submit('connection-bound')
  await tick()
  await h.context().startSession({ prompt: 'Child also waits for connection close' })
  await tick()
  h.finish(0, 'Child delegated')
  await tick()
  assert.equal(h.active.size, 1)
  await assert.rejects(h.backend.close(), { code: 'cancellation_unconfirmed' })
  assert.equal(h.clientCloseCalls, 1)
  await assert.rejects(result)
  assert.equal(h.active.size, 0)
  assert.equal(h.backend.coordinationRuns.size, 0)
  assert.equal(h.backend.runtimeState.status().status, 'failed')
})
