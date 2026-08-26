import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createSettingsStore, SETTINGS_FILE, UI_STATE_FILE } from '../src/settings-store.mjs'

function temporaryRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'qwaudio-store-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

test('requires an explicit configDir', () => {
  assert.throws(() => createSettingsStore({}), error => {
    assert.equal(error.code, 'QWAUDIO_GATEWAY_CONFIG_DIR_REQUIRED')
    return true
  })
})

test('reading never creates the config directory', t => {
  const root = temporaryRoot(t)
  const store = createSettingsStore({
    configDir: join(root, 'never-created'),
    env: {},
  })
  assert.equal(store.ready(), false)
  assert.deepEqual(store.loadUiState(), {})
  assert.throws(() => statSync(join(root, 'never-created')), /ENOENT/)
})

test('save persists 0600, applies the environment, and satisfies the gate', t => {
  const root = temporaryRoot(t)
  const env = {}
  const store = createSettingsStore({ configDir: join(root, 'data'), env })

  assert.equal(store.status().ready, false)
  assert.equal(store.status().missing[0].key, 'DASHSCOPE_API_KEY')

  const saved = store.save({ dashscopeApiKey: 'sk-host' })
  assert.equal(saved.dashscopeApiKey, 'sk-host')
  // The same truth the startup gate reads.
  assert.equal(store.ready(), true)
  // An in-process restart must observe what was just written.
  assert.equal(env.DASHSCOPE_API_KEY, 'sk-host')
  // Windows has no POSIX permission bits; the private mode is only
  // assertable where chmod means something.
  if (process.platform !== 'win32') {
    const mode = statSync(store.path).mode & 0o777
    assert.equal(mode, 0o600)
  }
  assert.match(readFileSync(store.path, 'utf8'), /DASHSCOPE_API_KEY=sk-host/)
  assert.ok(store.path.endsWith(SETTINGS_FILE))
})

test('the stored file outweighs nothing but the live environment', t => {
  const root = temporaryRoot(t)
  const store = createSettingsStore({ configDir: join(root, 'data'), env: {} })
  store.save({ dashscopeApiKey: 'sk-stored' })
  // A second store over the same directory sees the stored credential even
  // with an empty environment — how a host process asks after a restart.
  const reread = createSettingsStore({ configDir: join(root, 'data'), env: {} })
  assert.equal(reread.ready(), true)
})

test('ui state merges patches and survives corruption', t => {
  const root = temporaryRoot(t)
  const store = createSettingsStore({ configDir: join(root, 'data'), env: {} })
  store.saveUiState({ a: 1 })
  const merged = store.saveUiState({ b: 2 })
  assert.deepEqual(merged, { a: 1, b: 2 })
  assert.ok(store.uiStatePath.endsWith(UI_STATE_FILE))
  if (process.platform !== 'win32') {
    const mode = statSync(store.uiStatePath).mode & 0o777
    assert.equal(mode, 0o600)
  }

  chmodSync(store.uiStatePath, 0o600)
  writeFileSync(store.uiStatePath, 'not json')
  assert.deepEqual(store.loadUiState(), {})
})

test('orbPosition matches the placement storage contract', t => {
  const root = temporaryRoot(t)
  const store = createSettingsStore({ configDir: join(root, 'data'), env: {} })
  assert.equal(store.orbPosition.load(), null)
  store.orbPosition.save({ x: 12, y: 34, displayId: 1 })
  assert.deepEqual(store.orbPosition.load(), { x: 12, y: 34, displayId: 1 })
  // Position writes must not clobber unrelated ui state.
  store.saveUiState({ theme: 'dark' })
  store.orbPosition.save({ x: 56, y: 78, displayId: 2 })
  assert.equal(store.loadUiState().theme, 'dark')
})

test('conversation session survives restart and changes only when explicitly replaced', t => {
  const root = temporaryRoot(t)
  const directory = join(root, 'data')
  const first = createSettingsStore({ configDir: directory, env: {} })
  const initial = first.conversationSession.load()
  assert.match(initial, /^[0-9a-f-]{36}$/)
  assert.equal(first.conversationSession.load(), initial)

  const restarted = createSettingsStore({ configDir: directory, env: {} })
  assert.equal(restarted.conversationSession.load(), initial)
  assert.equal(restarted.conversationSession.save('next-session'), 'next-session')
  assert.equal(first.conversationSession.load(), 'next-session')
  assert.throws(
    () => first.conversationSession.save('bad\nsession'),
    /invalid/,
  )
})

test('splits ui state into its own directory when uiStateDir is given', t => {
  const root = temporaryRoot(t)
  const store = createSettingsStore({
    configDir: join(root, 'shared'),
    uiStateDir: join(root, 'runtime'),
    env: {},
  })
  // 设置留在共享资产目录，窗口状态留在桌面运行时目录。
  assert.equal(store.path, join(root, 'shared', 'config.env'))
  assert.equal(store.uiStatePath, join(root, 'runtime', 'ui-state.json'))
  store.save({ dashscopeApiKey: 'sk-test' })
  store.saveUiState({ theme: 'dark' })
  assert.ok(existsSync(join(root, 'shared', 'config.env')))
  assert.ok(existsSync(join(root, 'runtime', 'ui-state.json')))
  assert.equal(existsSync(join(root, 'shared', 'ui-state.json')), false)
  assert.equal(existsSync(join(root, 'runtime', 'config.env')), false)
})
