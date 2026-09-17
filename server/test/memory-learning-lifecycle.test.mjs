import assert from 'node:assert/strict'
import test from 'node:test'
import { ConversationSync } from '../src/conversation/conversation-sync.mjs'
import { createMemoryModule } from '../src/memory/module.mjs'
import { MarkdownContextStore } from '../src/memory/providers/markdown/context-store.mjs'
import { MarkdownMemoryProvider } from '../src/memory/providers/markdown/provider.mjs'

const context = { ownerId: 'driver', sessionId: 'persistent-cockpit-session' }
const oldFact = '- 用户喜欢吃辣'
const newFact = '- 用户喜欢吃烧烤'
const patch = fact => JSON.stringify({ changes: [{ document: 'memory', edits: [], append: fact }] })

function memoryProvider(initial = '# MEMORY') {
  const stores = Object.fromEntries(['user', 'memory'].map(scope => {
    let content = scope === 'user' ? '# USER' : initial
    const store = new MarkdownContextStore({ scope, template: `# ${scope.toUpperCase()}` })
    // Exercise real revisions, exact matching and normalization entirely in
    // memory. Never read or modify the user's files or call an external model.
    store.readRaw = () => content
    store.persist = (_ownerId, value) => { content = value.trim() }
    return [scope, store]
  }))
  return new MarkdownMemoryProvider({ userStore: stores.user, memoryStore: stores.memory })
}

function moduleFixture(t, { sync = new ConversationSync(), provider = memoryProvider(), llmCall,
  preferenceLearningEnabled = false } = {}) {
  const audit = []
  const module = createMemoryModule({
    config: { preferenceLearningEnabled },
    logger: { warn() {}, debug() {} },
    conversationSync: sync, memoryProvider: provider,
    textModelCall: llmCall, audit: { record: entry => audit.push(entry) },
  })
  t.after(() => module.close())
  const observer = module.sessionObservers[0]
  observer.memoryExtractor.debounceMs = 0
  return { module, sync, provider, observer, audit, memory: module.services.frontendMemory }
}

function recordTurns(sync, prefix, text = '我喜欢吃辣', count = 4) {
  for (let index = 0; index < count; index++) {
    sync.record({ ...context, id: `${prefix}-${index}`, role: 'user', content: text, source: 'voice-user' })
  }
}

function removeFact(memory, fact, source = 'gateway-memory-api') {
  const document = memory.list(context.ownerId, { scope: 'memory' })[0]
  return memory.apply(context.ownerId, [{
    document: 'memory', expectedRevision: document.revision,
    edits: [{ old_text: fact, new_text: '' }],
  }], { source })
}

test('deleted memory stays deleted across shutdown and restart with restored conversation history', async t => {
  let calls = 0
  const first = moduleFixture(t, { llmCall: async () => { calls++; return patch(oldFact) } })
  recordTurns(first.sync, 'old')
  await first.observer.onSessionClosed(context)
  assert.equal(calls, 1)
  await removeFact(first.memory, oldFact)
  const history = first.sync.list(context)
  assert.equal(history.length, 4)
  await first.observer.onSessionClosed(context)
  assert.equal(calls, 1, 'shutdown does not learn deleted pre-edit evidence again')

  const restartedSync = new ConversationSync()
  restartedSync.restore({ ...context, messages: history })
  const restarted = moduleFixture(t, {
    sync: restartedSync, provider: first.provider,
    llmCall: async () => { calls++; return patch(oldFact) },
  })
  await restarted.observer.onSessionClosed(context)
  await restarted.observer.onSessionClosed(context)
  assert.equal(calls, 1, 'empty reconnects never call the extraction model')
  assert.equal(restartedSync.frontendContext(context).length, 4)
  assert.doesNotMatch(restarted.memory.list(context.ownerId, { scope: 'memory' })[0].content, /吃辣/u)
})

for (const source of ['gateway-memory-api', 'realtime-tool']) {
  test(`${source}: deletion discards pending old evidence but new conversation still learns`, async t => {
    const calls = []
    const fixture = moduleFixture(t, {
      provider: memoryProvider(`# MEMORY\n${oldFact}`),
      llmCall: async input => { calls.push(input); return patch(newFact) },
    })
    recordTurns(fixture.sync, 'before-deletion')
    await removeFact(fixture.memory, oldFact, source)
    await fixture.observer.onSessionClosed(context)
    assert.equal(calls.length, 0)
    recordTurns(fixture.sync, 'after-deletion', '我喜欢吃烧烤', 3)
    await fixture.observer.onSessionClosed(context)
    assert.equal(calls.length, 0, 'threshold counts only new evidence')
    recordTurns(fixture.sync, 'last-new-turn', '记下我喜欢吃烧烤', 1)
    await fixture.observer.onSessionClosed(context)
    assert.equal(calls.length, 1)
    assert.match(calls[0].user, /吃烧烤/u)
    assert.doesNotMatch(calls[0].user, /吃辣/u)
    assert.match(fixture.memory.list(context.ownerId, { scope: 'memory' })[0].content, /吃烧烤/u)
    await fixture.observer.onSessionClosed(context)
    assert.equal(calls.length, 1, 'even with debounce disabled, the batch is consumed once')
    assert.equal(fixture.sync.list(context).length, 8)
  })
}

test('deletion invalidates a delayed extraction result, even if the document revision later returns to its old value', async t => {
  const deferred = Promise.withResolvers()
  const fixture = moduleFixture(t, {
    provider: memoryProvider(`# MEMORY\n${oldFact}`), llmCall: () => deferred.promise,
  })
  recordTurns(fixture.sync, 'pending')
  const closing = fixture.observer.onSessionClosed(context)
  await removeFact(fixture.memory, oldFact)
  // ABA revision: a separate explicit write restores the same old bytes. The
  // original learning batch still has no authority to add its delayed result.
  fixture.provider.stores.memory.persist(context.ownerId, `# MEMORY\n${oldFact}`)
  deferred.resolve(patch(newFact))
  await closing
  assert.doesNotMatch(fixture.memory.list(context.ownerId, { scope: 'memory' })[0].content, /吃烧烤/u)
  assert.ok(fixture.audit.some(entry => entry.reason === 'stale_observation'))
})

test('failed and no-op edits do not discard pending evidence', async t => {
  let calls = 0
  const fixture = moduleFixture(t, { llmCall: async () => { calls++; return patch(newFact) } })
  recordTurns(fixture.sync, 'fresh', '我喜欢吃烧烤')
  await assert.rejects(removeFact(fixture.memory, '- 不存在的条目'), { code: 'edit_not_found' })
  await fixture.memory.apply(context.ownerId, [{
    document: 'memory', edits: [{ old_text: '# MEMORY', new_text: '# MEMORY' }],
  }], { source: 'gateway-memory-api' })
  await fixture.observer.onSessionClosed(context)
  assert.equal(calls, 1)
  assert.match(fixture.memory.list(context.ownerId, { scope: 'memory' })[0].content, /吃烧烤/u)
})

for (const withModel of [true, false]) {
  test(`manual deletion clears profile evidence with model enabled=${withModel}`, async t => {
    const fixture = moduleFixture(t, {
      preferenceLearningEnabled: true, llmCall: withModel ? async () => '{"changes":[]}' : undefined,
    })
    const pool = fixture.module.services.preferenceCandidates
    const observed = pool.observe({ ...context, field: 'response_length', value: 'brief' })
    pool.markPromoted(context.ownerId, observed.key)
    const [active] = pool.list(context.ownerId, { state: 'active' })
    assert.equal(active.label, '回答简短，直接说要点')
    fixture.provider.stores.user.persist(context.ownerId, `# USER\n## 观察推断\n- ${active.label}`)
    pool.observe({ ...context, field: 'occupation', value: '老师' })
    assert.equal(pool.list(context.ownerId, { state: 'tentative' }).length, 1)
    const document = fixture.memory.list(context.ownerId, { scope: 'user' })[0]
    await fixture.memory.apply(context.ownerId, [{
      document: 'user', expectedRevision: document.revision,
      edits: [{ old_text: `- ${active.label}`, new_text: '' }],
    }], { source: 'gateway-memory-api' })
    assert.equal(pool.list(context.ownerId, { state: 'tentative' }).length, 0)
    assert.equal(pool.promotable(context.ownerId).length, 0)
    assert.equal(pool.blocked(context.ownerId, 'response_length', 'brief'), false,
      'a bounded document snapshot must not infer a permanent user rejection')
  })
}

test('new turns received during extraction remain eligible after the automatic write', async t => {
  const deferred = Promise.withResolvers()
  const calls = []
  const fixture = moduleFixture(t, { llmCall: input => {
    calls.push(input)
    return calls.length === 1 ? deferred.promise : Promise.resolve(patch(newFact))
  } })
  recordTurns(fixture.sync, 'first', '我喜欢吃辣')
  const closing = fixture.observer.onSessionClosed(context)
  recordTurns(fixture.sync, 'second', '我喜欢吃烧烤')
  deferred.resolve(patch(oldFact))
  await closing
  await fixture.observer.onSessionClosed(context)
  assert.equal(calls.length, 2)
  assert.match(calls[1].user.split('## 对话转写')[1], /吃烧烤/u)
  assert.doesNotMatch(calls[1].user.split('## 对话转写')[1], /吃辣/u)
  const content = fixture.memory.list(context.ownerId, { scope: 'memory' })[0].content
  assert.ok(content.includes(oldFact))
  assert.ok(content.includes(newFact))
})
