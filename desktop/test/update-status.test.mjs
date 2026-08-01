import assert from 'node:assert/strict'
import test from 'node:test'

import {
  friendlyUpdateError,
  initialUpdateState,
  updaterButtonState,
  updaterStatusText,
} from '../src/update-status.mjs'

test('initial state carries the current version and idle phase', () => {
  assert.deepEqual(initialUpdateState('1.2.0'), {
    phase: 'idle',
    currentVersion: '1.2.0',
    updateVersion: '',
    percent: 0,
    message: '',
  })
})

test('friendly errors map known failure modes to actionable text', () => {
  assert.equal(
    friendlyUpdateError(new Error('Cannot find latest-mac.yml in the release')),
    '暂未发布可用于自动更新的版本',
  )
  assert.equal(
    friendlyUpdateError(new Error('HttpError: 404 Not Found')),
    '暂未发布可用于自动更新的版本',
  )
  assert.equal(
    friendlyUpdateError(new Error('net::ERR_CONNECTION_REFUSED')),
    '网络连接失败，请稍后重试',
  )
  assert.equal(
    friendlyUpdateError(new Error('Could not get code signature for running application')),
    '当前安装包未签名，无法自动更新',
  )
  assert.equal(friendlyUpdateError(null), '检查更新失败')
})

test('unknown errors keep the first line and stay bounded', () => {
  const long = `x`.repeat(200)
  assert.equal(friendlyUpdateError(new Error(`${long}\nsecond`)), long.slice(0, 120))
})

test('status text follows the update lifecycle', () => {
  const base = initialUpdateState('1.1.1')
  assert.equal(updaterStatusText(base), '1.1.1')
  assert.equal(
    updaterStatusText({ ...base, phase: 'checking' }),
    '1.1.1 · 正在检查更新…',
  )
  assert.equal(
    updaterStatusText({ ...base, phase: 'downloading', updateVersion: '1.2.0', percent: 45 }),
    '发现新版本 1.2.0，正在下载 45%…',
  )
  assert.equal(
    updaterStatusText({ ...base, phase: 'downloading', updateVersion: '1.2.0' }),
    '发现新版本 1.2.0，正在下载…',
  )
  assert.equal(
    updaterStatusText({ ...base, phase: 'downloaded', updateVersion: '1.2.0' }),
    '新版本 1.2.0 已就绪',
  )
  assert.equal(
    updaterStatusText({ ...base, phase: 'current' }),
    '1.1.1 · 已是最新版本',
  )
  assert.equal(
    updaterStatusText({ ...base, phase: 'error', message: '网络连接失败，请稍后重试' }),
    '1.1.1 · 网络连接失败，请稍后重试',
  )
})

test('button state gates checking and flips to install once downloaded', () => {
  const base = initialUpdateState('1.1.1')
  assert.deepEqual(updaterButtonState(base), {
    label: '检查更新',
    action: 'check',
    disabled: false,
  })
  assert.deepEqual(updaterButtonState({ ...base, phase: 'checking' }), {
    label: '检查更新',
    action: 'check',
    disabled: true,
  })
  assert.deepEqual(updaterButtonState({ ...base, phase: 'downloading' }), {
    label: '检查更新',
    action: 'check',
    disabled: true,
  })
  assert.deepEqual(updaterButtonState({ ...base, phase: 'downloaded' }), {
    label: '重启更新',
    action: 'install',
    disabled: false,
  })
})
