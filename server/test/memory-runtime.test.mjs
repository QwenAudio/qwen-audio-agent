import assert from 'node:assert/strict'
import test from 'node:test'
import { FrontendMemoryRuntime } from '../src/conversation/memory-runtime.mjs'

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
  const runtime = new FrontendMemoryRuntime({
    provider: provider({
      apply: async (ownerId, changes, context) => {
        received = { ownerId, changes, context }
        return { changed: 1, documents: [{ scope: 'memory', content: 'fact' }] }
      },
    }),
  })
  const changes = [{ document: 'memory', append: '- fact' }]
  const context = { source: 'realtime-tool', sessionId: 'session-private' }
  const result = await runtime.apply('owner-private', changes, context)
  assert.deepEqual(received, { ownerId: 'owner-private', changes, context })
  assert.equal(result.changed, 1)
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
