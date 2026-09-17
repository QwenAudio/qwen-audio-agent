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

test('requires an explicit clientDir instead of defaulting to Gateway storage', () => {
  assert.throws(() => createSettingsStore({ configDir: '/gateway' }), /clientDir/)
})

test('reading never creates the config directory', t => {
  const root = temporaryRoot(t)
  const store = createSettingsStore({
    configDir: join(root, 'never-created'),
    clientDir: join(root, 'client'),
    env: {},
  })
  assert.equal(store.ready(), false)
  assert.deepEqual(store.loadUiState(), {})
  assert.throws(() => statSync(join(root, 'never-created')), /ENOENT/)
})

test('save persists 0600, applies the environment, and satisfies the gate', t => {
  const root = temporaryRoot(t)
  const env = {}
  const store = createSettingsStore({ configDir: join(root, 'data'), clientDir: join(root, 'client'), env })

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
  const store = createSettingsStore({ configDir: join(root, 'data'), clientDir: join(root, 'client'), env: {} })
  store.save({ dashscopeApiKey: 'sk-stored' })
  // A second store over the same directory sees the stored credential even
  // with an empty environment — how a host process asks after a restart.
  const reread = createSettingsStore({ configDir: join(root, 'data'), clientDir: join(root, 'client'), env: {} })
  assert.equal(reread.ready(), true)
})

test('ui state merges patches and survives corruption', t => {
  const root = temporaryRoot(t)
  const store = createSettingsStore({ configDir: join(root, 'data'), clientDir: join(root, 'client'), env: {} })
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
  const store = createSettingsStore({ configDir: join(root, 'data'), clientDir: join(root, 'client'), env: {} })
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
  const first = createSettingsStore({ configDir: directory, clientDir: join(root, 'client'), env: {} })
  const initial = first.conversationSession.load()
  assert.match(initial, /^[0-9a-f-]{36}$/)
  assert.equal(first.conversationSession.load(), initial)

  const restarted = createSettingsStore({ configDir: directory, clientDir: join(root, 'client'), env: {} })
  assert.equal(restarted.conversationSession.load(), initial)
  assert.equal(restarted.conversationSession.save('next-session'), 'next-session')
  assert.equal(first.conversationSession.load(), 'next-session')
  assert.throws(
    () => first.conversationSession.save('bad\nsession'),
    /invalid/,
  )
})

test('Gateway configuration and client state use separately named directories', t => {
  const root = temporaryRoot(t)
  const store = createSettingsStore({
    configDir: join(root, 'shared'),
    clientDir: join(root, 'client'),
    env: {},
  })
  // The Gateway configuration never owns the client's UI state.
  assert.equal(store.path, join(root, 'shared', 'config.env'))
  assert.equal(store.uiStatePath, join(root, 'client', 'ui-state.json'))
  store.save({ dashscopeApiKey: 'sk-test' })
  store.saveUiState({ theme: 'dark' })
  assert.ok(existsSync(join(root, 'shared', 'config.env')))
  assert.ok(existsSync(join(root, 'client', 'ui-state.json')))
  assert.equal(existsSync(join(root, 'shared', 'ui-state.json')), false)
  assert.equal(existsSync(join(root, 'client', 'config.env')), false)
})

test('the unified form persists Gateway settings and desktop preferences separately', t => {
  const root = temporaryRoot(t)
  const options = { configDir: join(root, 'gateway'), clientDir: join(root, 'desktop'), env: {} }
  const store = createSettingsStore(options)
  const saved = store.save({
    dashscopeApiKey: 'sk-local', gatewayUrl: 'https://gateway.example',
    orbSkin: 'goo', language: 'en', wakeWordEnabled: true,
    autoHideSeconds: 300, wakeShortcut: 'CommandOrControl+Shift+Space',
  })
  const gateway = readFileSync(store.path, 'utf8')
  const client = readFileSync(store.clientSettingsPath, 'utf8')
  assert.match(gateway, /DASHSCOPE_API_KEY=sk-local/)
  assert.doesNotMatch(gateway, /ORB_|DESKTOP_|WAKE_|QWEN_AUDIO_AGENT_URL/)
  assert.doesNotMatch(client, /DASHSCOPE|AGENT_PROTOCOL/)
  assert.match(client, /QWEN_AUDIO_WAKE_WORD_ENABLED=true/)
  assert.match(client, /QWEN_AUDIO_AGENT_URL=https:\/\/gateway.example/)
  assert.deepEqual(createSettingsStore({ ...options, env: {} }).load(), saved)
  if (process.platform !== 'win32') {
    assert.equal(statSync(store.clientSettingsPath).mode & 0o777, 0o600)
  }

  // Changing client preferences must not rewrite the Gateway file or reset
  // other preferences. Conversely, a Gateway update must not rewrite client data.
  const gatewayMtime = statSync(store.path).mtimeMs
  store.save({ language: 'zh-CN' })
  assert.equal(statSync(store.path).mtimeMs, gatewayMtime)
  assert.equal(store.load().autoHideSeconds, 300)
  const clientMtime = statSync(store.clientSettingsPath).mtimeMs
  store.save({ dashscopeApiKey: 'sk-updated' })
  assert.equal(statSync(store.clientSettingsPath).mtimeMs, clientMtime)
  assert.equal(store.load().language, 'zh-CN')
})

test('desktop clients sharing a Gateway keep independent preferences and identities', t => {
  const root = temporaryRoot(t)
  const configDir = join(root, 'gateway')
  const first = createSettingsStore({ configDir, clientDir: join(root, 'first'), env: {} })
  const second = createSettingsStore({ configDir, clientDir: join(root, 'second'), env: {} })
  first.save({ dashscopeApiKey: 'sk-shared', language: 'en', orbSkin: 'goo' })
  assert.equal(second.load().dashscopeApiKey, 'sk-shared')
  assert.equal(second.load().language, 'auto')
  assert.equal(second.load().orbSkin, 'fluid')
  assert.notEqual(first.gatewayClientInstance.load(), second.gatewayClientInstance.load())
  assert.notEqual(first.conversationSession.load(), second.conversationSession.load())
})

test('preview validates without persisting either settings file', t => {
  const root = temporaryRoot(t)
  const store = createSettingsStore({ configDir: join(root, 'gateway'), clientDir: join(root, 'desktop'), env: {} })
  assert.equal(store.preview({ language: 'en' }).language, 'en')
  assert.equal(existsSync(store.path), false)
  assert.equal(existsSync(store.clientSettingsPath), false)
  assert.throws(() => store.save({ gatewayUrl: 'file:///bad' }))
  assert.equal(existsSync(store.path), false)
  assert.equal(existsSync(store.clientSettingsPath), false)
})
