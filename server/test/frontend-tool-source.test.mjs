import assert from 'node:assert/strict'
import test from 'node:test'
import {
  FRONTEND_TOOL_SOURCE_METHODS,
  assertFrontendToolSource,
  findFrontendSourceTool,
  frontendSourceToolCapabilities,
  frontendSourceToolDefinitions,
  frontendSourceTools,
} from '../src/frontend/tools/frontend-tool-source.mjs'

test('defines one protocol-neutral frontend tool source contract', () => {
  assert.deepEqual(FRONTEND_TOOL_SOURCE_METHODS, [
    'describe',
    'initialize',
    'tools',
    'execute',
    'health',
    'close',
  ])
  const value = {
    describe: () => ({ key: 'openapi', label: 'OpenAPI' }),
    initialize: async () => [],
    tools: () => [],
    execute: async () => ({}),
    health: () => ({ ok: true }),
    close: async () => {},
  }
  assert.equal(assertFrontendToolSource(value), value)
  assert.throws(
    () => assertFrontendToolSource({ ...value, execute: undefined }),
    /missing required methods: execute/,
  )
})

function source(name, policy) {
  const tool = {
    name,
    definition: {
      type: 'function',
      function: { name, parameters: { type: 'object' } },
    },
    policy,
  }
  return { tools: () => [tool], tool }
}

test('projects source tools, definitions, and approval capability', () => {
  const read = source('mcp__docs__search', {
    readOnly: true,
    approval: 'none',
  })
  const write = source('mcp__docs__create', {
    readOnly: false,
    approval: 'required',
  })
  const sources = [read, write]

  assert.deepEqual(
    frontendSourceTools(sources).map(entry => entry.tool.name),
    ['mcp__docs__search', 'mcp__docs__create'],
  )
  assert.deepEqual(
    frontendSourceToolDefinitions(sources),
    [read.tool.definition, write.tool.definition],
  )
  assert.deepEqual(frontendSourceToolCapabilities(sources), [
    'permission.respond',
  ])
  assert.equal(findFrontendSourceTool(sources, write.tool.name)?.tool, write.tool)
})

test('omits approval capability for read-only sources and rejects duplicates', () => {
  const first = source('mcp__docs__search', {
    readOnly: true,
    approval: 'none',
  })
  const duplicate = source('mcp__docs__search', {
    readOnly: false,
    approval: 'required',
  })

  assert.deepEqual(frontendSourceToolCapabilities([first]), [])
  assert.throws(
    () => frontendSourceTools([first, duplicate]),
    /duplicate frontend source tool/,
  )
})
