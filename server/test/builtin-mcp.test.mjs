import test from 'node:test'
import assert from 'node:assert/strict'
import {
  builtinMcpServers,
  computerUseMcpServer,
} from '../src/agent/builtin-mcp.mjs'

test('computer-use MCP server resolves as stdio descriptor by default', () => {
  const descriptor = computerUseMcpServer({})
  assert.ok(descriptor, 'expected descriptor when package is installed')
  assert.equal(descriptor.name, 'open-computer-use')
  assert.equal(descriptor.command, process.execPath)
  assert.equal(descriptor.args.length, 2)
  assert.match(descriptor.args[0], /open-computer-use/)
  assert.equal(descriptor.args[1], 'mcp')
  assert.deepEqual(descriptor.env, [
    { name: 'ELECTRON_RUN_AS_NODE', value: '1' },
  ])
})

test('computer-use MCP server can be disabled via environment', () => {
  for (const value of ['false', 'off', '0', 'no', 'disabled', 'OFF']) {
    assert.equal(
      computerUseMcpServer({ QWEN_AUDIO_AGENT_COMPUTER_USE: value }),
      null,
      `expected null for ${value}`,
    )
  }
})

test('computer-use MCP server stays enabled for truthy values', () => {
  for (const value of ['', 'true', 'on', '1', 'yes']) {
    assert.ok(
      computerUseMcpServer({ QWEN_AUDIO_AGENT_COMPUTER_USE: value }),
      `expected descriptor for "${value}"`,
    )
  }
})

test('builtinMcpServers returns descriptor list and filters disabled entries', () => {
  const enabled = builtinMcpServers({})
  assert.equal(enabled.length, 1)
  assert.equal(enabled[0].name, 'open-computer-use')

  const disabled = builtinMcpServers({ QWEN_AUDIO_AGENT_COMPUTER_USE: 'off' })
  assert.deepEqual(disabled, [])
})
