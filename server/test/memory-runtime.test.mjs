import assert from 'node:assert/strict'
import test from 'node:test'
import { FrontendMemoryRuntime } from '../src/memory/runtime.mjs'

function provider(overrides = {}) {
  return {
    describe: () => ({
      protocolVersion: 1,
      key: 'fixture',
      label: 'Fixture Memory',
    }),
    list: () => [],
    apply: async () => ({ changed: 0, documents: [] }),
    ...overrides,
  }
}

test('keeps trusted mutation context separate from model changes', async () => {
  let received
  const events = []
  const runtime = new FrontendMemoryRuntime({
    provider: provider({
      apply: async (ownerId, changes, context) => {
        received = { ownerId, changes, context }
        return { changed: 1, documents: [{ scope: 'memory', content: 'fact' }] }
      },
    }),
  })
  runtime.subscribe(event => events.push(event))
  const changes = [{
    document: 'memory', append: '- fact', ownerId: 'forged-owner',
    source: 'forged-source', sessionId: 'forged-session',
  }]
  const context = { source: 'realtime-tool', sessionId: 'session-private' }
  const result = await runtime.apply('owner-private', changes, context)
  assert.deepEqual(received, { ownerId: 'owner-private', changes, context })
  assert.equal(result.changed, 1)
  assert.deepEqual(events, [{
    ownerId: 'owner-private', source: 'realtime-tool', sessionId: 'session-private',
  }])
  assert.equal(Object.isFrozen(events[0]), true)
})

test('notifies synchronously after a successful normalized write without exposing document contents', async () => {
  let completeWrite
  const order = []
  const events = []
  const runtime = new FrontendMemoryRuntime({
    provider: provider({
      apply: () => new Promise(resolve => { completeWrite = resolve }),
    }),
  })
  runtime.subscribe(event => {
    order.push('notification')
    events.push(event)
  })
  const pending = runtime.apply('owner-one', [], { source: 'gateway-memory-api' })
    .then(result => {
      order.push('resolved')
      return result
    })
  assert.deepEqual(events, [])

  completeWrite({ changed: '2.9', documents: [{ scope: 'memory', content: 'private fact' }] })
  const result = await pending

  assert.equal(result.changed, 2)
  assert.equal(result.documents[0].content, 'private fact')
  assert.deepEqual(events, [{ ownerId: 'owner-one', source: 'gateway-memory-api', sessionId: null }])
  assert.deepEqual(order, ['notification', 'resolved'])
})

test('notifications retain each owner identity and default absent mutation context', async () => {
  const events = []
  const runtime = new FrontendMemoryRuntime({
    provider: provider({ apply: async () => ({ changed: 1, documents: [] }) }),
  })
  runtime.subscribe(event => events.push(event))

  await runtime.apply('owner-one', [])
  await runtime.apply('owner-two', [], { source: 'realtime-tool', sessionId: 'session-two' })

  assert.deepEqual(events, [
    { ownerId: 'owner-one', source: '', sessionId: null },
    { ownerId: 'owner-two', source: 'realtime-tool', sessionId: 'session-two' },
  ])
})

test('does not notify for normalized no-op writes, provider failures, or malformed results', async () => {
  const events = []
  const runtime = new FrontendMemoryRuntime({ provider: provider() })
  runtime.subscribe(event => events.push(event))

  for (const changed of [0, -1, 0.9, undefined, null, 'not-a-number']) {
    runtime.provider.apply = async () => ({ changed, documents: [] })
    assert.equal((await runtime.apply('owner', [])).changed, 0)
  }
  runtime.provider.apply = async () => { throw new Error('write failed') }
  await assert.rejects(runtime.apply('owner', []), /write failed/)
  for (const result of [null, {}, { changed: 1, documents: null }]) {
    runtime.provider.apply = async () => result
    await assert.rejects(runtime.apply('owner', []), /changed and documents/)
  }

  assert.deepEqual(events, [])
})

test('isolates listener exceptions and immutable notifications while allowing unsubscribe', async () => {
  const events = []
  const runtime = new FrontendMemoryRuntime({
    provider: provider({ apply: async () => ({ changed: 1, documents: [] }) }),
  })
  assert.throws(() => runtime.subscribe(null), /listener must be a function/)
  const unsubscribeThrowing = runtime.subscribe(event => {
    event.ownerId = 'mutated-owner'
  })
  runtime.subscribe(async () => { throw new Error('async observer failed') })
  const unsubscribe = runtime.subscribe(event => events.push(event))

  assert.deepEqual(await runtime.apply('owner', []), { changed: 1, documents: [] })
  assert.deepEqual(events, [{ ownerId: 'owner', source: '', sessionId: null }])
  unsubscribe()
  unsubscribe()
  unsubscribeThrowing()
  await runtime.apply('owner', [])
  assert.equal(events.length, 1)
})

test('closing drops listeners and prevents subscriptions or pending writes from notifying', async () => {
  let completeWrite
  let closeCount = 0
  const events = []
  const runtime = new FrontendMemoryRuntime({
    provider: provider({
      apply: () => new Promise(resolve => { completeWrite = resolve }),
      close: async () => { closeCount += 1 },
    }),
  })
  runtime.subscribe(event => events.push(event))
  const pending = runtime.apply('owner', [])

  await runtime.close()
  const unsubscribeAfterClose = runtime.subscribe(event => events.push(event))
  completeWrite({ changed: 1, documents: [] })
  assert.deepEqual(await pending, { changed: 1, documents: [] })
  unsubscribeAfterClose()
  await runtime.close()

  assert.equal(closeCount, 1)
  assert.equal(runtime.changeListeners.size, 0)
  assert.deepEqual(events, [])
})

test('requires a synchronous Realtime snapshot and closes once', async () => {
  let closed = 0
  const runtime = new FrontendMemoryRuntime({
    provider: provider({
      list: () => Promise.resolve([]),
      close: async () => { closed += 1 },
    }),
  })
  assert.throws(() => runtime.list('owner'), /synchronous Realtime snapshot/)
  await runtime.close()
  await runtime.close()
  assert.equal(closed, 1)
})

test('normalizes provider health and rejects malformed writes', async () => {
  const runtime = new FrontendMemoryRuntime({
    provider: provider({
      health: () => ({ ok: false, warning: 'offline' }),
      apply: async () => null,
    }),
  })
  assert.deepEqual(runtime.health(), {
    ok: false,
    warning: 'offline',
    configured: true,
    provider: {
      protocolVersion: 1,
      key: 'fixture',
      label: 'Fixture Memory',
      capabilities: {
        semanticQuery: false,
        sessionObservation: false,
        audioStreamObservation: false,
      },
    },
  })
  await assert.rejects(() => runtime.apply('owner', []), /changed and documents/)
})

test('routes semantic query and provider-owned session observation', async () => {
  const calls = []
  const runtime = new FrontendMemoryRuntime({
    provider: provider({
      describe: () => ({
        protocolVersion: 2,
        key: 'semantic',
        label: 'Semantic Memory',
        capabilities: { semanticQuery: true, sessionObservation: true },
      }),
      query: async (...args) => {
        calls.push(['query', ...args])
        return { context: 'related memory', memories: [] }
      },
      observe: async (...args) => { calls.push(['observe', ...args]) },
      flush: async (...args) => { calls.push(['flush', ...args]) },
    }),
  })
  assert.equal(runtime.ownsSessionObservation(), true)
  assert.equal((await runtime.query('owner', 'tea')).context, 'related memory')
  assert.equal((await runtime.observe('owner', { messages: [] })).observed, true)
  assert.deepEqual(await runtime.flush('owner'), { flushed: true })
  assert.deepEqual(calls.map(call => call[0]), ['query', 'observe', 'flush'])
})

test('routes synchronous audio stream observations without awaiting the provider', () => {
  const calls = []
  const runtime = new FrontendMemoryRuntime({
    provider: provider({
      describe: () => ({
        protocolVersion: 2,
        key: 'audio-memory',
        label: 'Audio Memory',
        capabilities: {
          audioStreamObservation: true,
          sessionObservation: true,
        },
      }),
      observe: async () => ({}),
      observeAudio(ownerId, event, context) {
        calls.push({ ownerId, event, context })
      },
    }),
  })

  assert.deepEqual(runtime.observeAudio(
    'owner',
    { type: 'chunk', audio: 'AA==' },
    { sessionId: 'session' },
  ), { observed: true })
  assert.equal(calls.length, 1)
  runtime.provider.observeAudio = async () => {}
  assert.throws(
    () => runtime.observeAudio('owner', { type: 'chunk' }),
    /must be synchronous/,
  )
})
