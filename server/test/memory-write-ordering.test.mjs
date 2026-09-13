import assert from 'node:assert/strict'
import test from 'node:test'
import { ConversationSync } from '../src/conversation/conversation-sync.mjs'
import { createMemoryModule } from '../src/memory/module.mjs'
import { FrontendMemoryRuntime } from '../src/memory/runtime.mjs'
import { PreferenceCandidatePool } from '../src/memory/learning/preference-candidates.mjs'
import { MarkdownContextStore } from '../src/memory/providers/markdown/context-store.mjs'
import { MarkdownMemoryProvider } from '../src/memory/providers/markdown/provider.mjs'

const ownerId = 'write-race-owner'
const sessionId = 'write-race-session'
const directive = '- 以后回复简短'
const extracted = JSON.stringify({ changes: [{ document: 'user', append: directive }] })

function fixture(t, { llmCall = null, beforeApply = () => null } = {}) {
  const stores = Object.fromEntries(['user', 'memory'].map(scope => {
    const contents = new Map()
    const store = new MarkdownContextStore({ scope, template: `# ${scope.toUpperCase()}` })
    store.readRaw = owner => contents.get(owner) || `# ${scope.toUpperCase()}`
    store.persist = (owner, content) => contents.set(owner, content.trim())
    return [scope, store]
  }))
  const provider = new MarkdownMemoryProvider({ userStore: stores.user, memoryStore: stores.memory })
  const apply = provider.apply.bind(provider)
  const started = []
  const committed = []
  provider.apply = (owner, changes, context) => {
    started.push({ owner, changes, context })
    const commit = () => {
      const result = apply(owner, changes, context)
      committed.push(changes[0].document)
      return result
    }
    const waiting = beforeApply(owner, changes, context)
    return waiting ? waiting.then(commit) : commit()
  }
  const sync = new ConversationSync()
  const audit = []
  const module = createMemoryModule({
    config: { preferenceLearningEnabled: true },
    logger: { warn() {}, debug() {} },
    conversationSync: sync, memoryProvider: provider, textModelCall: llmCall,
    audit: { record: entry => audit.push(entry) },
  })
  t.after(() => module.close())
  return {
    memory: module.services.frontendMemory,
    pool: module.services.preferenceCandidates,
    promoter: module.services.preferencePromoter,
    extractor: module.sessionObservers[0].memoryExtractor,
    sync, audit, started, committed,
  }
}

function recordDirective(sync) {
  for (let index = 0; index < 4; index++) {
    sync.record({ ownerId, sessionId, id: `turn-${index}`, role: 'user',
      content: '以后回复简短', source: 'voice-user' })
  }
}

function editMemory(memory, source = 'gateway-memory-api') {
  return memory.apply(ownerId, [{ document: 'memory', append: '- 用户明确编辑的事实' }], { source })
}

function qualify(pool, value = '老师') {
  for (const session of ['one', 'two']) {
    pool.observe({ ownerId, sessionId: session, field: 'occupation', value })
  }
}

for (const source of ['gateway-memory-api', 'realtime-tool']) {
  test(`${source}: synchronous edit invalidates extraction before an already resolved model resumes`, async t => {
    const model = Promise.withResolvers()
    const { memory, extractor, sync, audit } = fixture(t, { llmCall: () => model.promise })
    recordDirective(sync)
    const extraction = extractor.maybeRun({ ownerId, sessionId })
    model.resolve(extracted)
    // No await between model resolution and the explicit synchronous write:
    // notifying after an unconditional await leaves a stale-write microtask gap.
    await editMemory(memory, source)
    await extraction
    assert.doesNotMatch(memory.list(ownerId, { scope: 'user' })[0].content, /回复简短/u)
    assert.ok(audit.some(entry => entry.reason === 'stale_observation'))
  })
}

test('a queued extraction rechecks its epoch after the preceding explicit edit commits', async t => {
  const model = Promise.withResolvers()
  const edit = Promise.withResolvers()
  const { memory, extractor, sync, started, committed, audit } = fixture(t, {
    llmCall: () => model.promise,
    beforeApply: (_owner, _changes, context) => context?.source === 'gateway-memory-api'
      ? edit.promise : null,
  })
  recordDirective(sync)
  const extraction = extractor.maybeRun({ ownerId, sessionId })
  const editing = editMemory(memory)
  model.resolve(extracted)
  await Promise.resolve() // the extractor now passes its post-model check and queues
  assert.equal(started.length, 1, 'the learning provider call waits for the owner lane')
  edit.resolve()
  await Promise.all([editing, extraction])
  assert.deepEqual(committed, ['memory'])
  assert.ok(audit.some(entry => entry.reason === 'stale_observation'))
  assert.equal(memory.ownerWrites.size, 0)
})

test('an in-flight silent promotion commits before a later explicit edit can report success', async t => {
  const promotion = Promise.withResolvers()
  const { memory, pool, promoter, started, committed } = fixture(t, {
    beforeApply: (_owner, changes) => changes[0].document === 'user' ? promotion.promise : null,
  })
  const events = []
  memory.subscribe(event => events.push(event))
  qualify(pool)
  const promoting = promoter.run({ ownerId })
  const editing = editMemory(memory)
  assert.deepEqual(started.map(entry => entry.changes[0].document), ['user'])
  assert.deepEqual(committed, [])
  promotion.resolve()
  await editing
  assert.deepEqual(committed, ['user', 'memory'])
  assert.equal((await promoting).length, 1)
  assert.deepEqual(events.map(event => event.source), ['gateway-memory-api'],
    'promotion must not refresh the current Realtime session')
  pool.observe({ ownerId, sessionId: 'new', field: 'occupation', value: '工程师' })
  const [fresh] = pool.list(ownerId)
  assert.equal(fresh.value, '工程师')
  assert.equal(fresh.state, 'tentative')
  assert.deepEqual(committed, ['user', 'memory'], 'no old write lands after explicit success')
  assert.equal(memory.ownerWrites.size, 0)
})

test('a queued promotion cannot reuse candidates discarded by a successful explicit edit', async t => {
  const edit = Promise.withResolvers()
  const { memory, pool, promoter, started, committed } = fixture(t, {
    beforeApply: (_owner, _changes, context) => context?.source === 'gateway-memory-api'
      ? edit.promise : null,
  })
  qualify(pool)
  const editing = editMemory(memory)
  const promoting = promoter.run({ ownerId })
  assert.equal(started.length, 1)
  edit.resolve()
  await editing
  pool.observe({ ownerId, sessionId: 'new', field: 'occupation', value: '工程师' })
  assert.deepEqual(await promoting, [])
  assert.deepEqual(committed, ['memory'])
  assert.equal(pool.list(ownerId)[0].state, 'tentative')
  assert.equal(memory.ownerWrites.size, 0)
})

for (const replacement of ['discard', 'contradict', 'refine', 'same', 'reject']) {
  test(`promotion confirmation is bound to the original candidate snapshot after ${replacement}`, async t => {
    const promotion = Promise.withResolvers()
    const { pool, promoter } = fixture(t, { beforeApply: () => promotion.promise })
    pool.now = () => 1
    qualify(pool)
    const promoting = promoter.run({ ownerId })
    if (replacement === 'discard') {
      pool.discardPending(ownerId)
      // Same key and value, even with a fixed clock, is a new candidate identity.
      pool.observe({ ownerId, sessionId: 'new', field: 'occupation', value: '老师' })
    } else if (replacement === 'reject') {
      pool.reject({ ownerId, key: 'occupation' })
    } else {
      pool.observe({ ownerId, sessionId: 'new', field: 'occupation',
        value: replacement === 'contradict' ? '工程师' : '老师', relation: replacement })
    }
    promotion.resolve()
    await promoting
    assert.equal(pool.list(ownerId)[0].state, replacement === 'reject' ? 'rejected' : 'tentative')
  })
}

test('candidate snapshots cannot confirm another owner or survive a pool reload', () => {
  const pool = new PreferenceCandidatePool({ now: () => 1 })
  qualify(pool)
  const [snapshot] = pool.promotable(ownerId)
  assert.equal(pool.markPromoted('another-owner', snapshot), null)
  const stored = pool.serialise()
  pool.store = { load: () => stored, save() {} }
  pool.reload()
  assert.equal(pool.markPromoted(ownerId, snapshot), null)
  assert.equal(pool.list(ownerId)[0].state, 'tentative')
})

test('owner lanes recover after rejection, remain independent, and keep guards out of provider context', async () => {
  const first = Promise.withResolvers()
  const calls = []
  const runtime = new FrontendMemoryRuntime({ provider: {
    describe: () => ({ protocolVersion: 1, key: 'test', label: 'Test' }),
    list: () => [],
    apply(owner, changes, context) {
      calls.push({ owner, changes, context, argumentCount: arguments.length })
      return calls.length === 1 ? first.promise : { changed: 1, documents: [] }
    },
  } })
  const failed = runtime.apply('one', [])
  const rejected = assert.rejects(failed, /unavailable/u)
  const next = runtime.apply('one', [], { source: 'automatic-extraction' }, () => true)
  const unrelated = runtime.apply('two', [])
  assert.deepEqual(calls.map(call => call.owner), ['one', 'two'])
  await unrelated
  first.reject(new Error('unavailable'))
  await Promise.all([rejected, next])
  assert.deepEqual(calls.map(call => call.owner), ['one', 'two', 'one'])
  assert.equal(calls[2].argumentCount, 3)
  assert.deepEqual(calls[2].context, { source: 'automatic-extraction' })
  assert.equal(runtime.ownerWrites.size, 0)
})

test('synchronous provider success notifies listeners before apply returns its promise', async () => {
  const events = []
  const runtime = new FrontendMemoryRuntime({ provider: {
    describe: () => ({ protocolVersion: 1, key: 'test', label: 'Test' }),
    list: () => [],
    apply: () => ({ changed: 1, documents: [] }),
  } })
  runtime.subscribe(event => events.push(event))
  const pending = runtime.apply(ownerId, [], { source: 'gateway-memory-api' })
  assert.equal(events.length, 1)
  await pending
  assert.equal(runtime.ownerWrites.size, 0)
})

test('a success listener can enqueue another same-owner write without reentrancy or deadlock', async () => {
  const order = []
  const runtime = new FrontendMemoryRuntime({ provider: {
    describe: () => ({ protocolVersion: 1, key: 'test', label: 'Test' }),
    list: () => [],
    apply(_owner, _changes, context) {
      order.push(context.source)
      return { changed: 1, documents: [] }
    },
  } })
  let followup
  runtime.subscribe(event => {
    if (event.source !== 'first') return
    followup = runtime.apply(ownerId, [], { source: 'second' })
    assert.deepEqual(order, ['first'])
  })
  await runtime.apply(ownerId, [], { source: 'first' })
  await followup
  assert.deepEqual(order, ['first', 'second'])
  assert.equal(runtime.ownerWrites.size, 0)
})
