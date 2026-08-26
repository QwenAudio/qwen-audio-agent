import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MEMORY_PROVIDER_PROTOCOL_VERSION,
  assertMemoryProvider,
  describeMemoryProvider,
  normalizeMemoryProviderHealth,
} from 'qwen-audio-agent/memory-provider'

test('exports one stable optional Memory Provider contract', () => {
  assert.equal(MEMORY_PROVIDER_PROTOCOL_VERSION, 1)
  assert.equal(typeof assertMemoryProvider, 'function')
  assert.equal(typeof describeMemoryProvider, 'function')
  assert.equal(typeof normalizeMemoryProviderHealth, 'function')
})
