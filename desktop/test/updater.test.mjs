import assert from 'node:assert/strict'
import test from 'node:test'

import { createDesktopUpdater } from '../src/updater.mjs'

function fakeImpl(overrides = {}) {
  const handlers = new Map()
  return {
    autoDownload: undefined,
    autoInstallOnAppQuit: undefined,
    logger: undefined,
    calls: [],
    on(event, fn) {
      handlers.set(event, fn)
    },
    emit(event, payload) {
      handlers.get(event)?.(payload)
    },
    async checkForUpdates() {
      this.calls.push('check')
    },
    quitAndInstall() {
      this.calls.push('install')
    },
    ...overrides,
  }
}

test('check configures differential-friendly defaults and runs', async () => {
  const impl = fakeImpl()
  const seen = []
  const updater = createDesktopUpdater({
    currentVersion: '1.1.1',
    notify: status => seen.push(status.phase),
    impl,
  })
  const state = await updater.check()
  assert.equal(impl.autoDownload, true)
  assert.equal(impl.autoInstallOnAppQuit, true)
  assert.deepEqual(impl.calls, ['check'])
  assert.equal(state.phase, 'checking')
  assert.deepEqual(seen, ['checking'])
})

test('disabled environments fail with a friendly message', async () => {
  const impl = fakeImpl()
  const updater = createDesktopUpdater({
    currentVersion: '1.1.1',
    enabled: false,
    impl,
  })
  const state = await updater.check()
  assert.equal(state.phase, 'error')
  assert.equal(state.message, '当前环境不支持自动更新')
  assert.deepEqual(impl.calls, [])
})

test('event flow reduces to download progress and readiness', async () => {
  const impl = fakeImpl()
  const updater = createDesktopUpdater({ currentVersion: '1.1.1', impl })
  await updater.check()
  impl.emit('update-available', { version: '1.2.0' })
  assert.deepEqual(updater.state(), {
    phase: 'downloading',
    currentVersion: '1.1.1',
    updateVersion: '1.2.0',
    percent: 0,
    message: '',
  })
  impl.emit('download-progress', { percent: 45.4 })
  assert.equal(updater.state().percent, 45)
  impl.emit('update-downloaded', { version: '1.2.0' })
  assert.equal(updater.state().phase, 'downloaded')
  assert.equal(updater.state().percent, 100)
  updater.install()
  assert.deepEqual(impl.calls, ['check', 'install'])
})

test('update-not-available resolves to the current phase', async () => {
  const impl = fakeImpl()
  const updater = createDesktopUpdater({ currentVersion: '1.1.1', impl })
  await updater.check()
  impl.emit('update-not-available', { version: '1.1.1' })
  assert.equal(updater.state().phase, 'current')
})

test('rejected checks and runtime errors surface friendly messages', async () => {
  const impl = fakeImpl({
    async checkForUpdates() {
      throw new Error('net::ERR_INTERNET_DISCONNECTED')
    },
  })
  const updater = createDesktopUpdater({ currentVersion: '1.1.1', impl })
  const state = await updater.check()
  assert.equal(state.phase, 'error')
  assert.equal(state.message, '网络连接失败，请稍后重试')

  impl.emit('error', new Error('Cannot find latest-mac.yml'))
  assert.equal(updater.state().message, '暂未发布可用于自动更新的版本')
})
