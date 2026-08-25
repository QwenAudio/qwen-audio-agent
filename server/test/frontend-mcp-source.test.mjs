import assert from 'node:assert/strict'
import test from 'node:test'
import {
  FRONTEND_MCP_SOURCE_METHODS,
  assertFrontendMcpSource,
} from '../src/frontend/mcp/frontend-mcp-source.mjs'

function source(overrides = {}) {
  return {
    describe: () => ({ key: 'example', label: 'Example MCP' }),
    initialize: async () => [],
    tools: () => [],
    execute: async () => ({}),
    health: () => ({ ok: true }),
    close: async () => {},
    ...overrides,
  }
}

test('defines the complete provider-neutral frontend MCP source contract', () => {
  assert.deepEqual(FRONTEND_MCP_SOURCE_METHODS, [
    'describe',
    'initialize',
    'tools',
    'execute',
    'health',
    'close',
  ])
  const value = source()
  assert.equal(assertFrontendMcpSource(value), value)
})

test('rejects incomplete or invalid frontend MCP sources', () => {
  assert.throws(
    () => assertFrontendMcpSource(null),
    /must be an object/,
  )
  assert.throws(
    () => assertFrontendMcpSource(source({ execute: undefined })),
    /missing required methods: execute/,
  )
  assert.throws(
    () => assertFrontendMcpSource(source({
      describe: () => ({ key: 'Invalid Key', label: 'Example' }),
    })),
    /invalid identity/,
  )
})
