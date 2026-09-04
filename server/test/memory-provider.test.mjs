import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MEMORY_PROVIDER_PROTOCOL_VERSION,
  assertMemoryProvider,
  describeMemoryProvider,
  normalizeMemoryProviderHealth,
} from '../src/conversation/memory-provider.mjs'

function provider(overrides = {}) {
  return {
    describe: () => ({
      protocolVersion: MEMORY_PROVIDER_PROTOCOL_VERSION,
      key: 'custom-memory',
      label: 'Custom Memory',
    }),
    list: () => [],
    apply: async () => ({ changed: 0, documents: [] }),
    ...overrides,
  }
}

test('validates one versioned provider-neutral memory contract', () => {
  assert.throws(
    () => assertMemoryProvider({ describe: () => ({}) }),
    /list, apply/,
  )
  assert.throws(
    () => assertMemoryProvider(provider({
      describe: () => ({ protocolVersion: 3, key: 'future', label: 'Future' }),
    })),
    /protocol version/,
  )
  assert.throws(
    () => assertMemoryProvider(provider({ close: true })),
    /close must be a function/,
  )
  const fixture = provider()
  assert.equal(assertMemoryProvider(fixture), fixture)
  assert.deepEqual(describeMemoryProvider(fixture), {
    protocolVersion: MEMORY_PROVIDER_PROTOCOL_VERSION,
    key: 'custom-memory',
    label: 'Custom Memory',
    capabilities: {
      semanticQuery: false,
      sessionObservation: false,
      audioStreamObservation: false,
    },
  })
  assert.deepEqual(normalizeMemoryProviderHealth({ ok: false, warning: 'offline' }), {
    ok: false,
    warning: 'offline',
  })
})

test('validates advertised v2 capabilities without imposing vendor concepts', () => {
  assert.deepEqual(describeMemoryProvider(provider({
    describe: () => ({
      protocolVersion: 1,
      key: 'legacy',
      label: 'Legacy',
      capabilities: { semanticQuery: true, sessionObservation: true },
    }),
  })).capabilities, {
    semanticQuery: false,
    sessionObservation: false,
    audioStreamObservation: false,
  })
  assert.throws(() => assertMemoryProvider(provider({
    describe: () => ({
      protocolVersion: 2,
      key: 'semantic',
      label: 'Semantic',
      capabilities: { semanticQuery: true },
    }),
  })), /no query method/)
  assert.throws(() => assertMemoryProvider(provider({
    describe: () => ({
      protocolVersion: 2,
      key: 'learning',
      label: 'Learning',
      capabilities: { sessionObservation: true },
    }),
  })), /no observe method/)
  assert.throws(() => assertMemoryProvider(provider({
    describe: () => ({
      protocolVersion: 2,
      key: 'audio',
      label: 'Audio',
      capabilities: { audioStreamObservation: true },
    }),
  })), /no observeAudio method/)
})
