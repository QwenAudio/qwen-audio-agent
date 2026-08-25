import assert from 'node:assert/strict'
import test from 'node:test'
import {
  findFrontendSourceTool,
  frontendSourceToolCapabilities,
  frontendSourceToolDefinitions,
  frontendSourceTools,
} from '../src/frontend/tools/frontend-tool-source.mjs'

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
    'external-tool-approval',
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
