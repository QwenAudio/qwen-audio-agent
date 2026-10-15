import assert from 'node:assert/strict'
import test from 'node:test'
import { AcpBackendAdapter } from '../src/backend/adapters/acp/backend-adapter.mjs'

const tick = () => new Promise(resolve => setImmediate(resolve))
const work = (id, extra = {}) => ({ id, ownerId: 'owner', objective: `work ${id}`, ...extra })

function harness(options = {}) {
  const calls = []
  const sessions = new Map()
  const activePrompts = new Map()
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
      assert.equal(activePrompts.has(sessionId), false, `concurrent prompts in ${sessionId}`)
      const gate = Promise.withResolvers()
      const call = { sessionId, prompt, input, gate }
      calls.push(call)
      activePrompts.set(sessionId, call)
      const abort = () => {
        cancellations.push(sessionId)
        gate.resolve({ content: '', response: { stopReason: 'cancelled' } })
      }
      input.signal?.addEventListener('abort', abort, { once: true })
      return gate.promise.finally(() => {
        input.signal?.removeEventListener('abort', abort)
        activePrompts.delete(sessionId)
      })
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
    builtinMcp: [], sessionToolServer, sessionStatePath: null,
    profile: { label: 'Test ACP', externalMcp: true, capabilities: {},
      acpConnection: { kind: 'process' } },
    ...options,
  })
  const finish = (index, content = 'done') => calls[index].gate.resolve({
    content, response: { stopReason: 'end_turn' },
  })
  const submit = (id, extra = {}, input = {}) => {
    const result = backend.submit(work(id, extra), input)
    result.catch(() => {})
    return result
  }
  return { backend, client, calls, sessions, registrations, steering, cancellations, finish, submit }
}

test('submissions serialize through one coordinator Session and refresh its MCP context', async t => {
  const h = harness()
  t.after(() => h.backend.close())
  const events = []
  const a = h.submit('a', {}, { onEvent: event => events.push(event) })
  const b = h.submit('b')
  await tick()
  assert.equal(h.calls.length, 1)
  assert.equal(h.sessions.size, 1)
  assert.match(JSON.stringify(h.calls[0].prompt), /work a/)
  const oldContext = h.registrations[0].context
  h.finish(0, 'first result')
  const first = await a
  await tick()
  assert.equal(h.calls.length, 2)
  assert.equal(h.calls[1].sessionId, h.calls[0].sessionId)
  assert.equal(h.sessions.size, 1)
  assert.equal(h.registrations.length, 1)
  assert.equal(h.sessions.get(h.calls[1].sessionId).coordinationRunId, 'b')
  assert.match(JSON.stringify(h.calls[1].prompt), /work b/)
  assert.throws(() => oldContext.startSession({ prompt: 'stale request' }), /已失效/)
  h.calls[0].input.onUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'late' } })
  assert.equal(events.length, 0)
  h.finish(1, 'second result')
  const second = await b
  assert.equal(first.content, 'first result')
  assert.equal(second.content, 'second result')
  assert.deepEqual(second.continuation, first.continuation)
})

for (const stage of ['create', 'configure']) {
  test(`late project ${stage} completion cannot start work after its coordinator turn failed`, async t => {
    const h = harness()
    t.after(() => h.backend.close())
    const setup = Promise.withResolvers()
    const create = h.client.newSession.bind(h.client)
    const configure = h.backend.configureSession.bind(h.backend)
    h.client.newSession = async input => {
      if (stage === 'create' && input.role === 'project') await setup.promise
      return create(input)
    }
    h.backend.configureSession = async (session, role) => {
      if (stage === 'configure' && role === 'project') await setup.promise
      return configure(session, role)
    }
    const a = h.submit('a')
    await tick()
    const start = h.registrations[0].context.startSession({ prompt: 'delayed project setup' })
    const rejected = assert.rejects(start, /已失效/u)
    await tick()
    h.calls[0].gate.reject(new Error('provider disconnected'))
    await assert.rejects(a, /provider disconnected/u)
    assert.equal(h.backend.coordinationRuns.size, 0)
    setup.resolve()
    await rejected
    await tick()
    assert.equal(h.calls.length, 1, 'an ended task must not start an untracked child prompt')
    assert.equal(h.backend.coordinationRuns.size, 0)
  })
}

for (const stage of ['queue', 'list', 'resume', 'configure']) {
  test(`late project continuation after ${stage} rejects its closed coordinator context`, async t => {
    const h = harness()
    t.after(() => h.backend.close())
    const setup = Promise.withResolvers()
    let resumes = 0
    const resume = h.client.resumeSession.bind(h.client)
    const configure = h.backend.configureSession.bind(h.backend)
    h.client.resumeSession = async (...args) => {
      resumes += 1
      if (stage === 'resume') await setup.promise
      return resume(...args)
    }
    h.client.listSessions = async () => {
      await setup.promise
      return [{ sessionId: 'existing-project', cwd: '/project' }]
    }
    h.backend.configureSession = async (session, role) => {
      if (stage === 'configure' && role === 'project') await setup.promise
      return configure(session, role)
    }
    if (stage !== 'list') {
      h.backend.rememberProjectSession({ sessionId: 'existing-project', cwd: '/project' })
    }
    const a = h.submit('a')
    await tick()
    const queued = stage === 'queue'
      ? h.backend.serialize('target-setup:existing-project', () => setup.promise)
      : Promise.resolve()
    const continuation = h.registrations[0].context.sendSession({
      session_id: 'existing-project', prompt: 'delayed continuation',
    })
    const rejected = assert.rejects(continuation, /已失效/u)
    await tick()
    h.finish(0, 'current turn ended')
    await a
    setup.resolve()
    await Promise.all([queued, rejected])
    await tick()
    assert.equal(h.calls.length, 1, 'a closed turn must not start another project prompt')
    if (stage === 'queue' || stage === 'list') assert.equal(resumes, 0)
    assert.equal(h.backend.coordinationRuns.size, 0)
  })
}

test('closing the coordinator turn permits child progress and a new coordinator update turn', async t => {
  const h = harness()
  t.after(() => h.backend.close())
  const events = []
  const a = h.submit('a', {}, { onEvent: event => events.push(event) })
  await tick()
  const child = await h.registrations[0].context.startSession({ prompt: 'independent project' })
  await tick()
  h.finish(0, 'dispatched')
  await tick()
  assert.equal(h.backend.coordinationRuns.get('a').turnClosed, true)
  h.calls[1].input.onUpdate({
    sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'child remains active' },
  })
  assert.match(JSON.stringify(events), /child remains active/u)
  const update = h.backend.update('a', { instruction: 'continue with the new requirement' }, { ownerId: 'owner' })
  await tick()
  assert.equal(h.calls[2].sessionId, h.calls[0].sessionId)
  assert.deepEqual(h.steering, [])
  await h.registrations[0].context.sendSession({
    session_id: child.session_id, prompt: 'continue with the new requirement',
  })
  h.finish(2, 'requirements sent')
  assert.deepEqual(await update.completion, { status: 'delivered' })
  assert.deepEqual(h.steering.map(item => item.sessionId), [child.session_id])
  h.finish(1, 'updated child result')
  await tick()
  h.finish(3, 'final answer')
  assert.equal((await a).content, 'final answer')
})

test('cancelling a queued submission does not cancel or annotate the active coordinator turn', async t => {
  const h = harness()
  t.after(() => h.backend.close())
  const a = h.submit('a')
  const b = h.submit('b')
  const c = h.submit('c')
  const rejected = assert.rejects(b, /取消/)
  await tick()
  await assert.rejects(h.backend.cancel('b', { ownerId: 'someone-else' }), /可取消/)
  await h.backend.cancel('b', { ownerId: 'owner' })
  await rejected
  assert.equal(h.calls.length, 1)
  assert.deepEqual(h.cancellations, [])
  assert.equal(h.backend.registry.reconciliationsFor('acp:owner:backend').length, 0)
  h.finish(0)
  await a
  await tick()
  assert.equal(h.calls.length, 2)
  assert.match(JSON.stringify(h.calls[1].prompt), /work c/)
  h.finish(1)
  await c
})

test('resuming finished work waits for the same busy coordinator and never steers its current request', async t => {
  const h = harness()
  t.after(() => h.backend.close())
  const a = h.submit('a')
  await tick()
  h.finish(0)
  const original = await a
  const b = h.submit('b')
  await tick()
  const resumed = h.submit('a', { resumeContext: original.continuation })
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

test('a coordinator continuation restores its stable Session after adapter restart', async t => {
  const h = harness()
  t.after(() => h.backend.close())
  const a = h.submit('a')
  await tick()
  h.finish(0)
  const result = await a
  const next = harness()
  t.after(() => next.backend.close())
  next.backend.registry.loaded = true
  next.backend.registry.coordinators = Object.fromEntries(h.backend.registry.coordinatorEntries())
  await h.backend.close()
  const resumed = next.submit('a', { resumeContext: result.continuation })
  await tick()
  assert.equal(next.calls[0].sessionId, result.continuation.token)
  assert.equal(next.backend.coordinatorSessions.has('acp:owner:backend'), true)
  assert.equal(next.sessions.size, 1)
  next.finish(0)
  await resumed
})

for (const mode of ['extension', 'restart']) {
  test(`active ${mode} steering retains the coordinator until the original work settles`, async t => {
    const h = harness()
    h.client.steeringMode = () => mode
    t.after(() => h.backend.close())
    const a = h.submit('a')
    const b = h.submit('b')
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
    assert.equal(h.calls.length, currentPrompt + 1)
    assert.equal(h.sessions.size, 1)
    assert.equal(h.registrations.length, 1)
    assert.equal(h.sessions.get(sessionId).coordinationRunId, 'a')
    h.finish(currentPrompt, 'updated a result')
    assert.equal((await a).content, 'updated a result')
    await tick()
    const queuedPrompt = currentPrompt + 1
    assert.equal(h.calls[queuedPrompt].sessionId, sessionId)
    assert.match(JSON.stringify(h.calls[queuedPrompt].prompt), /work b/)
    assert.doesNotMatch(JSON.stringify(h.calls[queuedPrompt].prompt), /only a changes/)
    h.finish(queuedPrompt)
    await b
  })
}

test('a failed coordinator prompt releases the queue for the next request', async t => {
  const h = harness()
  t.after(() => h.backend.close())
  const a = h.submit('a')
  const failure = assert.rejects(a, /backend failed/)
  const b = h.submit('b')
  await tick()
  h.calls[0].gate.reject(new Error('backend failed'))
  await failure
  await tick()
  assert.equal(h.calls.length, 2)
  assert.equal(h.calls[1].sessionId, h.calls[0].sessionId)
  assert.match(JSON.stringify(h.calls[1].prompt), /work b/)
  h.finish(1)
  await b
})

test('delegated execution releases the coordinator and its final summary joins the same FIFO queue', async t => {
  const h = harness()
  t.after(() => h.backend.close())
  const events = []
  const a = h.submit('a', {}, { onEvent: event => events.push(event) })
  await tick()
  const child = await h.registrations[0].context.startSession({ prompt: 'project a' })
  await tick()
  assert.equal(h.calls[1].sessionId, child.session_id)
  const b = h.submit('b')
  h.finish(0, 'delegated')
  await tick()
  assert.equal(h.calls[2].sessionId, h.calls[0].sessionId)
  assert.match(JSON.stringify(h.calls[2].prompt), /work b/)
  const delegated = events.find(event => event.type === 'backend.delegated')
  assert.equal(delegated.delegation.sessionId, child.session_id)
  assert.equal(delegated.delegation.coordinatorSessionId, h.calls[0].sessionId)
  await assert.rejects(h.registrations[0].context.sendSession({
    session_id: child.session_id, prompt: 'must not replace a running project',
  }), { code: 'session_busy' })
  h.finish(1, 'project result a')
  await tick()
  assert.equal(h.calls.length, 3, 'summary must wait for active coordinator work')
  const c = h.submit('c')
  await tick()
  h.finish(2)
  await b
  await tick()
  assert.equal(h.calls[3].sessionId, h.calls[0].sessionId)
  assert.match(JSON.stringify(h.calls[3].prompt), /project result a/)
  h.finish(3, 'final a')
  assert.equal((await a).content, 'final a')
  await tick()
  assert.equal(h.calls[4].sessionId, h.calls[0].sessionId)
  assert.match(JSON.stringify(h.calls[4].prompt), /work c/)
  h.finish(4)
  await c
  assert.equal(h.registrations.length, 1)
})

test('multiple child Sessions from one turn are all tracked and summarized once after every child settles', async t => {
  const h = harness()
  t.after(() => h.backend.close())
  const events = []
  const a = h.submit('a', {}, { onEvent: event => events.push(event) })
  await tick()
  const first = await h.registrations[0].context.startSession({ prompt: 'first independent work' })
  const second = await h.registrations[0].context.startSession({ prompt: 'second independent work' })
  await tick()
  assert.notEqual(first.session_id, second.session_id)
  assert.deepEqual(h.calls.slice(1).map(call => call.sessionId), [first.session_id, second.session_id])
  h.finish(0, 'both delegated')
  await tick()
  const registrations = events.filter(event => event.type === 'backend.delegated' && !event.yielded)
  assert.equal(registrations.length, 2)
  const delegated = events.find(event => event.type === 'backend.delegated' && event.yielded).delegation
  assert.deepEqual(delegated.targets.map(target => target.sessionId), [first.session_id, second.session_id])
  const b = h.submit('b')
  await tick()
  assert.equal(h.calls[3].sessionId, h.calls[0].sessionId)
  h.finish(1, 'first child result')
  await tick()
  assert.equal(events.some(event => event.type === 'backend.delegation.completed'), false)
  h.finish(2, 'second child result')
  await tick()
  assert.equal(h.calls.length, 4, 'both results wait for the active coordinator request')
  assert.equal(events.filter(event => event.type === 'backend.delegation.completed').length, 1)
  h.finish(3)
  await b
  await tick()
  assert.equal(h.calls.length, 5)
  assert.equal(h.calls[4].sessionId, h.calls[0].sessionId)
  assert.match(JSON.stringify(h.calls[4].prompt), /first child result/)
  assert.match(JSON.stringify(h.calls[4].prompt), /second child result/)
  const sessionCount = h.sessions.size
  await assert.rejects(async () => h.registrations[0].context.startSession({ prompt: 'must not delegate again' }))
  await assert.rejects(async () => h.registrations[0].context.sendSession({
    session_id: first.session_id, prompt: 'must not restart completed child',
  }))
  assert.equal(h.sessions.size, sessionCount)
  assert.equal(h.calls.length, 5)
  h.finish(4, 'combined result')
  assert.equal((await a).content, 'combined result')
  assert.equal(h.calls.length, 5)
})

test('cancelling delegated work does not cancel another task running in the shared coordinator', async t => {
  const h = harness()
  t.after(() => h.backend.close())
  const a = h.submit('a')
  const rejected = assert.rejects(a)
  await tick()
  const child = await h.registrations[0].context.startSession({ prompt: 'project a' })
  await tick()
  h.finish(0, 'delegated')
  await tick()
  const b = h.submit('b')
  await tick()
  const coordinatorSessionId = h.calls[0].sessionId
  assert.equal(h.calls[2].sessionId, coordinatorSessionId)
  assert.match(JSON.stringify(h.calls[2].prompt), /work b/)
  await h.backend.cancel('a', { ownerId: 'owner' })
  await rejected
  assert.ok(h.cancellations.includes(child.session_id))
  assert.equal(h.cancellations.includes(coordinatorSessionId), false)
  assert.equal(h.calls[2].input.signal.aborted, false)
  h.finish(2, 'b remains intact')
  assert.equal((await b).content, 'b remains intact')
  assert.equal(h.calls.length, 3, 'cancelled work must not submit a final summary')
})

test('native delegated recovery waits without occupying the coordinator and summarizes in the restored Session', async t => {
  const child = Promise.withResolvers()
  const h = harness({ nativeDelegationAdapter: { wait: () => child.promise } })
  t.after(() => h.backend.close())
  h.backend.registry.loaded = true
  h.backend.registry.set('acp:owner:backend', {
    sessionId: 'saved-coordinator', cwd: '/project', contractVersion: 8,
  })
  const recovered = h.backend.recoverDelegatedWork({ ...work('recovered'), delegation: {
    id: 'native-run', sessionId: 'child-session', coordinatorSessionId: 'saved-coordinator',
  } })
  recovered.catch(() => {})
  await tick()
  const b = h.submit('b')
  await tick()
  assert.equal(h.calls.length, 1)
  assert.equal(h.calls[0].sessionId, 'saved-coordinator')
  child.resolve({ content: 'recovered child result' })
  await tick()
  assert.equal(h.calls.length, 1, 'recovered summary must queue behind active work')
  h.finish(0)
  await b
  await tick()
  assert.equal(h.calls[1].sessionId, 'saved-coordinator')
  assert.match(JSON.stringify(h.calls[1].prompt), /recovered child result/)
  h.finish(1)
  await recovered
  assert.equal(h.sessions.size, 1)
})

test('closing rejects queued coordinator work and never revives it', async () => {
  const h = harness()
  const a = h.submit('a')
  const b = h.submit('b')
  const failures = [assert.rejects(a), assert.rejects(b)]
  await tick()
  assert.equal(h.calls.length, 1)
  await h.backend.close()
  await Promise.all(failures)
  await tick()
  assert.equal(h.calls.length, 1)
  assert.equal(h.backend.coordinatorQueue.owners.size, 0)
  await assert.rejects(h.submit('c'), /closed/)
})
