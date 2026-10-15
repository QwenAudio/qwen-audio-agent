import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { AcpBackendAdapter } from '../src/backend/adapters/acp/backend-adapter.mjs'
import { BackendWorkRuntime } from '../src/backend/backend-work-runtime.mjs'
import { ConversationSync } from '../src/conversation/conversation-sync.mjs'
import { TaskOperations } from '../src/orchestration/task-operations.mjs'
import { TaskManager } from '../src/task/task-manager.mjs'

const identity = { ownerId: 'owner', sessionId: 'voice' }
const tick = () => new Promise(resolve => setImmediate(resolve))
const text = prompt => typeof prompt === 'string'
  ? prompt : prompt.filter(block => block.type === 'text').map(block => block.text).join('\n')

function record(sync, id, content, options = {}) {
  return sync.record({ ...identity, id, role: 'user', source: 'voice-user', content,
    createdAt: 1_000, ...options })
}

function capture(sync, turnId, options = {}) {
  return sync.coordinatorSnapshot({ ...identity, excludeTurnId: turnId, ...options })
}

function harness(t, { mode = 'extension', sessionStatePath = null } = {}) {
  const calls = []
  const sessions = new Map()
  const steering = []
  const cancellations = []
  const client = {
    connectionGeneration: 1,
    async start() { return { agentCapabilities: { mcpCapabilities: { http: true } } } },
    async newSession(input) {
      const session = { sessionId: `session-${sessions.size + 1}`, cwd: input.cwd,
        connectionGeneration: 1, response: {} }
      sessions.set(session.sessionId, session)
      return session
    },
    async resumeSession(sessionId, input) {
      const session = { sessionId, cwd: input.cwd, connectionGeneration: 1, response: {} }
      sessions.set(sessionId, session)
      return session
    },
    prompt(sessionId, prompt, options = {}) {
      const gate = Promise.withResolvers()
      calls.push({ sessionId, prompt, options, gate })
      return gate.promise
    },
    steeringMode: () => mode,
    async steerSession(sessionId, prompt) {
      steering.push({ sessionId, prompt })
      return { outcome: 'injected' }
    },
    async cancelSession(sessionId) { cancellations.push(sessionId) },
    async close() {},
  }
  const sessionToolServer = {
    async register(context) {
      return { context, descriptor: { type: 'http', name: 'test', url: 'http://test', headers: [] },
        update(next) { this.context = next }, release() {} }
    },
    async close() {},
  }
  const backend = new AcpBackendAdapter({ protocol: 'acp', directory: '/project', client,
    builtinMcp: [], sessionToolServer, sessionStatePath,
    profile: { label: 'Test ACP', externalMcp: true, capabilities: {},
      acpConnection: { kind: 'process' } },
  })
  t.after(() => backend.close())
  const finish = (index, content = 'done') => calls[index].gate.resolve({
    content, response: { stopReason: 'end_turn' },
  })
  const submit = (id, conversation, extra = {}) => {
    const result = backend.submit({ id, ownerId: 'owner', objective: `work ${id}`, conversation, ...extra })
    result.catch(() => {})
    return result
  }
  const cursor = (frontendSession = 'voice') => backend.registry.get('acp:owner:backend')
    ?.conversationCursors?.[frontendSession]
  return { backend, client, calls, sessions, steering, cancellations, finish, submit, cursor }
}

test('TaskOperations freezes queued conversation at admission through BackendWorkRuntime and ACP', async t => {
  const h = harness(t)
  const sync = new ConversationSync()
  const manager = new TaskManager({ maxConcurrent: 1, maxConcurrentPerOwner: 1 })
  const operations = new TaskOperations({ taskManager: manager,
    backendRuntime: new BackendWorkRuntime({ backend: h.backend }),
    conversationSnapshot: context => sync.coordinatorSnapshot({
      ...context, excludeTurnId: context.turnId,
    }),
  })
  record(sync, 'seed', 'historical seed')
  record(sync, 'first', 'first current input', { turnId: 'first-turn' })
  const first = operations.submit({ objective: 'first task' }, { ...identity, turnId: 'first-turn' })
  await tick()
  h.calls[0].options.onUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'accepted' } })
  record(sync, 'natural', 'spoken before queued admission', { role: 'assistant', source: 'realtime-direct' })
  record(sync, 'queued', 'queued current input', { turnId: 'queued-turn' })
  const queued = operations.submit({ objective: 'queued task' }, { ...identity, turnId: 'queued-turn' })
  record(sync, 'future', 'future text after queued admission')
  assert.equal(manager.get(queued.id).status, 'queued')
  h.finish(0)
  await manager.wait(first.id)
  await tick()
  assert.equal(h.calls[1].sessionId, h.calls[0].sessionId)
  const prompt = text(h.calls[1].prompt)
  assert.match(prompt, /spoken before queued admission/)
  assert.doesNotMatch(prompt, /historical seed|queued current input|future text after queued admission/)
  h.finish(1)
  assert.equal((await manager.wait(queued.id)).status, 'completed')
})

test('BackendWorkRuntime preserves conversation for user work but strips isolated utility work', async t => {
  const h = harness(t)
  const submitted = []
  h.backend.submit = async work => { submitted.push(work); return { content: 'done' } }
  const runtime = new BackendWorkRuntime({ backend: h.backend })
  const sync = new ConversationSync()
  record(sync, 'input', 'history')
  const conversation = capture(sync)
  await runtime.run({ objective: 'user work', conversation }, { ...identity, taskId: 'user' })
  await runtime.runIsolated({ objective: 'utility work', conversation }, { ...identity, taskId: 'utility' })
  assert.equal(submitted[0].conversation, conversation)
  assert.equal(Object.hasOwn(submitted[1], 'conversation'), false)
  assert.equal(submitted[1].continuity, 'isolated')
})

test('TaskManager-queued updates keep snapshots from multiple frontend sessions through initial ACP delivery', async t => {
  const h = harness(t)
  const sync = new ConversationSync()
  const manager = new TaskManager({ maxConcurrent: 1, maxConcurrentPerOwner: 1 })
  const operations = new TaskOperations({ taskManager: manager,
    backendRuntime: new BackendWorkRuntime({ backend: h.backend }),
    conversationSnapshot: context => sync.coordinatorSnapshot({
      ...context, excludeTurnId: context.turnId,
    }),
  })
  record(sync, 'seed', 'accepted historical seed')
  const blocker = operations.submit({ objective: 'blocking task' }, identity)
  await tick()
  h.calls[0].options.onUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'accepted' } })
  record(sync, 'voice-background', 'voice context before task admission', { role: 'assistant', source: 'realtime-direct' })
  record(sync, 'queued-current', 'voice current user input', { turnId: 'queued-turn' })
  const queued = operations.submit({ objective: 'queued task' }, { ...identity, turnId: 'queued-turn' })
  record(sync, 'other-background', 'other frontend context before update', { sessionId: 'other' })
  record(sync, 'other-current', 'other current user input', { sessionId: 'other', turnId: 'other-turn' })
  assert.equal(operations.update({ taskId: queued.id, instruction: 'queued update requirement' }, {
    ownerId: 'owner', sessionId: 'other', turnId: 'other-turn',
  }).status, 'accepted')
  record(sync, 'voice-future', 'future voice conversation')
  record(sync, 'other-future', 'future other conversation', { sessionId: 'other' })
  h.finish(0)
  await manager.wait(blocker.id)
  await tick()
  const delivered = text(h.calls[1].prompt)
  assert.match(delivered, /voice context before task admission/)
  assert.match(delivered, /other frontend context before update/)
  assert.match(delivered, /queued update requirement/)
  assert.doesNotMatch(delivered, /accepted historical seed|voice current user input|other current user input|future voice conversation|future other conversation/)
  h.finish(1)
  assert.equal((await manager.wait(queued.id)).status, 'completed')
  assert.equal(h.cursor().messageId, 'queued-current')
  assert.equal(h.cursor('other').messageId, 'other-current')
})

test('ACP acknowledges conversation on first update or result, never before failed acceptance', async t => {
  const h = harness(t)
  const sync = new ConversationSync()
  record(sync, 'seed', 'retryable history')
  const conversation = capture(sync)
  const failed = h.submit('failed', conversation)
  await tick()
  assert.equal(h.cursor(), undefined)
  h.calls[0].gate.reject(new Error('failed before accepted'))
  await assert.rejects(failed, /failed before accepted/)
  assert.equal(h.cursor(), undefined)

  const accepted = h.submit('accepted', conversation)
  await tick()
  assert.match(text(h.calls[1].prompt), /retryable history/)
  h.calls[1].options.onUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'accepted' } })
  assert.deepEqual(h.cursor(), conversation.cursor)
  h.finish(1)
  await accepted

  record(sync, 'later', 'history acknowledged only on return')
  const later = capture(sync)
  const resultOnly = h.submit('result-only', later)
  await tick()
  assert.deepEqual(h.cursor(), conversation.cursor)
  assert.doesNotMatch(text(h.calls[2].prompt), /retryable history/)
  h.finish(2)
  await resultOnly
  assert.deepEqual(h.cursor(), later.cursor)
})

test('registry restoration retains per-frontend-session cursors without re-sending old dialogue', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'qwaudio-conversation-delivery-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const sessionStatePath = join(directory, 'sessions.json')
  const first = harness(t, { sessionStatePath })
  const sync = new ConversationSync()
  record(sync, 'a', 'voice history')
  record(sync, 'b', 'other frontend history', { sessionId: 'other', createdAt: 9_000 })
  const voice = capture(sync)
  const other = capture(sync, undefined, { sessionId: 'other' })
  const a = first.submit('a', voice)
  await tick()
  first.finish(0)
  const result = await a
  const b = first.submit('b', other)
  await tick()
  first.finish(1)
  await b
  await first.backend.close()

  const restored = harness(t, { sessionStatePath })
  record(sync, 'a-later', 'voice new delta')
  const next = restored.submit('next', capture(sync), { resumeContext: result.continuation })
  await tick()
  assert.equal(restored.calls[0].sessionId, result.continuation.token)
  assert.match(text(restored.calls[0].prompt), /voice new delta/)
  assert.doesNotMatch(text(restored.calls[0].prompt), /voice history|other frontend history/)
  restored.finish(0)
  await next
  const otherAgain = restored.submit('other-again', other)
  await tick()
  assert.doesNotMatch(text(restored.calls[1].prompt), /other frontend history|近期人机对话/)
  restored.finish(1)
  await otherAgain
  assert.deepEqual(restored.cursor('other'), other.cursor)
})

test('fresh coordinator recovery re-sends bounded context after discarding the old Session cursor', async t => {
  const h = harness(t)
  const sync = new ConversationSync()
  record(sync, 'seed', 'needed in a fresh backend session')
  const work = h.submit('recover', capture(sync))
  await tick()
  h.finish(0, '')
  await tick()
  assert.equal(h.calls.length, 2)
  assert.notEqual(h.calls[1].sessionId, h.calls[0].sessionId)
  assert.match(text(h.calls[1].prompt), /needed in a fresh backend session/)
  h.finish(1)
  await work
})

test('failed restoration creates a fresh coordinator without inheriting the old Session dialogue cursor', async t => {
  const first = harness(t)
  const sync = new ConversationSync()
  record(sync, 'seed', 'context needed after failed restoration')
  const conversation = capture(sync)
  const initial = first.submit('initial', conversation)
  await tick()
  first.finish(0)
  await initial
  assert.deepEqual(first.cursor(), conversation.cursor)

  const next = harness(t)
  next.backend.registry.loaded = true
  next.backend.registry.coordinators = Object.fromEntries(first.backend.registry.coordinatorEntries())
  next.client.resumeSession = async () => { throw new Error('old remote Session is gone') }
  next.client.newSession = async input => ({
    sessionId: 'fresh-coordinator', cwd: input.cwd, connectionGeneration: 1, response: {},
  })
  const resumed = next.submit('resumed', conversation)
  await tick()
  assert.equal(next.calls[0].sessionId, 'fresh-coordinator')
  assert.equal(next.cursor(), undefined)
  assert.match(text(next.calls[0].prompt), /context needed after failed restoration/)
  next.finish(0)
  await resumed
  assert.deepEqual(next.cursor(), conversation.cursor)
})

for (const mode of ['extension', 'restart', 'pull']) {
  test(`${mode} updates carry only newly admitted context and do not rewind on old prompt acknowledgement`, async t => {
    const h = harness(t, { mode })
    const sync = new ConversationSync()
    record(sync, 'seed', 'old accepted history')
    record(sync, 'start', 'initial input', { turnId: 'start-turn' })
    const work = h.submit('work', capture(sync, 'start-turn'))
    await tick()
    h.calls[0].options.onUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'accepted' } })
    record(sync, 'natural', 'new spoken context', { role: 'assistant', source: 'agent-presentation' })
    record(sync, 'adjust', 'current update input', { turnId: 'adjust-turn' })
    const conversation = capture(sync, 'adjust-turn')
    const update = h.backend.update('work', { instruction: 'adjust the task', conversation }, { ownerId: 'owner' })
    await tick()
    let sent
    let current = 0
    if (mode === 'extension') {
      sent = h.steering[0].prompt
    } else if (mode === 'pull') {
      const drained = h.calls[0].options.onMidTurnDrain()
      assert.equal(drained.items.length, 1)
      sent = drained.items[0].content
      assert.deepEqual(h.calls[0].options.onMidTurnDrain().items, [])
    } else {
      assert.deepEqual(h.cancellations, [h.calls[0].sessionId])
      h.calls[0].gate.resolve({ content: 'superseded', response: { stopReason: 'cancelled' } })
      await tick()
      current = 1
      sent = h.calls[1].prompt
      h.calls[1].options.onUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'updated' } })
    }
    assert.match(text(sent), /new spoken context/)
    assert.doesNotMatch(text(sent), /old accepted history|current update input/)
    assert.equal(text(sent).split('new spoken context').length - 1, 1)
    await update.completion
    assert.deepEqual(h.cursor(), conversation.cursor)
    h.finish(current)
    await work
    assert.deepEqual(h.cursor(), conversation.cursor, 'late initial acknowledgement cannot rewind')
    const subsequent = h.submit('subsequent', conversation)
    await tick()
    assert.doesNotMatch(text(h.calls.at(-1).prompt), /new spoken context|old accepted history|近期人机对话/)
    h.finish(h.calls.length - 1)
    await subsequent
  })
}

test('one native update batch preserves multiple frontend contexts and selects the newest same-session snapshot', async t => {
  const h = harness(t)
  const sync = new ConversationSync()
  record(sync, 'seed', 'accepted seed')
  const work = h.submit('work', capture(sync))
  await tick()
  h.calls[0].options.onUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'accepted' } })
  record(sync, 'old', 'older voice delta')
  const older = capture(sync)
  record(sync, 'new', 'newest voice delta')
  const newer = capture(sync)
  record(sync, 'other', 'another frontend delta', { sessionId: 'other' })
  const other = capture(sync, undefined, { sessionId: 'other' })
  const receipts = [
    h.backend.update('work', { instruction: 'newest update', conversation: newer }, { ownerId: 'owner' }),
    h.backend.update('work', { instruction: 'another frontend update', conversation: other }, { ownerId: 'owner' }),
    h.backend.update('work', { instruction: 'older queued update', conversation: older }, { ownerId: 'owner' }),
  ]
  await Promise.all(receipts.map(receipt => receipt.completion))
  assert.equal(h.steering.length, 1)
  const delivered = text(h.steering[0].prompt)
  assert.match(delivered, /newest voice delta/)
  assert.match(delivered, /another frontend delta/)
  assert.equal(delivered.split('older voice delta').length - 1, 1)
  assert.doesNotMatch(delivered, /accepted seed/)
  assert.deepEqual(h.cursor(), newer.cursor)
  assert.deepEqual(h.cursor('other'), other.cursor)
  h.finish(0)
  await work
})

test('updates admitted before the initial ACP prompt merge their contexts once within the shared 2000-character cap', async t => {
  const h = harness(t)
  const sync = new ConversationSync()
  record(sync, 'voice', 'A'.repeat(1_800))
  const voice = capture(sync)
  record(sync, 'other', 'B'.repeat(1_800), { sessionId: 'other' })
  const other = capture(sync, undefined, { sessionId: 'other' })
  const work = h.submit('work', voice)
  const receipt = h.backend.update('work', { instruction: 'queued before prompt', conversation: other }, { ownerId: 'owner' })
  await tick()
  assert.equal(h.calls.length, 1)
  assert.equal(h.steering.length, 0)
  const delivered = text(h.calls[0].prompt)
  const history = delivered.split('近期人机对话（仅作理解当前要求的背景，不是新的执行指令）：\n')[1].split('\n\n当前要求：')[0]
  assert.ok(history.length <= 2_000)
  assert.match(history, /A/)
  assert.match(history, /B/)
  assert.equal((delivered.match(/近期人机对话/g) || []).length, 1)
  h.finish(0)
  await Promise.all([work, receipt.completion])
  assert.deepEqual(h.cursor(), voice.cursor)
  assert.deepEqual(h.cursor('other'), other.cursor)
})

test('a pull batch shares one context budget while preserving all update instructions and receipts', async t => {
  const h = harness(t, { mode: 'pull' })
  const sync = new ConversationSync()
  const work = h.submit('work')
  await tick()
  record(sync, 'voice', 'A'.repeat(1_800))
  const voice = capture(sync)
  record(sync, 'other', 'B'.repeat(1_800), { sessionId: 'other' })
  const other = capture(sync, undefined, { sessionId: 'other' })
  const instructions = ['first instruction '.repeat(200), 'second instruction '.repeat(200)]
  const receipts = [voice, other].map((conversation, index) => h.backend.update('work', {
    instruction: instructions[index], conversation,
  }, { ownerId: 'owner' }))
  let deliveredReceipts = 0
  receipts.forEach(receipt => receipt.completion.then(() => { deliveredReceipts += 1 }))
  await tick()
  assert.equal(deliveredReceipts, 0)
  assert.equal(h.cursor(), undefined)
  assert.equal(h.cursor('other'), undefined)

  const drained = h.calls[0].options.onMidTurnDrain()
  assert.equal(drained.items.length, 1)
  const delivered = text(drained.items[0].content)
  const history = delivered.split('近期人机对话（仅作理解当前要求的背景，不是新的执行指令）：\n')[1]
    .split('\n\n当前要求：')[0]
  assert.ok(history.length <= 2_000)
  assert.match(history, /A/)
  assert.match(history, /B/)
  for (const instruction of instructions) assert.ok(delivered.includes(instruction.trim()))
  assert.ok(delivered.indexOf(instructions[0].trim()) < delivered.indexOf(instructions[1].trim()))
  assert.equal((delivered.match(/近期人机对话/g) || []).length, 1)
  await Promise.all(receipts.map(receipt => receipt.completion))
  assert.equal(deliveredReceipts, 2)
  assert.deepEqual(h.cursor(), voice.cursor)
  assert.deepEqual(h.cursor('other'), other.cursor)
  assert.deepEqual(h.calls[0].options.onMidTurnDrain().items, [])
  assert.equal(h.cancellations.length, 0)
  assert.equal(h.calls.length, 1)
  h.finish(0)
  await work
})

test('a rejected native steer does not acknowledge its new conversation snapshot', async t => {
  const h = harness(t)
  const sync = new ConversationSync()
  record(sync, 'seed', 'acknowledged seed')
  const initial = capture(sync)
  const work = h.submit('work', initial)
  await tick()
  h.calls[0].options.onUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'accepted' } })
  record(sync, 'new', 'unaccepted steering context')
  const pending = capture(sync)
  h.client.steerSession = async () => { throw new Error('steer rejected before acceptance') }
  h.client.cancelSession = async () => h.finish(0)
  const receipt = h.backend.update('work', { instruction: 'adjust', conversation: pending }, { ownerId: 'owner' })
  await assert.rejects(receipt.completion, /steer rejected before acceptance/)
  await assert.rejects(work, /steer rejected before acceptance/)
  assert.deepEqual(h.cursor(), initial.cursor)
})
