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
  windowsPathDirectories,
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

// 当注册表和 where 都失败时，回退到预设目录
test('expands Windows PATH with preset directories when where fails', () => {
  const env = {
    PATH: 'C:\\Windows;C:\\Tools',
    ProgramFiles: 'D:\\Program Files',
    'ProgramFiles(x86)': 'D:\\Program Files (x86)',
    LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local',
    APPDATA: 'C:\\Users\\x\\AppData\\Roaming',
    USERPROFILE: 'C:\\Users\\x',
    NVM_HOME: 'D:\\nvm',
    NVM_SYMLINK: 'C:\\nodejs',
  }
  const existing = new Set([
    'D:\\Program Files\\nodejs',
    'D:\\Program Files (x86)\\nodejs',
    'C:\\Users\\x\\AppData\\Local\\Programs\\nodejs',
    'C:\\Users\\x\\AppData\\Roaming\\npm',
    'C:\\Users\\x\\.nvm',
    'D:\\nvm',
    'C:\\nodejs',
  ])
  assert.equal(
    expandProcessPath({
      env,
      platform: 'win32',
      spawnImpl: () => ({ status: 1, stdout: '' }),
      existsImpl: dir => existing.has(dir),
    }),
    true,
  )
  assert.equal(
    env.PATH,
    [
      'C:\\Windows',
      'C:\\Tools',
      'D:\\Program Files\\nodejs',
      'D:\\Program Files (x86)\\nodejs',
      'C:\\Users\\x\\AppData\\Local\\Programs\\nodejs',
      'C:\\Users\\x\\AppData\\Roaming\\npm',
      'C:\\Users\\x\\.nvm',
      'D:\\nvm',
      'C:\\nodejs',
    ].join(';'),
  )
})

test('Windows PATH expansion handles missing PATH and case-insensitive duplicates', () => {
  const env = {
    ProgramFiles: 'C:\\Program Files',
    APPDATA: 'C:\\Users\\x\\AppData\\Roaming',
  }
  expandProcessPath({
    env,
    platform: 'win32',
    spawnImpl: () => ({ status: 1, stdout: '' }),
    existsImpl: dir => dir === 'C:\\Program Files\\nodejs',
  })
  assert.equal(env.PATH, 'C:\\Program Files\\nodejs')

  env.PATH = 'c:\\program files\\NODEJS'
  assert.equal(
    expandProcessPath({
      env,
      platform: 'win32',
      spawnImpl: () => ({ status: 1, stdout: '' }),
      existsImpl: dir => dir.toLowerCase() === 'c:\\program files\\nodejs',
    }),
    false,
  )
  assert.equal(env.PATH, 'c:\\program files\\NODEJS')
})

test('refreshProcessPath on Windows falls back to preset when where fails', () => {
  const env = {
    PATH: 'C:\\Windows',
    LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local',
  }
  let installed = false
  const existsImpl = dir => installed
    && dir === 'C:\\Users\\x\\AppData\\Local\\Programs\\nodejs'

  assert.equal(
    refreshProcessPath({
      env, platform: 'win32',
      spawnImpl: () => ({ status: 1, stdout: '' }),
      existsImpl,
    }),
    false,
  )
  installed = true
  assert.equal(
    refreshProcessPath({
      env, platform: 'win32',
      spawnImpl: () => ({ status: 1, stdout: '' }),
      existsImpl,
    }),
    true,
  )
  assert.equal(
    env.PATH,
    'C:\\Windows;C:\\Users\\x\\AppData\\Local\\Programs\\nodejs',
  )
})

test('lists Windows paths with win32 semantics on any host', () => {
  assert.deepEqual(
    windowsPathDirectories({
      ProgramFiles: 'C:\\Program Files',
      'ProgramFiles(x86)': 'C:\\Program Files (x86)',
      LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local',
      APPDATA: 'C:\\Users\\x\\AppData\\Roaming',
      USERPROFILE: 'C:\\Users\\x',
    }),
    [
      'C:\\Program Files\\nodejs',
      'C:\\Program Files (x86)\\nodejs',
      'C:\\Users\\x\\AppData\\Local\\Programs\\nodejs',
      'C:\\Users\\x\\AppData\\Local\\nvm',
      'C:\\Users\\x\\AppData\\Roaming\\npm',
      'C:\\Users\\x\\AppData\\Roaming\\nvm',
      'C:\\Users\\x\\.nvm',
    ],
  )
})

// where 找到 node 和 npm 时，优先使用 where 结果而非预设目录
test('Windows PATH uses where result when registry and where succeed', () => {
  const env = {
    PATH: 'C:\\Windows',
    ProgramFiles: 'C:\\Program Files',
  }
  const spawnImpl = (cmd, args) => {
    if (cmd === 'reg') {
      // 模拟注册表中有 Scoop 安装的路径
      if (String(args).includes('HKLM')) {
        return { status: 0, stdout: '    Path    REG_EXPAND_SZ    %SystemRoot%\\system32;%SystemRoot%' }
      }
      return { status: 0, stdout: '    Path    REG_SZ    C:\\Users\\x\\scoop\\shims' }
    }
    if (cmd === 'cmd.exe' && Array.isArray(args) && args[2] === 'node') {
      return { status: 0, stdout: 'C:\\Users\\x\\scoop\\apps\\nodejs\\current\\node.exe' }
    }
    if (cmd === 'cmd.exe' && Array.isArray(args) && args[2] === 'npm') {
      return { status: 0, stdout: 'C:\\Users\\x\\scoop\\apps\\nodejs\\current\\npm.cmd' }
    }
    return { status: 1, stdout: '' }
  }
  expandProcessPath({
    env,
    platform: 'win32',
    spawnImpl,
    existsImpl: () => true,
  })
  assert.equal(
    env.PATH,
    'C:\\Windows;C:\\Users\\x\\scoop\\apps\\nodejs\\current',
  )
})

// where 找到 node 但 npm 和 node 不同目录时，两个目录都加入
test('Windows PATH adds both node and npm dirs when they differ', () => {
  const env = { PATH: 'C:\\Windows' }
  const spawnImpl = (cmd, args) => {
    if (cmd === 'reg') return { status: 1, stdout: '' }
    if (cmd === 'cmd.exe' && Array.isArray(args) && args[2] === 'node') {
      return { status: 0, stdout: 'D:\\tools\\node\\node.exe' }
    }
    if (cmd === 'cmd.exe' && Array.isArray(args) && args[2] === 'npm') {
      // npm 可能装在全局 npm 目录
      return { status: 0, stdout: 'C:\\Users\\x\\AppData\\Roaming\\npm\\npm.cmd' }
    }
    return { status: 1, stdout: '' }
  }
  expandProcessPath({
    env,
    platform: 'win32',
    spawnImpl,
    existsImpl: () => true,
  })
  assert.equal(
    env.PATH,
    'C:\\Windows;D:\\tools\\node;C:\\Users\\x\\AppData\\Roaming\\npm',
  )
})

test('does nothing when PATH is already complete', () => {
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
  const { file, cleanup } = tempCacheFile()
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
  const { file, cleanup } = tempCacheFile()
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
  const { file, cleanup } = tempCacheFile()
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
