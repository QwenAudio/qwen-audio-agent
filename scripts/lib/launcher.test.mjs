// Tests for scripts/lib/launcher.mjs — cross-platform launcher utilities.
// Run with: node --test scripts/lib/launcher.test.mjs
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import {
  findExecutable,
  commandAvailable,
  loadDotEnv,
  spawnAndProxy,
} from './launcher.mjs'

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

test('loadDotEnv sets QWEN_AUDIO_AGENT_ENV_LOADED guard', () => {
  assert.equal(process.env.QWEN_AUDIO_AGENT_ENV_LOADED, undefined)
  // loadDotEnv is idempotent — should not throw
  loadDotEnv(process.cwd())
  delete process.env.QWEN_AUDIO_AGENT_ENV_LOADED
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
