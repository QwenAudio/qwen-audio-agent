import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  expandProcessPath,
  fallbackPathDirectories,
  loginShellPath,
  readPathCache,
  refreshProcessPath,
} from '../src/process-path.mjs'

function tempCacheFile() {
  const dir = mkdtempSync(join(tmpdir(), 'qwen-audio-path-'))
  const file = join(dir, 'login-shell-path.json')
  return { dir, file, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

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
    cacheFile: '',
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
    cacheFile: '',
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
    cacheFile: '',
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
      cacheFile: '',
      spawnImpl: () => ({ stdout: 'QWEN_AUDIO_AGENT_PATH<<</usr/bin>>>' }),
      existsImpl: () => true,
    }),
    false,
  )
})

test('applies the disk cache without running the login shell synchronously', () => {
  const { dir, file, cleanup } = tempCacheFile()
  try {
    writeFileSync(file, JSON.stringify({ path: '/cached/bin:/usr/bin' }), 'utf8')
    const env = { PATH: '/usr/bin', SHELL: '', HOME: '/Users/x' }
    let syncCalls = 0
    const expanded = expandProcessPath({
      env,
      platform: 'darwin',
      cacheFile: file,
      spawnImpl: () => {
        syncCalls += 1
        return { stdout: '' }
      },
      existsImpl: () => true,
    })
    assert.equal(expanded, true)
    assert.equal(env.PATH, '/usr/bin:/cached/bin')
    assert.equal(syncCalls, 0)
  } finally {
    cleanup()
  }
})

test('writes the login shell result to the cache on first launch', () => {
  const { file, cleanup } = tempCacheFile()
  try {
    const env = { PATH: '/usr/bin', SHELL: '/bin/zsh', HOME: '/Users/x' }
    expandProcessPath({
      env,
      platform: 'darwin',
      cacheFile: file,
      spawnImpl: () => ({
        stdout: 'QWEN_AUDIO_AGENT_PATH<<</fresh/bin:/usr/bin>>>',
      }),
      existsImpl: () => true,
    })
    assert.equal(
      JSON.parse(readFileSync(file, 'utf8')).path,
      '/fresh/bin:/usr/bin',
    )
  } finally {
    cleanup()
  }
})

test('refreshProcessPath re-reads the shell and updates the cache', () => {
  const { dir, file, cleanup } = tempCacheFile()
  try {
    writeFileSync(file, JSON.stringify({ path: '/old/bin' }), 'utf8')
    const env = { PATH: '/usr/bin', SHELL: '/bin/zsh', HOME: '/Users/x' }
    refreshProcessPath({
      env,
      platform: 'darwin',
      cacheFile: file,
      spawnImpl: () => ({
        stdout: 'QWEN_AUDIO_AGENT_PATH<<</new/bin:/usr/bin>>>',
      }),
      existsImpl: () => true,
    })
    assert.equal(env.PATH, '/usr/bin:/new/bin')
    assert.equal(
      JSON.parse(readFileSync(file, 'utf8')).path,
      '/new/bin:/usr/bin',
    )
  } finally {
    cleanup()
  }
})

test('refreshProcessPath falls back to the cache when the shell fails', () => {
  const { dir, file, cleanup } = tempCacheFile()
  try {
    writeFileSync(file, JSON.stringify({ path: '/cached/bin' }), 'utf8')
    const env = { PATH: '/usr/bin', SHELL: '/bin/zsh', HOME: '/Users/x' }
    refreshProcessPath({
      env,
      platform: 'darwin',
      cacheFile: file,
      spawnImpl: () => ({ stdout: 'no mark' }),
      existsImpl: () => true,
    })
    assert.equal(env.PATH, '/usr/bin:/cached/bin')
  } finally {
    cleanup()
  }
})

test('readPathCache tolerates a corrupted cache file', () => {
  const { dir, file, cleanup } = tempCacheFile()
  try {
    assert.equal(readPathCache(join(dir, 'missing.json')), '')
    writeFileSync(file, 'not json', 'utf8')
    assert.equal(readPathCache(file), '')
    writeFileSync(file, JSON.stringify({ path: 42 }), 'utf8')
    assert.equal(readPathCache(file), '')
  } finally {
    cleanup()
  }
})
