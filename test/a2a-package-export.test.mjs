import assert from 'node:assert/strict'
import test from 'node:test'
import {
  A2A_BACKEND_ADAPTER_VERSION,
  createA2ABackendAdapter,
} from 'qwen-audio-agent/a2a-backend-adapter'

test('exports one stable optional A2A Backend Adapter entry point', () => {
  assert.equal(A2A_BACKEND_ADAPTER_VERSION, '1.0.0')
  assert.equal(typeof createA2ABackendAdapter, 'function')
})
