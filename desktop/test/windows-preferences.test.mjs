import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyOpenAtLogin,
  DEFAULT_WINDOWS_PREFERENCES,
  readOpenAtLogin,
  validateWindowsPreferences,
  WindowsPreferencesStore,
} from '../src/windows-preferences.mjs'

test('validates only the six Windows preference keys', () => {
  const valid = validateWindowsPreferences({
    mode: 'external',
    distribution: 'Ubuntu Dev',
    externalGatewayOrigin: 'http://localhost:3101',
    openAtLogin: true,
    orbVisible: false,
    windowBounds: {
      orb: { x: 10, y: 20, width: 172, height: 170 },
      settings: null,
      repair: null,
    },
  })
  assert.deepEqual(Object.keys(valid).sort(), [
    'distribution',
    'externalGatewayOrigin',
    'mode',
    'openAtLogin',
    'orbVisible',
    'windowBounds',
  ])
  assert.throws(() => validateWindowsPreferences({
    ...valid,
    sessionToken: 'must-not-persist',
  }), /unknown preference/i)
  assert.throws(() => validateWindowsPreferences({
    ...valid,
    distribution: ' Ubuntu',
  }), /distribution/i)
  assert.throws(() => validateWindowsPreferences({
    ...valid,
    externalGatewayOrigin: 'http://192.168.1.2:3101',
  }), /loopback/i)
})

test('defaults to managed auto-distribution startup-off orb-visible preferences', () => {
  assert.deepEqual(DEFAULT_WINDOWS_PREFERENCES, {
    mode: 'managed',
    distribution: '',
    externalGatewayOrigin: '',
    openAtLogin: false,
    orbVisible: true,
    windowBounds: { orb: null, settings: null, repair: null },
  })
})

function memoryStore({ initial = null } = {}) {
  const path = 'C:\\Users\\tester\\AppData\\Roaming\\Qwen Audio Agent\\windows-preferences.json'
  const files = new Map(initial === null ? [] : [[path, initial]])
  const writes = []
  const renames = []
  const logs = []
  const store = new WindowsPreferencesStore({
    app: { getPath: name => {
      assert.equal(name, 'userData')
      return 'C:\\Users\\tester\\AppData\\Roaming\\Qwen Audio Agent'
    } },
    resolvePath: (...parts) => parts.join('\\'),
    async readFile(target) {
      if (!files.has(target)) {
        const error = new Error('missing')
        error.code = 'ENOENT'
        throw error
      }
      return files.get(target)
    },
    async writeFileAtomic(target, value, options) {
      writes.push({ target, value, options })
      files.set(target, value)
    },
    async rename(source, destination) {
      renames.push({ source, destination })
      files.set(destination, files.get(source))
      files.delete(source)
    },
    now: () => Date.parse('2026-08-03T09:00:00.000Z'),
    logger: { warn: value => logs.push(value) },
  })
  return { files, logs, path, renames, store, writes }
}

test('atomically stores only validated preferences with private permissions', async () => {
  const target = memoryStore()
  assert.deepEqual(await target.store.read(), DEFAULT_WINDOWS_PREFERENCES)
  const saved = await target.store.write({
    distribution: 'Ubuntu',
    openAtLogin: true,
  })
  assert.equal(saved.distribution, 'Ubuntu')
  assert.equal(saved.openAtLogin, true)
  assert.equal(target.writes.length, 1)
  assert.deepEqual(target.writes[0].options, { mode: 0o600 })
  assert.deepEqual(
    Object.keys(JSON.parse(target.writes[0].value)).sort(),
    Object.keys(DEFAULT_WINDOWS_PREFERENCES).sort(),
  )
  await assert.rejects(
    target.store.write({ token: 'must-not-persist' }),
    /unknown preference/i,
  )
  assert.equal(target.writes.length, 1)
})

test('preserves corrupt JSON under a diagnostic name without logging its content', async () => {
  const secret = '{not-json token=super-secret'
  const target = memoryStore({ initial: secret })
  assert.deepEqual(await target.store.read(), DEFAULT_WINDOWS_PREFERENCES)
  assert.equal(target.renames.length, 1)
  assert.match(target.renames[0].destination, /\.corrupt-20260803T090000000Z$/)
  assert.equal(target.files.get(target.renames[0].destination), secret)
  assert.equal(target.logs.length, 1)
  assert.doesNotMatch(String(target.logs[0]), /super-secret|not-json/)
})

test('uses only the fixed startup argument and reads Electron actual state', () => {
  const calls = []
  const app = {
    setLoginItemSettings(value) {
      calls.push(value)
    },
    getLoginItemSettings() {
      return { openAtLogin: true, wasOpenedAtLogin: false }
    },
  }
  assert.equal(applyOpenAtLogin(app, true), true)
  assert.deepEqual(calls, [{
    openAtLogin: true,
    path: process.execPath,
    args: ['--startup'],
  }])
  assert.equal(readOpenAtLogin(app), true)
  assert.throws(
    () => applyOpenAtLogin(app, true, ['--arbitrary']),
    /startup arguments/i,
  )
})
