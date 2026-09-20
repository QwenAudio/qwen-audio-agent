// Tests for scripts/runtime/launcher.mjs — cross-platform launcher utilities.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import {
  findExecutable,
  commandAvailable,
  loadDotEnv,
  spawnAndProxy,
} from '../scripts/runtime/launcher.mjs'

// ── findExecutable ───────────────────────────────────────────────────────

test('findExecutable locates a command in PATH', () => {
  // node should always be findable
  const node = findExecutable('node', { env: process.env, platform: process.platform })
  assert.ok(node)
  assert.match(node, /node/)
})

test('findExecutable returns empty for a nonexistent command', () => {
  const result = findExecutable('__nonexistent_cmd_xyz__', {
    env: { PATH: '/usr/bin' },
    platform: 'darwin',
  })
  assert.equal(result, '')
})

test('findExecutable expands ~ on Unix', () => {
  // Create a temp HOME directory with a real executable file
  const homeDir = mkdtempSync(join(tmpdir(), 'launcher-test-home-'))
  const binDir = join(homeDir, 'bin')
  mkdirSync(binDir)
  const cmdPath = join(binDir, 'mycommand')
  writeFileSync(cmdPath, '', { mode: 0o755 })
  try {
    const result = findExecutable('~/bin/mycommand', {
      env: { PATH: '/usr/bin', HOME: homeDir },
      platform: 'darwin',
    })
    assert.ok(result, 'should find executable at ~/bin/mycommand')
    assert.ok(result.endsWith('bin/mycommand') || result.endsWith('bin\\mycommand'),
      `result should end with bin/mycommand, got ${result}`)
  } finally {
    rmSync(homeDir, { recursive: true, force: true })
  }
})

test('findExecutable searches PATHEXT on Windows', () => {
  // Create a temp directory with a .CMD file to test PATHEXT resolution
  const testDir = mkdtempSync(join(tmpdir(), 'launcher-test-pathtext-'))
  const cmdFile = join(testDir, 'npm.cmd')
  writeFileSync(cmdFile, '@echo off\r\nexit /b 0\r\n')
  try {
    const result = findExecutable('npm', {
      env: {
        PATH: testDir,
        PATHEXT: '.COM;.EXE;.BAT;.CMD',
      },
      platform: 'win32',
    })
    assert.ok(result, `should find npm via PATHEXT, got: "${result}"`)
    assert.ok(result.toLowerCase().endsWith('npm.cmd'),
      `result should end with npm.cmd, got ${result}`)
  } finally {
    rmSync(testDir, { recursive: true, force: true })
  }
})

// ── commandAvailable ─────────────────────────────────────────────────────

test('commandAvailable returns true for existing commands', () => {
  assert.equal(commandAvailable('node', { env: process.env, platform: process.platform }), true)
})

test('commandAvailable returns false for nonexistent commands', () => {
  assert.equal(
    commandAvailable('__nonexistent_cmd_xyz__', {
      env: { PATH: '/bin' },
      platform: 'darwin',
    }),
    false,
  )
})

// ── loadDotEnv ───────────────────────────────────────────────────────────

test('loadDotEnv loads a runtime env file once', () => {
  const directory = mkdtempSync(join(tmpdir(), 'launcher-test-env-'))
  const guard = process.env.QWEN_AUDIO_AGENT_ENV_LOADED
  const value = process.env.QWEN_AUDIO_AGENT_LAUNCHER_TEST_VALUE
  delete process.env.QWEN_AUDIO_AGENT_ENV_LOADED
  delete process.env.QWEN_AUDIO_AGENT_LAUNCHER_TEST_VALUE
  writeFileSync(
    join(directory, '.env'),
    'QWEN_AUDIO_AGENT_LAUNCHER_TEST_VALUE=loaded\n',
  )
  try {
    loadDotEnv(directory)
    assert.equal(process.env.QWEN_AUDIO_AGENT_ENV_LOADED, '1')
    assert.equal(process.env.QWEN_AUDIO_AGENT_LAUNCHER_TEST_VALUE, 'loaded')
  } finally {
    if (guard === undefined) delete process.env.QWEN_AUDIO_AGENT_ENV_LOADED
    else process.env.QWEN_AUDIO_AGENT_ENV_LOADED = guard
    if (value === undefined) delete process.env.QWEN_AUDIO_AGENT_LAUNCHER_TEST_VALUE
    else process.env.QWEN_AUDIO_AGENT_LAUNCHER_TEST_VALUE = value
    rmSync(directory, { recursive: true, force: true })
  }
})

// ── spawnAndProxy ────────────────────────────────────────────────────────

test('spawnAndProxy spawns a child and propagates exit code', async () => {
  const code = await spawnAndProxy('node', ['-e', 'process.exit(42)'])
  assert.equal(code, 42)
})

test('spawnAndProxy spawns a child with exit code 0', async () => {
  const code = await spawnAndProxy('node', ['-e', '0'])
  assert.equal(code, 0)
})

test('Windows quoted paths and arguments do not gain literal caret escapes', async () => {
  let actual
  const code = await spawnAndProxy('agent', ['a&b', 'say "hi & bye"', ''], {
    platform: 'win32', env: { ComSpec: 'cmd.exe' },
    find: () => 'C:\\Tools (x86)\\agent.cmd',
    spawnImpl: (command, args) => {
      actual = [command, ...args]
      const child = new EventEmitter()
      process.nextTick(() => child.emit('exit', 0))
      return child
    },
  })
  assert.equal(code, 0)
  assert.deepEqual(actual, ['cmd.exe', '/d', '/s', '/c',
    '""C:\\Tools (x86)\\agent.cmd" "a&b" "say \\"hi ^& bye\\"" """'])
})

test('Windows batch shims preserve special characters through a real cmd.exe', {
  skip: process.platform !== 'win32',
}, async t => {
  const root = mkdtempSync(join(tmpdir(), 'qwa-launcher-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const directory = join(root, '工具 Program Files (x86)')
  mkdirSync(directory)
  const output = join(root, 'args.json')
  writeFileSync(join(directory, 'agent.cjs'),
    `require('node:fs').writeFileSync(${JSON.stringify(output)}, JSON.stringify(process.argv.slice(2)))`)
  const command = join(directory, 'agent.cmd')
  writeFileSync(command, `@"${process.execPath}" "%~dp0agent.cjs" %*\r\n`)
  const args = ['--config', join(root, 'R&D (2026)', '文件.yml'), 'a&b', 'x|y', 'a^b', '', 'trailing\\']
  assert.equal(await spawnAndProxy(command, args, { inheritStdio: false }), 0)
  assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), args)
})
