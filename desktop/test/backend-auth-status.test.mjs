import assert from 'node:assert/strict'
import test from 'node:test'

import { inspectBackendAuthentication } from '../../shared/backend-auth-status.mjs'

function result(output) {
  return async () => ({ ok: true, output })
}

test('detects authenticated OpenCode, OpenClaw, Qoder, and Codex setups', async () => {
  assert.equal((await inspectBackendAuthentication('opencode', {
    command: 'opencode',
    run: result('2 credentials'),
  })).status, 'authenticated')
  assert.equal((await inspectBackendAuthentication('openclaw', {
    command: 'openclaw',
    env: { HOME: '/home/user' },
    pathExists: path => path.endsWith('openclaw.json')
      || path.endsWith('models.json'),
  })).status, 'authenticated')
  assert.equal((await inspectBackendAuthentication('qoder', {
    command: 'qodercli',
    run: result('Username: user\nEmail: user@example.com'),
  })).status, 'authenticated')
  assert.equal((await inspectBackendAuthentication('codex', {
    command: 'codex',
    run: result('Logged in using ChatGPT'),
  })).status, 'authenticated')
})

test('keeps unsupported or inconclusive authentication probes unknown', async () => {
  assert.deepEqual(await inspectBackendAuthentication('kimi', {
    command: 'kimi',
    run: result(''),
  }), { status: 'unknown' })
  assert.equal((await inspectBackendAuthentication('claude', {
    command: 'claude',
    run: result('process terminated'),
  })).status, 'unknown')
})

test('detects explicit unauthenticated results without treating failures as proof', async () => {
  assert.equal((await inspectBackendAuthentication('opencode', {
    command: 'opencode',
    run: result('0 credentials'),
  })).status, 'unauthenticated')
  assert.equal((await inspectBackendAuthentication('codex', {
    command: 'codex',
    run: result('Not logged in'),
  })).status, 'unauthenticated')
})

test('never treats stale CodeBuddy credential files as proof of login', async () => {
  assert.equal((await inspectBackendAuthentication('codebuddy', {
    command: 'codebuddy',
    listCodeBuddyCredentials: async () => ['account.json'],
  })).status, 'unknown')
  assert.equal((await inspectBackendAuthentication('codebuddy', {
    command: 'codebuddy',
    listCodeBuddyCredentials: async () => [],
  })).status, 'unauthenticated')
})

test('detects an OpenClaw installation that has not been onboarded', async () => {
  assert.equal((await inspectBackendAuthentication('openclaw', {
    command: 'openclaw',
    env: { HOME: '/home/user' },
    pathExists: () => false,
  })).status, 'unauthenticated')
})
