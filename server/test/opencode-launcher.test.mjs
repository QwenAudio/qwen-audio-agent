import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

const launcher = readFileSync(
  resolve(import.meta.dirname, '../../scripts/opencode.mjs'),
  'utf8',
)
const serverWrapper = readFileSync(
  resolve(import.meta.dirname, '../../scripts/opencode-server.mjs'),
  'utf8',
)

test('isolates XDG_CONFIG_HOME when explicitly enabled or auto-managed', () => {
  assert.match(launcher, /QWEN_AUDIO_AGENT_OPENCODE_XDG_CONFIG_HOME/)
  assert.match(launcher, /runtime\/opencode-xdg/)
  assert.match(launcher, /QWEN_AUDIO_AGENT_OPENCODE_ISOLATE_USER_CONFIG/)
})

test('managed-backend wrapper delegates to opencode.mjs serve via process.execPath', () => {
  assert.match(serverWrapper, /scripts\/opencode\.mjs/)
  assert.match(serverWrapper, /process\.execPath/)
  assert.match(serverWrapper, /'serve'/)
})
