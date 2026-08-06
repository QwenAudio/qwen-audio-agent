// Tests that all 4 ACP backend drivers use the unified cross-platform
// launcher pattern: command = process.execPath, args = [scripts/*.mjs, ...],
// env = { ELECTRON_RUN_AS_NODE: '1' }.
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import test from 'node:test'
import { openCodeBackendDriver } from '../src/agent/backends/opencode.mjs'
import { openClawBackendDriver } from '../src/agent/backends/openclaw.mjs'
import { codexBackendDriver } from '../src/agent/backends/codex.mjs'
import { claudeBackendDriver } from '../src/agent/backends/claude.mjs'

function assertLauncherPattern(profile, root, scriptName) {
  assert.equal(profile.command, process.execPath,
    `command should be process.execPath for ${scriptName}`)
  assert.ok(profile.args.length >= 1,
    `args should contain at least the launcher script for ${scriptName}`)
  assert.equal(profile.args[0], resolve(root, `scripts/${scriptName}`),
    `args[0] should be scripts/${scriptName}`)
  if (profile.env) {
    assert.equal(profile.env.ELECTRON_RUN_AS_NODE, '1',
      `${scriptName} driver must inject ELECTRON_RUN_AS_NODE`)
  }
}

test('OpenCode driver uses process.execPath + opencode.mjs acp', () => {
  const profile = openCodeBackendDriver.createProfile({
    root: '/repo',
    baseUrl: 'http://127.0.0.1:4096',
    directory: '/work',
  })
  assertLauncherPattern(profile, '/repo', 'opencode.mjs')
  assert.ok(profile.args.includes('acp'),
    'args should contain "acp" subcommand')
})

test('OpenClaw driver uses process.execPath + openclaw.mjs acp', () => {
  const profile = openClawBackendDriver.createProfile({
    root: '/repo',
    baseUrl: 'http://127.0.0.1:18789',
    tokenFile: '/state/gateway-token',
    directory: '/work',
  })
  assertLauncherPattern(profile, '/repo', 'openclaw.mjs')
  assert.ok(profile.args.includes('acp'),
    'args should contain "acp" subcommand')
})

test('Codex driver uses process.execPath + codex-acp.mjs', () => {
  const profile = codexBackendDriver.createProfile({
    root: '/repo',
    baseUrl: null,
    directory: '/work',
    cliPath: '/opt/codex-acp',
  })
  assertLauncherPattern(profile, '/repo', 'codex-acp.mjs')
  assert.equal(profile.env.CODEX_ACP_BIN, '/opt/codex-acp')
})

test('Claude Code driver uses process.execPath + claude-code-acp.mjs', () => {
  const profile = claudeBackendDriver.createProfile({
    root: '/repo',
    baseUrl: null,
    directory: '/work',
  })
  assertLauncherPattern(profile, '/repo', 'claude-code-acp.mjs')
})
