import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  BACKEND_TOOL_DEFINITIONS,
  FRONTEND_TOOL_DEFINITIONS,
} from '../tools/registry.mjs'

test('assigns weather to the foreground and all other cockpit tools to the backend', () => {
  assert.deepEqual(FRONTEND_TOOL_DEFINITIONS.map(tool => tool.name), ['weather'])
  assert.equal(BACKEND_TOOL_DEFINITIONS.length, 14)
  assert.ok(!BACKEND_TOOL_DEFINITIONS.some(tool => tool.name === 'weather'))
})

test('binds the cockpit frontend profile to the scoped MCP configuration', () => {
  const profile = JSON.parse(readFileSync(
    new URL('../frontend-profile.json', import.meta.url),
    'utf8',
  ))
  const config = JSON.parse(readFileSync(
    new URL('../tools/frontend-mcp.json', import.meta.url),
    'utf8',
  ))
  assert.equal(profile.toolSources.mcp, 'tools/frontend-mcp.json')
  assert.equal(config.servers.cockpit.url, '${COCKPIT_FRONTEND_MCP_URL}')
  assert.deepEqual(Object.keys(config.servers.cockpit.tools), ['weather'])
})
