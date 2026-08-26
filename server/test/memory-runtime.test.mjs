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
    },
  })
  await assert.rejects(() => runtime.apply('owner', []), /changed and documents/)
})
