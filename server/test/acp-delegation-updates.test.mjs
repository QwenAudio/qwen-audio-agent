import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AcpBackendAdapter } from '../src/backend/adapters/acp/backend-adapter.mjs'
import { ConversationSync } from '../src/conversation/conversation-sync.mjs'

const tick = () => new Promise(resolve => setImmediate(resolve))
const owner = { ownerId: 'owner' }

function harness(t, { nativeDelegationAdapter, manualChildCancellation = false, sessionStatePath = null } = {}) {
  const calls = []
  const sessions = new Map()
  const active = new Map()
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
      assert.equal(active.has(sessionId), false, `concurrent prompt in ${sessionId}`)
      const gate = Promise.withResolvers()
      const call = { sessionId, prompt, input, gate }
      calls.push(call)
      active.set(sessionId, call)
      const abort = () => {
        cancellations.push(sessionId)
        if (!manualChildCancellation || sessions.get(sessionId).input.role !== 'project') {
          gate.resolve({ content: '', response: { stopReason: 'cancelled' } })
        }
      }
      input.signal?.addEventListener('abort', abort, { once: true })
      if (input.signal?.aborted) abort()
      return gate.promise.finally(() => {
        input.signal?.removeEventListener('abort', abort)
        active.delete(sessionId)
      })
    },
    steeringMode() { return 'extension' },
    async steerSession(sessionId, prompt) {
      steering.push({ sessionId, prompt })
      return { outcome: 'injected' }
    },
    async cancelSession(sessionId) { cancellations.push(sessionId) },
    async close() {
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
    protocol: 'acp', directory: '/project', client, sessionStatePath,
    builtinMcp: [], sessionToolServer, nativeDelegationAdapter, cancelTimeoutMs: 100,
    profile: { label: 'Test ACP', externalMcp: true, capabilities: {},
      acpConnection: { kind: 'process' } },
  })
  t.after(async () => {
    await client.close()
    await backend.close()
    await tick()
  })
  const finish = (index, content = 'done', contentBlocks = []) => calls[index].gate.resolve({
    content, contentBlocks, response: { stopReason: 'end_turn' },
  })
  const submit = (id, onEvent = () => {}, input = {}) => {
    const result = backend.submit({ id, ownerId: owner.ownerId, objective: `work ${id}`, ...input }, { onEvent })
    result.catch(() => {})
    return result
  }
  return { backend, client, calls, sessions, active, steering, cancellations, finish, submit,
    context: () => registrations[0].context }
}

async function delegatePair(h, events = []) {
  const result = h.submit('a', event => events.push(event))
  await tick()
  const first = await h.context().startSession({ prompt: 'analyze sales', title: 'Sales analysis' })
  const second = await h.context().startSession({ prompt: 'review docs', title: 'Documentation review' })
  await tick()
  h.finish(0, 'delegated both')
  await tick()
  return { result, first, second }
}

async function delegateOne(h) {
  const result = h.submit('a')
  await tick()
  const first = await h.context().startSession({ prompt: 'analyze sales', title: 'Sales analysis' })
  await tick()
  h.finish(0, 'delegated the sales project')
  await tick()
  return { result, first }
}

async function completeOne(h) {
  const { result, first } = await delegateOne(h)
  h.finish(1, 'original project result')
  await tick()
  h.finish(2, 'original final result')
  return { first, outcome: await result }
}

function continueWork(h, outcome, instruction = 'Revise the original project') {
  return h.submit('a', undefined, { resumeContext: outcome.continuation, instruction })
}

test('completed delegated work resumes through its original coordinator and project', async t => {
  const h = harness(t)
  const { first, outcome } = await completeOne(h)
  assert.deepEqual(outcome.continuation.projects, [{
    sessionId: first.session_id, title: 'Sales analysis', directory: '/project',
  }])
  const result = continueWork(h, outcome)
  await tick()
  assert.equal(h.calls[3].sessionId, outcome.continuation.token)
  assert.match(JSON.stringify(h.calls[3].prompt), /Revise the original project/u)
  assert.match(JSON.stringify(h.calls[3].prompt), /Sales analysis/u)
  await assert.rejects(h.context().startSession({ prompt: 'new unrelated work' }), { code: 'invalid_session_route' })
  await assert.rejects(h.context().sendSession({ session_id: 'unrelated', prompt: 'wrong' }), { code: 'invalid_session_route' })
  await h.context().sendSession({ session_id: first.session_id, prompt: 'Revise the original project' })
  await tick()
  assert.equal(h.sessions.size, 2, 'do not create a replacement Session')
  assert.equal(h.calls[4].sessionId, first.session_id)
  assert.deepEqual(h.steering, [], 'completed project receives a new prompt, not steer')
  h.finish(3, 'requirements delivered')
  h.finish(4, 'revised project result')
  await tick()
  assert.equal(h.calls[5].sessionId, outcome.continuation.token)
  assert.match(JSON.stringify(h.calls[5].prompt), /revised project result/u)
  assert.doesNotMatch(JSON.stringify(h.calls[5].prompt), /original project result/u)
  h.finish(5, 'revised final result')
  assert.equal((await result).content, 'revised final result')
})

test('completed multi-project work updates only the selected project and retains every target for later updates', async t => {
  const h = harness(t)
  const { result, first, second } = await delegatePair(h)
  h.finish(1, 'old sales')
  h.finish(2, 'old documentation')
  await tick()
  h.finish(3, 'original final result')
  let outcome = await result
  for (const target of [second, first]) {
    const start = h.calls.length
    const next = continueWork(h, outcome, `Revise ${target.title}`)
    await tick()
    assert.match(JSON.stringify(h.calls[start].prompt), /Sales analysis/u)
    assert.match(JSON.stringify(h.calls[start].prompt), /Documentation review|Revise Documentation/u)
    await h.context().sendSession({ session_id: target.session_id, prompt: `Revise ${target.title}` })
    await tick()
    assert.equal(h.calls[start + 1].sessionId, target.session_id)
    h.finish(start, 'delivered')
    h.finish(start + 1, 'updated selected project')
    await tick()
    assert.equal(h.calls.length, start + 3, 'only selected project executes')
    assert.doesNotMatch(JSON.stringify(h.calls[start + 2].prompt), /old sales|old documentation/u)
    h.finish(start + 2, 'revised result')
    outcome = await next
    assert.deepEqual(outcome.continuation.projects.map(item => item.sessionId).sort(),
      [first.session_id, second.session_id].sort())
  }
  assert.equal(h.sessions.size, 3)
})

test('completed delegation restores coordinator and project after adapter restart from durable context', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'acp-continuation-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const sessionStatePath = join(directory, 'sessions.json')
  const h = harness(t, { sessionStatePath })
  const { first, outcome } = await completeOne(h)
  const persistedOutcome = JSON.parse(JSON.stringify(outcome))
  await h.backend.close()
  const next = harness(t, { sessionStatePath })
  const result = continueWork(next, persistedOutcome)
  await tick()
  assert.equal(next.calls[0].sessionId, outcome.continuation.token)
  await next.context().sendSession({ session_id: first.session_id, prompt: 'Revise after restart' })
  await tick()
  assert.equal(next.calls[1].sessionId, first.session_id)
  next.finish(0, 'delivered')
  next.finish(1, 'updated after restart')
  await tick()
  next.finish(2, 'final after restart')
  assert.equal((await result).content, 'final after restart')
  assert.equal(next.sessions.size, 2)
})

test('completed continuation queues behind unrelated coordinator work without steering it', async t => {
  const h = harness(t)
  const { first, outcome } = await completeOne(h)
  const unrelated = h.submit('b')
  await tick()
  const result = continueWork(h, outcome)
  await tick()
  assert.equal(h.calls.length, 4)
  assert.deepEqual(h.steering, [])
  h.finish(3, 'unrelated result')
  await unrelated
  await tick()
  await h.context().sendSession({ session_id: first.session_id, prompt: 'modify original' })
  await tick()
  h.finish(4, 'delivered')
  h.finish(5, 'modified')
  await tick()
  h.finish(6, 'new result')
  assert.equal((await result).content, 'new result')
})

test('acknowledging a completed continuation without session_send is not a successful update', async t => {
  const h = harness(t)
  const { outcome } = await completeOne(h)
  const result = continueWork(h, outcome)
  await tick()
  h.finish(3, 'I will update it')
  await assert.rejects(result, { code: 'update_not_delivered' })
  assert.equal(h.calls.length, 4)
  assert.equal(h.backend.coordinationRuns.size, 0)
})

test('unavailable project cannot silently turn into newly-created work', async t => {
  const h = harness(t)
  const { first, outcome } = await completeOne(h)
  const resume = h.client.resumeSession.bind(h.client)
  h.client.resumeSession = (id, options) => {
    if (id === first.session_id) throw new Error('project no longer available')
    return resume(id, options)
  }
  const result = continueWork(h, outcome)
  await tick()
  await assert.rejects(h.context().sendSession({ session_id: first.session_id, prompt: 'modify' }), /project no longer available/u)
  h.finish(3, 'project no longer available')
  await assert.rejects(result, { code: 'update_not_delivered' })
  assert.equal(h.sessions.size, 2)
  assert.equal(h.calls.length, 4)
})

test('resumed project remains adjustable through the coordinator while running', async t => {
  const h = harness(t)
  const { first, outcome } = await completeOne(h)
  const result = continueWork(h, outcome)
  await tick()
  await h.context().sendSession({ session_id: first.session_id, prompt: 'modify original' })
  await tick()
  h.finish(3, 'delivered')
  await tick()
  const update = h.backend.update('a', { instruction: 'also use regional totals' }, owner)
  await tick()
  assert.equal(h.calls[5].sessionId, outcome.continuation.token)
  await h.context().sendSession({ session_id: first.session_id, prompt: 'also use regional totals' })
  h.finish(5, 'updated')
  await update.completion
  assert.deepEqual(h.steering.map(item => item.sessionId), [first.session_id])
  h.finish(4, 'modified with totals')
  await tick()
  h.finish(6, 'final')
  assert.equal((await result).content, 'final')
})

test('legacy or incomplete routing is rejected before any backend work starts', async t => {
  const h = harness(t)
  for (const resumeContext of [
    { adapter: 'acp', token: 'original' },
    { adapter: 'acp', version: 1, token: 'original', projects: [{}] },
    { adapter: 'other', version: 1, token: 'original', projects: [] },
  ]) {
    await assert.rejects(h.submit('a', undefined, { resumeContext }), { code: 'context_unavailable' })
  }
  assert.equal(h.calls.length, 0)
  assert.equal(h.sessions.size, 0)
  assert.equal(h.backend.workUpdates.size, 0)
})

test('failure before initial project routing also stops queued update turns', async t => {
  const h = harness(t)
  const { outcome } = await completeOne(h)
  const result = continueWork(h, outcome)
  await tick()
  const update = h.backend.update('a', { instruction: 'also adjust colors' }, owner)
  const failedUpdate = assert.rejects(update.completion)
  await tick()
  assert.deepEqual(h.steering, [], 'do not mark a coordinator-only injection as project delivery')
  h.finish(3, 'only a verbal acknowledgement')
  await assert.rejects(result, { code: 'update_not_delivered' })
  await failedUpdate
  await tick()
  assert.equal(h.active.size, 0, 'no orphan prompt survives the failed Work')
  assert.equal(h.backend.coordinationRuns.size, 0)
  assert.equal(h.backend.workUpdates.size, 0)
})

for (const delivered of [true, false]) {
  test(`queued project continuation acknowledges appended requirements only after routing (${delivered})`, async t => {
    const h = harness(t)
    const { first, outcome } = await completeOne(h)
    const unrelated = h.submit('b')
    await tick()
    const result = continueWork(h, outcome)
    await tick()
    const update = h.backend.update('a', { instruction: 'also adjust colors' }, owner)
    let state = 'pending'
    update.completion.then(() => { state = 'delivered' }, () => { state = 'failed' })
    h.finish(3, 'unrelated result')
    await unrelated
    await tick()
    assert.match(JSON.stringify(h.calls[4].prompt), /also adjust colors/u)
    h.calls[4].input.onUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'checking' } })
    await tick()
    assert.equal(state, 'pending', 'coordinator acceptance is not yet project delivery')
    if (delivered) {
      await h.context().sendSession({ session_id: first.session_id, prompt: 'modify original and adjust colors' })
      await tick()
      h.finish(4, 'requirements sent')
      await update.completion
      assert.equal(state, 'delivered')
      h.finish(5, 'modified project')
      await tick()
      h.finish(6, 'final result')
      await result
    } else {
      h.finish(4, 'only words')
      await assert.rejects(result, { code: 'update_not_delivered' })
      await assert.rejects(update.completion, { code: 'update_not_delivered' })
      assert.equal(state, 'failed')
      assert.equal(h.calls.length, 5)
    }
    assert.equal(h.active.size, 0)
  })
}

for (const failure of ['load', 'contract']) {
  test(`completed delegation cannot replace its coordinator on ${failure} failure`, async t => {
    const h = harness(t)
    const { outcome } = await completeOne(h)
    const next = harness(t)
    next.backend.registry.loaded = true
    next.backend.registry.coordinators = Object.fromEntries(h.backend.registry.coordinatorEntries())
    if (failure === 'contract') {
      for (const session of Object.values(next.backend.registry.coordinators)) session.contractVersion = -1
    } else {
      next.client.resumeSession = async () => { throw new Error('not found') }
    }
    await h.backend.close()
    await assert.rejects(continueWork(next, outcome), { code: 'context_unavailable' })
    assert.equal(next.sessions.size, 0)
    assert.equal(next.calls.length, 0)
  })
}

test('native delegated completion explicitly revokes unsupported continuation context', async t => {
  const native = heldNativeDelegations()
  const h = harness(t, { nativeDelegationAdapter: native.adapter })
  const result = h.submit('a')
  await tick()
  h.backend.createNativeDelegation(h.backend.coordinationRuns.get('a'), {
    delegationId: 'native-run', sessionId: 'native-project', directory: '/project', title: 'Native work',
  })
  h.finish(0, 'native work delegated')
  await tick()
  native.waits.get('native-run').resolve({ content: 'native result' })
  await tick()
  h.finish(1, 'final native result')
  assert.equal((await result).continuation, null)
})

test('completed continuation cannot steal a project now occupied by another work', async t => {
  const h = harness(t)
  const { first, outcome } = await completeOne(h)
  const other = h.submit('b')
  await tick()
  await h.context().sendSession({ session_id: first.session_id, prompt: 'other work in this project' })
  await tick()
  h.finish(3, 'other work delegated')
  await tick()
  const result = continueWork(h, outcome)
  await tick()
  await assert.rejects(h.context().sendSession({ session_id: first.session_id, prompt: 'do not steal' }), { code: 'session_busy' })
  h.finish(5, 'target is busy')
  await assert.rejects(result, { code: 'update_not_delivered' })
  assert.equal(h.active.has(first.session_id), true)
  assert.deepEqual(h.steering, [])
  assert.deepEqual(h.cancellations, [])
  h.finish(4, 'other project result')
  await tick()
  h.finish(6, 'other final result')
  assert.equal((await other).content, 'other final result')
})

test('resumed project without native steer cancels its turn and continues in the same project', async t => {
  const h = harness(t)
  h.client.steeringMode = () => 'restart'
  const { first, outcome } = await completeOne(h)
  const result = continueWork(h, outcome)
  await tick()
  await h.context().sendSession({ session_id: first.session_id, prompt: 'modify project' })
  await tick()
  h.finish(3, 'sent')
  await tick()
  const update = h.backend.update('a', { instruction: 'use regional totals instead' }, owner)
  await tick()
  const sent = h.context().sendSession({ session_id: first.session_id, prompt: 'use regional totals instead' })
  await tick()
  assert.deepEqual(h.cancellations, [first.session_id])
  assert.equal(h.calls.length, 6, 'wait for stop confirmation before another project prompt')
  h.calls[4].gate.resolve({ content: 'superseded', response: { stopReason: 'cancelled' } })
  await tick()
  assert.equal(h.calls[6].sessionId, first.session_id)
  assert.match(JSON.stringify(h.calls[6].prompt), /regional totals/u)
  h.calls[6].input.onUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'accepted' } })
  await sent
  h.finish(5, 'updated')
  await update.completion
  h.finish(6, 'new project result')
  await tick()
  assert.doesNotMatch(JSON.stringify(h.calls[7].prompt), /superseded/u)
  h.finish(7, 'final')
  assert.equal((await result).content, 'final')
  assert.equal(h.sessions.size, 2)
})

function heldNativeDelegations() {
  const waits = new Map()
  const cancellations = []
  const adapter = {
    wait(input) {
      const gate = Promise.withResolvers()
      waits.set(input.runId, { ...input, ...gate })
      const aborted = () => gate.reject(input.signal.reason)
      input.signal?.addEventListener('abort', aborted, { once: true })
      return gate.promise.finally(() => input.signal?.removeEventListener('abort', aborted))
    },
    async cancel(input) { cancellations.push(input) },
  }
  return { adapter, waits, cancellations }
}

function recoveredWork(coordinatorSessionId, delegation = {}) {
  return {
    id: 'recovered', ownerId: owner.ownerId, objective: 'Finish both persisted projects',
    delegation: { coordinatorSessionId, title: 'Persisted projects', targets: [
      { id: 'native-one', sessionId: 'project-one', title: 'First project' },
      { id: 'native-two', sessionId: 'project-two', title: 'Second project' },
    ], ...delegation },
  }
}

test('a single-child update reaches the coordinator with conversation and attachments before steering', async t => {
  const h = harness(t)
  const { result, first } = await delegateOne(h)
  const sync = new ConversationSync()
  sync.record({ ...owner, sessionId: 'voice', id: 'context', role: 'user', source: 'voice-user',
    content: 'Focus on regional sales', createdAt: 1_000 })
  const update = h.backend.update('a', {
    instruction: 'Use this chart',
    conversation: sync.coordinatorSnapshot({ ...owner, sessionId: 'voice' }),
    inputParts: [{ type: 'file', filename: 'chart.png', mime: 'image/png', url: 'data:image/png;base64,AQID' }],
  }, owner)
  let delivered = false
  update.completion.then(() => { delivered = true }).catch(() => {})
  await tick()
  assert.equal(h.calls.length, 3)
  assert.equal(h.calls[2].sessionId, h.calls[0].sessionId)
  assert.match(JSON.stringify(h.calls[2].prompt), /Focus on regional sales/u)
  assert.match(JSON.stringify(h.calls[2].prompt), /Sales analysis/u)
  assert.match(JSON.stringify(h.calls[2].prompt), /Use this chart/u)
  assert.ok(h.calls[2].prompt.some(block => block.type === 'image'))
  assert.deepEqual(h.steering, [])
  assert.equal(delivered, false)
  await assert.rejects(h.context().startSession({ prompt: 'duplicate work' }), { code: 'invalid_session_route' })
  await assert.rejects(h.context().sendSession({ session_id: 'unrelated', prompt: 'wrong target' }), { code: 'invalid_session_route' })
  const receipt = await h.context().sendSession({ session_id: first.session_id, prompt: 'Use the attached chart for regional sales' })
  assert.equal(receipt.status, 'updated')
  assert.deepEqual(h.steering.map(item => item.sessionId), [first.session_id])
  assert.ok(h.steering[0].prompt.some(block => block.type === 'image' && block.data === 'AQID'))
  h.finish(2, 'forwarded the requirements')
  assert.deepEqual(await update.completion, { status: 'delivered' })
  h.finish(1, 'regional sales updated')
  await tick()
  assert.equal(h.calls[3].sessionId, h.calls[0].sessionId)
  assert.match(JSON.stringify(h.calls[3].prompt), /regional sales updated/u)
  h.finish(3, 'final revised result')
  assert.equal((await result).content, 'final revised result')
})

test('an update received while the initial coordinator turn is still active waits for routing', async t => {
  const h = harness(t)
  const result = h.submit('a')
  await tick()
  const first = await h.context().startSession({ prompt: 'project work' })
  await tick()
  const update = h.backend.update('a', { instruction: 'adjust the project' }, owner)
  update.completion.catch(() => {})
  await tick()
  assert.equal(h.calls.length, 2, 'do not prompt the occupied coordinator concurrently')
  assert.deepEqual(h.steering, [], 'do not bypass the coordinator or steer its current turn')
  h.finish(0, 'project dispatched')
  await tick()
  assert.equal(h.calls[2].sessionId, h.calls[0].sessionId)
  await h.context().sendSession({ session_id: first.session_id, prompt: 'adjust the project' })
  h.finish(2, 'requirements sent')
  await update.completion
  h.finish(1, 'adjusted project result')
  await tick()
  h.finish(3, 'final revised result')
  assert.equal((await result).content, 'final revised result')
})

test('queued single-child routing continues a finished child and does not announce its stale result', async t => {
  const h = harness(t)
  const { result, first } = await delegateOne(h)
  const unrelated = h.submit('b')
  await tick()
  const update = h.backend.update('a', { instruction: 'Add regional totals' }, owner)
  update.completion.catch(() => {})
  h.finish(1, 'old sales result')
  await tick()
  assert.equal(h.calls.length, 3, 'routing and finalization must wait for the occupied coordinator')
  assert.deepEqual(h.steering, [], 'never steer the unrelated coordinator turn')
  assert.deepEqual(h.cancellations, [])
  h.finish(2, 'unrelated work done')
  await unrelated
  await tick()
  assert.equal(h.calls[3].sessionId, h.calls[0].sessionId)
  const resumed = await h.context().sendSession({ session_id: first.session_id, prompt: 'Add regional totals' })
  assert.equal(resumed.status, 'started')
  await tick()
  assert.equal(h.calls[4].sessionId, first.session_id)
  assert.equal(h.sessions.size, 2, 'continue the original project, do not create a replacement')
  h.finish(3, 'requirements sent')
  await update.completion
  await tick()
  assert.equal(h.calls.length, 5, 'the old result must not complete the revised work')
  h.finish(4, 'new sales result with regional totals')
  await tick()
  assert.match(JSON.stringify(h.calls[5].prompt), /new sales result with regional totals/u)
  assert.doesNotMatch(JSON.stringify(h.calls[5].prompt), /old sales result/u)
  h.finish(5, 'final revised result')
  assert.equal((await result).content, 'final revised result')
})

test('a coordinator acknowledgement without session_send is not a delivered update', async t => {
  const h = harness(t)
  const { result } = await delegateOne(h)
  const update = h.backend.update('a', { instruction: 'Add regional totals' }, owner)
  const rejected = assert.rejects(update.completion, { code: 'update_not_delivered' })
  await tick()
  h.finish(2, 'I have updated the sales task')
  await rejected
  assert.deepEqual(h.steering, [])
  h.finish(1, 'original sales result')
  await tick()
  h.finish(3, 'original result; the requested change was not delivered')
  await result
})

test('successive child updates serialize through the coordinator and finish before synthesis', async t => {
  const h = harness(t)
  const { result, first } = await delegateOne(h)
  const firstUpdate = h.backend.update('a', { instruction: 'Add regional totals' }, owner)
  const secondUpdate = h.backend.update('a', { instruction: 'Use the latest exchange rates' }, owner)
  firstUpdate.completion.catch(() => {})
  secondUpdate.completion.catch(() => {})
  await tick()
  assert.equal(h.calls.length, 3)
  assert.match(JSON.stringify(h.calls[2].prompt), /Add regional totals/u)
  assert.doesNotMatch(JSON.stringify(h.calls[2].prompt), /latest exchange rates/u)
  await h.context().sendSession({ session_id: first.session_id, prompt: 'Add regional totals' })
  h.finish(2, 'first requirements sent')
  await firstUpdate.completion
  await tick()
  assert.equal(h.calls.length, 4)
  assert.match(JSON.stringify(h.calls[3].prompt), /latest exchange rates/u)
  await h.context().sendSession({ session_id: first.session_id, prompt: 'Use the latest exchange rates' })
  h.finish(1, 'sales with both changes')
  await tick()
  assert.equal(h.calls.length, 4, 'synthesis waits for the second coordinator update turn')
  h.finish(3, 'second requirements sent')
  await secondUpdate.completion
  await tick()
  assert.deepEqual(h.steering.map(item => item.sessionId), [first.session_id, first.session_id])
  assert.match(JSON.stringify(h.calls[4].prompt), /sales with both changes/u)
  h.finish(4, 'final revised result')
  assert.equal((await result).content, 'final revised result')
})

test('failure after a successful target send does not automatically resend the update', async t => {
  const h = harness(t)
  const { result, first } = await delegateOne(h)
  const update = h.backend.update('a', { instruction: 'Add regional totals' }, owner)
  const rejected = assert.rejects(update.completion, /coordinator disconnected/u)
  await tick()
  await h.context().sendSession({ session_id: first.session_id, prompt: 'Add regional totals' })
  h.calls[2].gate.reject(new Error('coordinator disconnected'))
  await rejected
  await tick()
  assert.equal(h.steering.length, 1)
  assert.equal(h.calls.length, 3, 'ambiguous coordinator completion must not trigger a retry')
  h.finish(1, 'revised project result')
  await tick()
  h.finish(3, 'revised result')
  await result
  assert.equal(h.steering.length, 1)
})

test('unsupported native delegated updates fail before asking the coordinator to act', async t => {
  const native = heldNativeDelegations()
  const h = harness(t, { nativeDelegationAdapter: native.adapter })
  const result = h.submit('a')
  await tick()
  h.backend.createNativeDelegation(h.backend.coordinationRuns.get('a'), {
    delegationId: 'native-run', sessionId: 'native-project', directory: '/project', title: 'Native work',
  })
  h.finish(0, 'native work delegated')
  await tick()
  assert.throws(() => h.backend.update('a', { instruction: 'change native work' }, owner), { code: 'update_unsupported' })
  await tick()
  assert.equal(h.calls.length, 1)
  assert.deepEqual(h.steering, [])
  await h.backend.cancel('a', owner)
  await assert.rejects(result)
})

test('aggregate queries remain working after only the first child completes', async t => {
  const h = harness(t)
  const { result, first, second } = await delegatePair(h)
  h.finish(1, 'first child completed')
  await tick()
  const before = h.calls.length
  const reply = await h.backend.queryDelegatedWork('a', 'Are both done?', owner)
  const answer = JSON.parse(reply.content)
  assert.equal(answer.task_id, 'a')
  assert.match(answer.result, /仍在执行中/u)
  assert.doesNotMatch(answer.result, /已经完成/u)
  assert.deepEqual(reply.metadata.delegation.targets.map(target => target.sessionId), [first.session_id, second.session_id])
  assert.equal(h.calls.length, before, 'queries must not prompt the coordinator')
  await assert.rejects(h.backend.queryDelegatedWork('a', 'private status', { ownerId: 'other' }))
  h.finish(2, 'second child completed')
  await tick()
  h.finish(3, 'both done')
  await result
})

test('multi-target updates steer only the selected child and carry attachments to it', async t => {
  const h = harness(t)
  const { result, first, second } = await delegatePair(h)
  const update = h.backend.update('a', {
    instruction: 'Use the attached chart only for the sales analysis',
    inputParts: [{ type: 'file', filename: 'chart.png', mime: 'image/png', url: 'data:image/png;base64,AQID' }],
  }, owner)
  update.completion.catch(() => {})
  await tick()
  assert.equal(h.calls.length, 4)
  assert.equal(h.calls[3].sessionId, h.calls[0].sessionId)
  assert.match(JSON.stringify(h.calls[3].prompt), /Sales analysis.*Documentation review/u)
  assert.ok(h.calls[3].prompt.some(block => block.type === 'image'))
  assert.deepEqual(h.steering, [], 'the coordinator must select a target before any steer')
  await assert.rejects(h.context().startSession({ prompt: 'unrelated new work' }), { code: 'invalid_session_route' })
  await assert.rejects(h.context().sendSession({ session_id: 'unrelated-project', prompt: 'do not send' }), { code: 'invalid_session_route' })
  const delivered = await h.context().sendSession({ session_id: first.session_id, prompt: 'Use this chart for sales only' })
  assert.equal(delivered.status, 'updated')
  assert.deepEqual(h.steering.map(item => item.sessionId), [first.session_id])
  assert.ok(h.steering[0].prompt.some(block => block.type === 'image' && block.data === 'AQID'))
  assert.equal(h.steering.some(item => item.sessionId === second.session_id), false)
  h.finish(3, 'updated the sales project')
  assert.deepEqual(await update.completion, { status: 'delivered' })
  h.finish(1, 'sales done')
  h.finish(2, 'docs done')
  await tick()
  assert.equal(h.calls.length, 5)
  assert.match(JSON.stringify(h.calls[4].prompt), /sales done.*docs done/u)
  assert.throws(() => h.backend.update('a', { instruction: 'too late' }, owner), { code: 'update_busy' })
  await assert.rejects(h.context().startSession({ prompt: 'new work from summary' }), { code: 'invalid_session_route' })
  await assert.rejects(h.context().sendSession({ session_id: first.session_id, prompt: 'rerun from summary' }), { code: 'invalid_session_route' })
  h.finish(4, 'combined result')
  assert.equal((await result).content, 'combined result')
})

test('an update may continue one finished target without replaying its running sibling', async t => {
  const h = harness(t)
  const { result, first, second } = await delegatePair(h)
  h.finish(1, 'old sales result')
  await tick()
  const update = h.backend.update('a', { instruction: 'Add regional totals to the sales result' }, owner)
  update.completion.catch(() => {})
  await tick()
  assert.equal(h.calls[3].sessionId, h.calls[0].sessionId)
  const continued = await h.context().sendSession({ session_id: first.session_id, prompt: 'Add regional totals' })
  assert.equal(continued.status, 'started')
  await tick()
  assert.equal(h.calls[4].sessionId, first.session_id)
  assert.equal(h.calls.filter(call => call.sessionId === second.session_id).length, 1)
  h.finish(3, 'continued the sales task')
  await update.completion
  h.finish(2, 'docs final')
  await tick()
  assert.equal(h.calls.length, 5, 'must wait for the replacement sales execution')
  h.finish(4, 'sales with regional totals')
  await tick()
  assert.equal(h.calls.length, 6)
  assert.match(JSON.stringify(h.calls[5].prompt), /sales with regional totals.*docs final/u)
  assert.doesNotMatch(JSON.stringify(h.calls[5].prompt), /old sales result/u)
  h.finish(5, 'updated combined result')
  assert.equal((await result).content, 'updated combined result')
})

test('partial child failure waits for siblings and preserves success in the final failed result', async t => {
  const h = harness(t)
  const events = []
  const { result, second } = await delegatePair(h, events)
  let settled = false
  result.finally(() => { settled = true }).catch(() => {})
  h.calls[1].gate.reject(new Error('sales service unavailable'))
  await tick()
  assert.equal(settled, false)
  assert.equal(h.active.has(second.session_id), true)
  assert.equal(h.calls.length, 3)
  assert.deepEqual(h.cancellations, [])
  h.finish(2, 'documentation review succeeded', [{
    type: 'resource', resource: { uri: 'result.md', mimeType: 'text/plain', text: 'Reviewed documentation' },
  }])
  await tick()
  assert.equal(h.calls.length, 4, 'successful and failed children must both reach the summary')
  assert.match(JSON.stringify(h.calls[3].prompt), /sales service unavailable/u)
  assert.match(JSON.stringify(h.calls[3].prompt), /documentation review succeeded/u)
  h.finish(3, 'Documentation succeeded; sales failed because its service is unavailable.')
  await assert.rejects(result, /Documentation succeeded; sales failed/u)
  assert.ok(events.some(event => event.type === 'backend.artifact'), 'successful child artifacts survive failure')
  assert.equal(h.active.size, 0)
})

test('successful child artifacts are delivered before a summary failure', async t => {
  const h = harness(t)
  const events = []
  const { result } = await delegatePair(h, events)
  h.finish(1, 'sales completed', [{
    type: 'resource', resource: { uri: 'sales.csv', mimeType: 'text/csv', text: 'region,total\nwest,42' },
  }])
  h.finish(2, 'documentation completed')
  await tick()
  const artifacts = events.filter(event => event.type === 'backend.artifact')
  assert.equal(artifacts.length, 1, 'child artifacts must be emitted before awaiting the summary')
  assert.match(JSON.stringify(artifacts[0]), /sales.csv/u)
  h.calls[3].gate.reject(new Error('summary unavailable'))
  await assert.rejects(result, /summary unavailable/u)
  assert.equal(events.filter(event => event.type === 'backend.artifact').length, 1)
  assert.equal(h.active.size, 0)
})

for (const targets of [1, 2]) {
  test(`cancelling an update with ${targets} target(s) stops queued routing without touching another request`, async t => {
    const h = harness(t)
    const { result, first, second } = targets === 1 ? await delegateOne(h) : await delegatePair(h)
    const failure = assert.rejects(result)
    const unrelated = h.submit('b')
    await tick()
    const update = h.backend.update('a', { instruction: 'change the sales task' }, owner)
    const updateFailure = assert.rejects(update.completion)
    await tick()
    assert.equal(h.calls.length, targets + 2)
    const otherPrompt = h.calls[targets + 1]
    assert.match(JSON.stringify(otherPrompt.prompt), /work b/u)
    await h.backend.cancel('a', owner)
    await Promise.all([failure, updateFailure])
    assert.equal(h.active.has(first.session_id), false)
    assert.ok(h.cancellations.includes(first.session_id))
    if (second) {
      assert.equal(h.active.has(second.session_id), false)
      assert.ok(h.cancellations.includes(second.session_id))
    }
    assert.equal(otherPrompt.input.signal.aborted, false)
    assert.equal(h.steering.length, 0)
    h.finish(targets + 1, 'unrelated request done')
    assert.equal((await unrelated).content, 'unrelated request done')
    assert.equal(h.calls.length, targets + 2, 'cancelled routing must never revive')
  })
}

test('initial coordinator failure waits until its child confirms cancellation', async t => {
  const h = harness(t, { manualChildCancellation: true })
  const result = h.submit('a')
  let settled = false
  result.finally(() => { settled = true }).catch(() => {})
  await tick()
  const child = await h.context().startSession({ prompt: 'project work' })
  await tick()
  h.calls[0].gate.reject(new Error('coordinator failed'))
  await tick()
  assert.equal(h.calls[1].input.signal.aborted, true)
  assert.equal(settled, false, 'task cleanup must not detach an unconfirmed child prompt')
  h.calls[1].gate.resolve({ content: '', response: { stopReason: 'cancelled' } })
  await assert.rejects(result, /coordinator failed/u)
  assert.equal(h.active.has(child.session_id), false)
  assert.equal(h.backend.coordinationRuns.has('a'), false)
})

test('initial coordinator failure cancels native delegated work, not merely its local wait', async t => {
  const nativeActive = new Set()
  const nativeCancellations = []
  const nativeDelegationAdapter = {
    wait({ runId, signal }) {
      nativeActive.add(runId)
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    },
    async cancel(input) {
      nativeCancellations.push(input)
      nativeActive.delete(input.runId)
    },
  }
  const h = harness(t, { nativeDelegationAdapter })
  const result = h.submit('a')
  await tick()
  h.backend.createNativeDelegation(h.backend.coordinationRuns.get('a'), {
    delegationId: 'native-run', sessionId: 'native-project', directory: '/project', title: 'Native work',
  })
  assert.equal(nativeActive.has('native-run'), true)
  h.calls[0].gate.reject(new Error('coordinator failed'))
  await assert.rejects(result, /coordinator failed/u)
  assert.deepEqual(nativeCancellations.map(item => item.runId), ['native-run'])
  assert.equal(nativeActive.size, 0)
})

test('external cancellation of delegated work also stops the native execution', async t => {
  const nativeActive = new Set()
  const nativeCancellations = []
  const nativeDelegationAdapter = {
    wait({ runId, signal }) {
      nativeActive.add(runId)
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    },
    async cancel(input) {
      nativeCancellations.push(input)
      nativeActive.delete(input.runId)
    },
  }
  const h = harness(t, { nativeDelegationAdapter })
  const controller = new AbortController()
  const result = h.backend.submit({ id: 'a', ownerId: owner.ownerId, objective: 'native work' }, {
    signal: controller.signal,
  })
  result.catch(() => {})
  await tick()
  h.backend.createNativeDelegation(h.backend.coordinationRuns.get('a'), {
    delegationId: 'native-run', sessionId: 'native-project', directory: '/project', title: 'Native work',
  })
  h.finish(0, 'native work delegated')
  await tick()
  controller.abort(new Error('caller disconnected'))
  await assert.rejects(result, /caller disconnected/u)
  assert.deepEqual(nativeCancellations.map(item => item.runId), ['native-run'])
  assert.equal(nativeActive.size, 0)
})

test('backend close cancels every native target instead of only aborting its local wait', async t => {
  const native = heldNativeDelegations()
  const h = harness(t, { nativeDelegationAdapter: native.adapter })
  const result = h.submit('a')
  await tick()
  const run = h.backend.coordinationRuns.get('a')
  for (const id of ['one', 'two']) {
    h.backend.createNativeDelegation(run, {
      delegationId: `native-${id}`, sessionId: `project-${id}`, directory: '/project', title: id,
    })
  }
  h.finish(0, 'native targets delegated')
  await tick()
  await h.backend.close()
  await assert.rejects(result)
  assert.deepEqual(native.cancellations.map(item => item.runId).sort(), ['native-one', 'native-two'])
  assert.equal(h.backend.coordinationRuns.size, 0)
  assert.equal(h.calls.length, 1, 'shutdown must not submit a summary')
})

test('native aggregate recovery reattaches every saved target once and waits for all before summary', async t => {
  const native = heldNativeDelegations()
  const h = harness(t, { nativeDelegationAdapter: native.adapter })
  const session = await h.backend.ensureCoordinatorSession(owner.ownerId)
  h.backend.coordinatorSessions.clear()
  const events = []
  const work = recoveredWork(session.sessionId)
  assert.equal(h.backend.canRecoverDelegatedWork(work), true)
  const recovered = h.backend.recoverDelegatedWork(work, { onEvent: event => events.push(event) })
  recovered.catch(() => {})
  await tick()
  assert.deepEqual([...native.waits.values()].map(item => [item.runId, item.sessionId]), [
    ['native-one', 'project-one'], ['native-two', 'project-two'],
  ])
  assert.equal(h.calls.length, 0, 'recovery must not replay the original objective or child prompts')
  const delegated = events.find(event => event.type === 'backend.delegated' && event.yielded)
  assert.equal(delegated.yielded, true)
  assert.equal(delegated.delegation.targets.length, 2)
  native.waits.get('native-one').resolve({ content: 'first recovered result' })
  await tick()
  assert.equal(h.calls.length, 0)
  assert.equal(events.some(event => event.type === 'backend.delegation.completed'), false)
  const unrelated = h.submit('b')
  await tick()
  assert.equal(h.calls.length, 1, 'recovered children must not occupy coordinator admission')
  native.waits.get('native-two').resolve({ content: 'second recovered result' })
  await tick()
  assert.equal(h.calls.length, 1, 'summary must serialize behind the active coordinator turn')
  h.finish(0, 'unrelated done')
  await unrelated
  await tick()
  assert.equal(h.calls[1].sessionId, session.sessionId)
  assert.match(JSON.stringify(h.calls[1].prompt), /first recovered result.*second recovered result/u)
  h.finish(1, 'both recovered')
  assert.equal((await recovered).content, 'both recovered')
  assert.equal(events.filter(event => event.type === 'backend.delegation.completed').length, 1)
  assert.equal(h.sessions.size, 1, 'recovery must use the original coordinator Session')
  assert.deepEqual(native.cancellations, [])
})

test('native aggregate recovery rejects incomplete targets and a missing coordinator without starting work', async t => {
  const native = heldNativeDelegations()
  const h = harness(t, { nativeDelegationAdapter: native.adapter })
  const session = await h.backend.ensureCoordinatorSession(owner.ownerId)
  for (const targets of [[], null, 'invalid', [{ id: 'native-one' }], [
    { id: 'native-one', sessionId: 'project-one' }, { id: 'native-two', sessionId: ' ' },
  ]]) {
    const invalid = recoveredWork(session.sessionId, { targets })
    assert.equal(h.backend.canRecoverDelegatedWork(invalid), false)
    await assert.rejects(h.backend.recoverDelegatedWork(invalid))
  }
  await assert.rejects(h.backend.recoverDelegatedWork(recoveredWork('missing-coordinator')), {
    code: 'context_unavailable',
  })
  assert.equal(native.waits.size, 0)
  assert.equal(h.calls.length, 0)
})

test('external cancellation during native aggregate recovery stops every target without summarizing', async t => {
  const native = heldNativeDelegations()
  const h = harness(t, { nativeDelegationAdapter: native.adapter })
  const session = await h.backend.ensureCoordinatorSession(owner.ownerId)
  const controller = new AbortController()
  const recovered = h.backend.recoverDelegatedWork(recoveredWork(session.sessionId), { signal: controller.signal })
  recovered.catch(() => {})
  await tick()
  assert.equal(native.waits.size, 2)
  controller.abort(new Error('recovery cancelled'))
  await assert.rejects(recovered, /recovery cancelled/u)
  assert.deepEqual(native.cancellations.map(item => item.runId).sort(), ['native-one', 'native-two'])
  assert.equal(h.calls.length, 0)
  assert.equal(h.backend.coordinationRuns.size, 0)
})

test('direct cancellation of a recovered aggregate stops the whole work before returning', async t => {
  const native = heldNativeDelegations()
  const h = harness(t, { nativeDelegationAdapter: native.adapter })
  const session = await h.backend.ensureCoordinatorSession(owner.ownerId)
  const controller = new AbortController()
  t.after(() => controller.abort(new Error('test cleanup')))
  const recovered = h.backend.recoverDelegatedWork(recoveredWork(session.sessionId), { signal: controller.signal })
  let settled = false
  recovered.finally(() => { settled = true }).catch(() => {})
  await tick()
  const receipt = await h.backend.cancel('recovered', owner)
  assert.equal(receipt.state, 'cancelled')
  await tick()
  assert.equal(h.calls.length, 0, 'cancelling recovered children must not start a failure summary')
  assert.equal(settled, true, 'cancelled receipt must wait for the recovered Work to stop')
  await assert.rejects(recovered)
  assert.deepEqual(native.cancellations.map(item => item.runId).sort(), ['native-one', 'native-two'])
  assert.equal(h.backend.coordinationRuns.size, 0)
})

test('cancelling recovery queued behind another Work never interrupts the active coordinator', async t => {
  const native = heldNativeDelegations()
  const h = harness(t, { nativeDelegationAdapter: native.adapter })
  const active = h.submit('active')
  await tick()
  const activePrompt = h.calls[0]
  const recovered = h.backend.recoverDelegatedWork(recoveredWork(activePrompt.sessionId))
  recovered.catch(() => {})
  await tick()
  assert.equal(native.waits.size, 0)
  assert.equal(h.calls.length, 1)
  assert.equal((await h.backend.cancel('recovered', owner)).state, 'cancelled')
  await assert.rejects(recovered)
  assert.equal(activePrompt.input.signal.aborted, false)
  assert.deepEqual(h.cancellations, [])
  assert.deepEqual(native.cancellations, [])
  h.finish(0, 'active Work unaffected')
  assert.equal((await active).content, 'active Work unaffected')
  await tick()
  assert.equal(native.waits.size, 0, 'cancelled queued recovery must never start later')
  assert.equal(h.calls.length, 1)
})

test('a different owner cannot abort active Work or queued recovery', async t => {
  const native = heldNativeDelegations()
  const h = harness(t, { nativeDelegationAdapter: native.adapter })
  const active = h.submit('active')
  await tick()
  const activePrompt = h.calls[0]
  const recovered = h.backend.recoverDelegatedWork(recoveredWork(activePrompt.sessionId))
  recovered.catch(() => {})
  await tick()
  for (const taskId of ['active', 'recovered']) {
    await assert.rejects(h.backend.cancel(taskId, { ownerId: 'other-owner' }))
    assert.equal(h.backend.workControllers.get(taskId).signal.aborted, false)
  }
  assert.equal(activePrompt.input.signal.aborted, false)
  assert.deepEqual(h.cancellations, [])
  assert.deepEqual(native.cancellations, [])
  h.finish(0, 'active Work unaffected')
  await active
  await tick()
  assert.equal(native.waits.size, 2, 'authorized recovery remains queued and can subsequently start')
  await h.backend.cancel('recovered', owner)
  await assert.rejects(recovered)
})

test('a long first child result cannot hide a later child failure from the summary', async t => {
  const h = harness(t)
  const { result } = await delegatePair(h)
  h.finish(1, `SALES_SUCCESS_HEAD ${'x'.repeat(20_000)} SALES_SUCCESS_TAIL`)
  h.calls[2].gate.reject(new Error('DOCUMENTATION_FAILURE_DETAILS'))
  await tick()
  assert.equal(h.calls.length, 4)
  const summary = JSON.stringify(h.calls[3].prompt)
  assert.match(summary, /SALES_SUCCESS_HEAD/u)
  assert.match(summary, /DOCUMENTATION_FAILURE_DETAILS/u)
  assert.match(summary, /Sales analysis/u)
  assert.match(summary, /Documentation review/u)
  assert.doesNotMatch(summary, /SALES_SUCCESS_TAIL/u)
  assert.ok(summary.length < 14_000, 'combined child results must remain within the bounded summary envelope')
  h.finish(3, 'Sales succeeded but documentation failed')
  await assert.rejects(result, /Sales succeeded but documentation failed/u)
})

test('aggregate status with all children cancelled is cancelled, never completed', async t => {
  const h = harness(t)
  const { result, first, second } = await delegatePair(h)
  await h.backend.cancelDelegation({ session_id: first.session_id })
  await tick()
  assert.equal(h.backend.status('a', owner).state, 'working', 'a running sibling takes precedence')
  await h.backend.cancelDelegation({ session_id: second.session_id })
  await tick()
  assert.equal(h.backend.status('a', owner).state, 'cancelled')
  const reply = await h.backend.queryDelegatedWork('a', 'Were both cancelled?', owner)
  assert.match(JSON.parse(reply.content).result, /已经取消/u)
  assert.doesNotMatch(JSON.parse(reply.content).result, /已经完成/u)
  h.finish(3, 'Both project executions were cancelled')
  await assert.rejects(result, /Both project executions were cancelled/u)
})
