import assert from 'node:assert/strict'
import test from 'node:test'
import { AcpBackendAdapter } from '../src/backend/adapters/acp/backend-adapter.mjs'

const tick = () => new Promise(resolve => setImmediate(resolve))
const work = (id, extra = {}) => ({ id, ownerId: 'owner', objective: `work ${id}`, ...extra })

function harness(options = {}) {
  const calls = []
  const sessions = new Map()
  const registrations = []
  const steering = []
  const cancellations = []
  const client = {
    connectionGeneration: 1,
    async start() { return { agentCapabilities: { mcpCapabilities: { http: true } } } },
    async newSession(input) {
      const session = { sessionId: `session-${sessions.size + 1}`, cwd: input.cwd,
        connectionGeneration: 1, response: {}, input }
      sessions.set(session.sessionId, session)
      return session
    },
    async resumeSession(sessionId, input) {
      const session = { sessionId, cwd: input.cwd, connectionGeneration: 1, response: {}, input }
      sessions.set(sessionId, session)
      return session
    },
    prompt(sessionId, prompt, input = {}) {
      const gate = Promise.withResolvers()
      const call = { sessionId, prompt, input, gate }
      calls.push(call)
      const abort = () => {
        cancellations.push(sessionId)
        gate.resolve({ content: '', response: { stopReason: 'cancelled' } })
      }
      input.signal?.addEventListener('abort', abort, { once: true })
      return gate.promise.finally(() => input.signal?.removeEventListener('abort', abort))
    },
    steeringMode() { return 'extension' },
    async steerSession(sessionId, prompt) {
      steering.push({ sessionId, prompt })
      return { outcome: 'injected' }
    },
    async cancelSession(sessionId) { cancellations.push(sessionId) },
    async close() {},
  }
  const sessionToolServer = {
    async register(context) {
      const registration = { context,
        descriptor: { type: 'http', name: 'test', url: `http://test/${registrations.length}`, headers: [] },
        update(next) { this.context = next }, release() {},
      }
      registrations.push(registration)
      return registration
    },
    async close() {},
  }
  const backend = new AcpBackendAdapter({ protocol: 'acp', directory: '/project', client,
    builtinMcp: [], sessionToolServer,
    profile: { label: 'Test ACP', externalMcp: true, capabilities: {},
      acpConnection: { kind: 'process' } },
    ...options,
  })
  const finish = (index, content = 'done') => calls[index].gate.resolve({
    content, response: { stopReason: 'end_turn' },
  })
  return { backend, client, calls, sessions, registrations, steering, cancellations, finish }
}

test('two coordinator slots isolate MCP contexts and callbacks; the third waits and reuses an idle slot', async t => {
  const h = harness({ maxConcurrentTasks: 2 })
  t.after(() => h.backend.close())
  const events = []
  const a = h.backend.submit(work('a'), { onEvent: event => events.push(event) })
  const b = h.backend.submit(work('b'))
  const c = h.backend.submit(work('c'))
  await tick()
  assert.equal(h.calls.length, 2)
  assert.equal(h.sessions.size, 2)
  assert.notEqual(h.calls[0].sessionId, h.calls[1].sessionId)
  assert.notDeepEqual([...h.sessions.values()].map(session => session.input.mcpServers)[0],
    [...h.sessions.values()].map(session => session.input.mcpServers)[1])
  assert.deepEqual([...h.sessions.values()].map(session => session.coordinationRunId), ['a', 'b'])
  const contexts = h.registrations.map(registration => registration.context)
  h.backend.startProjectSession = async run => run.coordinationRunId
  assert.equal(await contexts[0].startSession({}), 'a')
  assert.equal(await contexts[1].startSession({}), 'b')
  h.finish(0)
  await a
  await tick()
  assert.equal(h.calls.length, 3)
  assert.equal(h.calls[2].sessionId, h.calls[0].sessionId)
  assert.equal(h.sessions.size, 2)
  assert.equal(await h.registrations[0].context.startSession({}), 'c')
  assert.throws(() => contexts[0].startSession({}), /已失效/)
  h.calls[0].input.onUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'late' } })
  assert.equal(events.length, 0)
  h.finish(1)
  h.finish(2)
  await Promise.all([b, c])
})

test('update and cancellation address only the exact running task and slot', async t => {
  const h = harness({ maxConcurrentTasks: 2 })
  t.after(() => h.backend.close())
  const a = h.backend.submit(work('a'))
  const b = h.backend.submit(work('b'))
  const rejected = assert.rejects(b, /取消/)
  await tick()
  await h.backend.update('a', { instruction: 'only a changes' }, { ownerId: 'owner' }).completion
  assert.deepEqual(h.steering.map(item => item.sessionId), [h.calls[0].sessionId])
  await h.backend.cancel('b', { ownerId: 'owner' })
  await rejected
  assert.deepEqual(h.cancellations, [h.calls[1].sessionId])
  assert.equal(h.backend.registry.reconciliationsFor('acp:owner:backend').length, 0)
  assert.equal(h.backend.registry.reconciliationsFor('acp:owner:backend:slot:1').length, 1)
  h.finish(0)
  await a
})

test('resuming old work waits for its original busy Session and never steers its new tenant', async t => {
  const h = harness({ maxConcurrentTasks: 2 })
  t.after(() => h.backend.close())
  const a = h.backend.submit(work('a'))
  await tick()
  h.finish(0)
  const original = await a
  const b = h.backend.submit(work('b'))
  await tick()
  const resumed = h.backend.submit(work('a', { resumeContext: original.continuation }))
  await tick()
  const update = h.backend.update('a', { instruction: 'queued for original work' }, { ownerId: 'owner' })
  assert.equal(h.calls.length, 2)
  assert.equal(h.sessions.size, 1)
  assert.equal(h.steering.length, 0)
  h.finish(1)
  await b
  await tick()
  assert.equal(h.calls[2].sessionId, original.continuation.token)
  assert.match(JSON.stringify(h.calls[2].prompt), /queued for original work/)
  h.finish(2)
  await Promise.all([resumed, update.completion])
})

test('slot-one continuation is restored from the registry after adapter restart', async t => {
  const h = harness({ maxConcurrentTasks: 2 })
  const a = h.backend.submit(work('a'))
  const b = h.backend.submit(work('b'))
  await tick()
  h.finish(0)
  h.finish(1)
  const [, result] = await Promise.all([a, b])
  const next = harness({ maxConcurrentTasks: 2 })
  t.after(() => next.backend.close())
  next.backend.registry.loaded = true
  next.backend.registry.coordinators = Object.fromEntries(h.backend.registry.coordinatorEntries())
  await h.backend.close()
  const resumed = next.backend.submit(work('b', { resumeContext: result.continuation }))
  await tick()
  assert.equal(next.calls[0].sessionId, 'session-2')
  assert.equal(next.backend.coordinatorSessions.has('acp:owner:backend:slot:1'), true)
  next.finish(0)
  await resumed
})

test('the default single coordinator slot serializes submissions and reuses its Session', async t => {
  const h = harness()
  t.after(() => h.backend.close())
  assert.equal(h.backend.coordinatorPool.limit, 1)
  const a = h.backend.submit(work('a'))
  const b = h.backend.submit(work('b'))
  await tick()
  assert.equal(h.calls.length, 1)
  assert.equal(h.sessions.size, 1)
  assert.match(JSON.stringify(h.calls[0].prompt), /work a/)
  h.finish(0, 'first result')
  const first = await a
  await tick()
  assert.equal(h.calls.length, 2)
  assert.equal(h.calls[1].sessionId, h.calls[0].sessionId)
  assert.equal(h.sessions.size, 1)
  assert.equal(h.registrations.length, 1)
  assert.equal(h.sessions.get(h.calls[1].sessionId).coordinationRunId, 'b')
  assert.match(JSON.stringify(h.calls[1].prompt), /work b/)
  h.finish(1, 'second result')
  const second = await b
  assert.equal(first.content, 'first result')
  assert.equal(second.content, 'second result')
  assert.deepEqual(second.continuation, first.continuation)
})

for (const mode of ['extension', 'restart']) {
  test(`the default single slot preserves active ${mode} steering without starting queued work`, async t => {
    const h = harness()
    h.client.steeringMode = () => mode
    t.after(() => h.backend.close())
    assert.equal(h.backend.coordinatorPool.limit, 1)
    const a = h.backend.submit(work('a'))
    const b = h.backend.submit(work('b'))
    await tick()
    assert.equal(h.calls.length, 1)
    const sessionId = h.calls[0].sessionId
    const update = h.backend.update('a', { instruction: 'only a changes' }, { ownerId: 'owner' })
    await tick()

    let currentPrompt = 0
    if (mode === 'extension') {
      assert.deepEqual(h.steering.map(item => item.sessionId), [sessionId])
      assert.match(JSON.stringify(h.steering[0].prompt), /only a changes/)
      assert.deepEqual(h.cancellations, [])
    } else {
      assert.deepEqual(h.steering, [])
      assert.deepEqual(h.cancellations, [sessionId])
      assert.equal(h.calls.length, 1, 'restart must wait for the old prompt to settle')
      h.calls[0].gate.resolve({ content: 'superseded result', response: { stopReason: 'cancelled' } })
      await tick()
      currentPrompt = 1
      assert.equal(h.calls[1].sessionId, sessionId)
      assert.match(JSON.stringify(h.calls[1].prompt), /only a changes/)
      assert.doesNotMatch(JSON.stringify(h.calls[1].prompt), /work b/)
      h.calls[1].input.onUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'updated' } })
    }
    assert.deepEqual(await update.completion, { status: 'delivered' })
    assert.equal(h.calls.length, currentPrompt + 1, 'queued work must not start during steering')
    assert.equal(h.sessions.size, 1)
    assert.equal(h.registrations.length, 1)
    assert.equal(h.sessions.get(sessionId).coordinationRunId, 'a')

    h.finish(currentPrompt, 'updated a result')
    assert.equal((await a).content, 'updated a result')
    await tick()
    const queuedPrompt = currentPrompt + 1
    assert.equal(h.calls.length, queuedPrompt + 1)
    assert.equal(h.calls[queuedPrompt].sessionId, sessionId)
    assert.match(JSON.stringify(h.calls[queuedPrompt].prompt), /work b/)
    assert.doesNotMatch(JSON.stringify(h.calls[queuedPrompt].prompt), /only a changes/)
    h.finish(queuedPrompt)
    await b
  })
}

test('cap one queues work, removes cancelled waiters, and releases after a prompt error', async t => {
  const h = harness({ maxConcurrentTasks: 1 })
  t.after(() => h.backend.close())
  const a = h.backend.submit(work('a'))
  const aFailure = assert.rejects(a, /backend failed/)
  const b = h.backend.submit(work('b'))
  const bFailure = assert.rejects(b, /取消/)
  const c = h.backend.submit(work('c'))
  await tick()
  assert.equal(h.calls.length, 1)
  await assert.rejects(h.backend.cancel('b', { ownerId: 'someone-else' }), /可取消/)
  await h.backend.cancel('b', { ownerId: 'owner' })
  await bFailure
  assert.equal(h.calls.length, 1)
  h.calls[0].gate.reject(new Error('backend failed'))
  await aFailure
  await tick()
  assert.equal(h.calls.length, 2)
  assert.equal(h.sessions.size, 1)
  assert.match(JSON.stringify(h.calls[1].prompt), /work c/)
  h.finish(1)
  await c
})

test('delegation retains its coordinator lease until final result consolidation', async t => {
  const h = harness({ maxConcurrentTasks: 2 })
  t.after(() => h.backend.close())
  const events = []
  const a = h.backend.submit(work('a'), { onEvent: event => events.push(event) })
  const b = h.backend.submit(work('b'))
  await tick()
  await h.registrations[0].context.startSession({ prompt: 'project a' })
  await tick()
  assert.equal(h.calls[2].sessionId, 'session-3')
  const projectSession = h.sessions.get('session-3')
  await assert.rejects(h.registrations[1].context.sendSession({
    session_id: 'session-3', prompt: 'must not replace a running project',
  }), { code: 'session_busy' })
  assert.equal(h.sessions.get('session-3'), projectSession)
  assert.equal(projectSession.coordinationRunId, 'a')
  h.finish(0, 'delegated')
  await tick()
  assert.equal(events.find(event => event.type === 'backend.delegated').delegation.coordinatorSessionId, 'session-1')
  const c = h.backend.submit(work('c'))
  await tick()
  assert.equal(h.calls.length, 3)
  h.finish(1)
  await b
  await tick()
  assert.equal(h.calls[3].sessionId, 'session-2')
  h.finish(2, 'project result')
  await tick()
  assert.equal(h.calls[4].sessionId, 'session-1')
  assert.match(JSON.stringify(h.calls[4].prompt), /project result/)
  h.finish(3)
  h.finish(4)
  await Promise.all([a, c])
})

test('OpenClaw pool slots have distinct native session keys without changing the default key', () => {
  const h = harness({ protocol: 'openclaw', coordinatorAgent: 'voice', profile: undefined,
    baseUrl: 'http://127.0.0.1:18789' })
  assert.equal(h.backend.coordinatorMeta('owner').sessionKey, 'agent:voice:qwen-audio-agent:owner:backend')
  assert.equal(h.backend.coordinatorMeta('owner', 'openclaw:owner:backend:slot:1').sessionKey,
    'agent:voice:qwen-audio-agent:owner:backend:slot:1')
})

test('native delegation recovery uses its persisted slot and reserves it until the final reply', async t => {
  const child = Promise.withResolvers()
  const h = harness({ maxConcurrentTasks: 2, nativeDelegationAdapter: { wait: () => child.promise } })
  t.after(() => h.backend.close())
  h.backend.registry.set('acp:owner:backend:slot:1', {
    sessionId: 'saved-coordinator', cwd: '/project', contractVersion: 7,
  })
  const recovered = h.backend.recoverDelegatedWork({ ...work('recovered'), delegation: {
    id: 'native-run', sessionId: 'child-session', coordinatorSessionId: 'saved-coordinator',
  } })
  await tick()
  const b = h.backend.submit(work('b'))
  const c = h.backend.submit(work('c'))
  await tick()
  assert.equal(h.calls.length, 1)
  assert.notEqual(h.calls[0].sessionId, 'saved-coordinator')
  child.resolve({ content: 'recovered child result' })
  await tick()
  assert.equal(h.calls[1].sessionId, 'saved-coordinator')
  assert.match(JSON.stringify(h.calls[1].prompt), /recovered child result/)
  h.finish(1)
  await recovered
  await tick()
  assert.equal(h.calls[2].sessionId, 'saved-coordinator')
  h.finish(0)
  h.finish(2)
  await Promise.all([b, c])
})

test('closing the pool rejects queued requests and never revives them', async () => {
  const h = harness({ maxConcurrentTasks: 1.9 })
  assert.equal(h.backend.coordinatorPool.limit, 1)
  const a = h.backend.submit(work('a'))
  const b = h.backend.submit(work('b'))
  const failures = [assert.rejects(a), assert.rejects(b)]
  await tick()
  assert.equal(h.calls.length, 1)
  await h.backend.close()
  await Promise.all(failures)
  await tick()
  assert.equal(h.calls.length, 1)
  assert.equal(h.backend.coordinatorPool.owners.size, 0)
  await assert.rejects(h.backend.submit(work('c')), /closed/)
})
