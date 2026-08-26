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
      describe: () => ({ protocolVersion: 2, key: 'future', label: 'Future' }),
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
    protocolVersion: 1,
    key: 'custom-memory',
    label: 'Custom Memory',
  })
  assert.deepEqual(normalizeMemoryProviderHealth({ ok: false, warning: 'offline' }), {
    ok: false,
    warning: 'offline',
  })
})
