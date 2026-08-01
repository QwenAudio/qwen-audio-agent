import assert from 'node:assert/strict'
import test from 'node:test'
import {
  expandProcessPath,
  fallbackPathDirectories,
  loginShellPath,
} from '../src/process-path.mjs'

test('extracts PATH from login shell output with rc noise', () => {
  const path = loginShellPath({
    shell: '/bin/zsh',
    spawnImpl: () => ({
      stdout: 'some rc banner\nQWEN_AUDIO_AGENT_PATH<<</Users/x/.nvm/bin:/usr/bin>>>\n',
    }),
  })
  assert.equal(path, '/Users/x/.nvm/bin:/usr/bin')
})

test('returns empty when the shell is missing or the mark is absent', () => {
  assert.equal(loginShellPath({ shell: '' }), '')
  assert.equal(
    loginShellPath({
      shell: '/bin/zsh',
      spawnImpl: () => ({ stdout: 'no mark here' }),
    }),
    '',
  )
  assert.equal(
    loginShellPath({
      shell: '/bin/zsh',
      spawnImpl: () => {
        throw new Error('timeout')
      },
    }),
    '',
  )
})

test('expands process PATH with login shell directories', () => {
  const env = {
    PATH: '/usr/bin:/bin',
    SHELL: '/bin/zsh',
    HOME: '/Users/x',
  }
  const expanded = expandProcessPath({
    env,
    platform: 'darwin',
    spawnImpl: () => ({
      stdout: 'QWEN_AUDIO_AGENT_PATH<<</Users/x/.kimi-code/bin:/usr/bin:/Users/x/.nvm/bin>>>',
    }),
    existsImpl: () => true,
  })
  assert.equal(expanded, true)
  assert.equal(
    env.PATH,
    '/usr/bin:/bin:/Users/x/.kimi-code/bin:/Users/x/.nvm/bin',
  )
})

test('skips duplicates and directories that do not exist', () => {
  const env = { PATH: '/usr/bin', SHELL: '/bin/zsh', HOME: '/Users/x' }
  expandProcessPath({
    env,
    platform: 'darwin',
    spawnImpl: () => ({
      stdout: 'QWEN_AUDIO_AGENT_PATH<<</usr/bin:/missing:/tools/bin>>>',
    }),
    existsImpl: dir => dir !== '/missing',
  })
  assert.equal(env.PATH, '/usr/bin:/tools/bin')
})

test('falls back to well-known directories without a login shell', () => {
  const env = { PATH: '/usr/bin', HOME: '/Users/x' }
  const expanded = expandProcessPath({
    env,
    platform: 'linux',
    spawnImpl: () => {
      throw new Error('no shell')
    },
    existsImpl: dir => dir === '/opt/homebrew/bin',
  })
  assert.equal(expanded, true)
  assert.equal(env.PATH, '/usr/bin:/opt/homebrew/bin')
  assert.deepEqual(fallbackPathDirectories('/Users/x'), [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/Users/x/.local/bin',
  ])
})

test('does nothing on Windows or when PATH is already complete', () => {
  const env = { PATH: 'C:\\Windows' }
  assert.equal(expandProcessPath({ env, platform: 'win32' }), false)
  assert.equal(env.PATH, 'C:\\Windows')

  const complete = { PATH: '/usr/bin', SHELL: '/bin/zsh' }
  assert.equal(
    expandProcessPath({
      env: complete,
      platform: 'darwin',
      spawnImpl: () => ({ stdout: 'QWEN_AUDIO_AGENT_PATH<<</usr/bin>>>' }),
      existsImpl: () => true,
    }),
    false,
  )
})
