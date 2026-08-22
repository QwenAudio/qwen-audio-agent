import assert from 'node:assert/strict'
import { join } from 'node:path'
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
  assert.equal((await inspectBackendAuthentication('qoder', {
    command: 'qodercli',
    run: result('Version: 1.1.24\nAccount: user@example.com'),
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
  assert.equal((await inspectBackendAuthentication('qoder', {
    command: 'qodercli',
    run: result('Version: 1.1.24\nAccount: Not logged in'),
  })).status, 'unauthenticated')
})

test('detects Qwen Code credentials without exposing their values', async () => {
  assert.equal((await inspectBackendAuthentication('qwen', {
    env: { HOME: '/home/user' },
    readCredentialFile: async path => {
      assert.equal(path, join('/home/user', '.qwen', 'settings.json'))
      return JSON.stringify({ env: { DASHSCOPE_API_KEY: 'test-key' } })
    },
  })).status, 'authenticated')
  assert.equal((await inspectBackendAuthentication('qwen', {
    env: { HOME: '/home/user' },
    readCredentialFile: async () => JSON.stringify({
      security: { auth: { selectedType: 'oauth' } },
    }),
  })).status, 'unknown')
})

test('uses Pi official no-refresh auth check for its configured provider', async () => {
  let observed
  assert.equal((await inspectBackendAuthentication('pi', {
    command: '/usr/local/bin/pi',
    env: { HOME: '/home/user' },
    readCredentialFile: async path => {
      assert.equal(path, join('/home/user', '.pi', 'agent', 'settings.json'))
      return JSON.stringify({
        defaultProvider: 'deepseek',
        defaultModel: 'deepseek-chat',
      })
    },
    run: async (command, args) => {
      observed = { command, args }
      return { ok: true, output: '{"status":"ready"}' }
    },
  })).status, 'authenticated')
  assert.deepEqual(observed, {
    command: '/usr/local/bin/pi',
    args: [
      'auth', 'check', '--provider', 'deepseek',
      '--no-refresh', '--json',
    ],
  })
})

test('detects DeepSeek Harness API-key configuration', async () => {
  assert.equal((await inspectBackendAuthentication('deepseek', {
    env: { DEEPSEEK_API_KEY: 'test-key' },
  })).status, 'authenticated')
  assert.equal((await inspectBackendAuthentication('deepseek', {
    env: { HOME: '/home/user' },
    readCredentialFile: async path => {
      assert.equal(path, join('/home/user', '.dsh', '.credentials.yaml'))
      return 'DEEPSEEK_API_KEY: sk-stored\n'
    },
  })).status, 'authenticated')
  assert.equal((await inspectBackendAuthentication('deepseek', {
    env: { DSH_HOME: '/custom/dsh' },
    readCredentialFile: async path => {
      assert.equal(path, join('/custom/dsh', '.credentials.yaml'))
      throw new Error('missing')
    },
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

test('passes the requested platform into command probes', async () => {
  let observed
  await inspectBackendAuthentication('codex', {
    command: 'codex',
    env: { PATH: 'C:\\Node' },
    platform: 'win32',
    run: async (_command, _args, options) => {
      observed = options
      return { ok: true, output: 'Logged in' }
    },
  })
  assert.equal(observed.platform, 'win32')
  assert.equal(observed.env.PATH, 'C:\\Node')
})
