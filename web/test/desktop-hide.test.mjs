import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyDesktopClientState,
  desktopAutoHideSeconds,
  desktopCanHide,
  DESKTOP_WAKE_GRACE_MS,
  desktopHideDeadline,
  desktopTasksActive,
  desktopTasksAttention,
  desktopWakeWordEnabled,
  desktopWorkSettled,
} from '../src/desktop-hide.js'

test('distinguishes active tasks from tasks waiting for authorization', () => {
  assert.equal(desktopTasksActive([]), false)
  assert.equal(desktopTasksAttention([]), false)

  const running = { phase: 'delegated' }
  assert.equal(desktopTasksActive([running]), true)
  assert.equal(desktopTasksAttention([running]), false)

  // 等待授权的任务同时是 active（阻止自动休眠）与 attention。
  const pending = {
    phase: 'running',
    authorization: { status: 'pending' },
  }
  assert.equal(desktopTasksActive([pending]), true)
  assert.equal(desktopTasksAttention([pending]), true)

  const done = { phase: 'completed' }
  assert.equal(desktopTasksActive([done]), false)
  assert.equal(desktopTasksAttention([done]), false)
})

test('ignores stale sleeping broadcasts right after an explicit wake', async () => {
  const bridge = { enterHide: async () => ({ state: 'hidden' }) }
  const event = { type: 'client.state', state: 'sleeping' }
  const wakeAt = 1_000_000

  // 宽限期内：Gateway 休眠计时器恰好在唤醒瞬间到期，迟到的指令不生效。
  assert.equal(await applyDesktopClientState(event, {
    desktop: true,
    bridge,
    lastWakeAt: wakeAt,
    now: wakeAt + DESKTOP_WAKE_GRACE_MS - 1,
  }), false)

  // 宽限期外照常隐藏。
  assert.equal(await applyDesktopClientState(event, {
    desktop: true,
    bridge,
    lastWakeAt: wakeAt,
    now: wakeAt + DESKTOP_WAKE_GRACE_MS,
  }), true)
})

test('maps a supported sleeping client state to the desktop bridge', async () => {
  const lifecycle = []
  const hidden = await applyDesktopClientState({
    type: 'client.state',
    state: 'sleeping',
  }, {
    desktop: true,
    bridge: { enterHide: async () => ({ state: 'hidden' }) },
    onLifecycle: state => lifecycle.push(state),
  })

  assert.equal(hidden, true)
  assert.deepEqual(lifecycle, ['hidden'])
  assert.equal(await applyDesktopClientState({
    type: 'client.state',
    state: 'sleeping',
  }), false)
})

test('uses a 60 second desktop hide default and supports never', () => {
  assert.equal(desktopAutoHideSeconds(''), 60)
  assert.equal(desktopAutoHideSeconds('?autoHideSeconds=300'), 300)
  assert.equal(desktopAutoHideSeconds('?autoHideSeconds=0'), 0)
  assert.equal(desktopAutoHideSeconds('?autoHideSeconds=5'), 60)
  assert.equal(desktopAutoHideSeconds('?autoSleepSeconds=300'), 300)
})

test('waits for tasks, permission prompts, transcripts, and voice playback', () => {
  assert.equal(desktopWorkSettled(), true)
  assert.equal(desktopWorkSettled({ tasks: [{ phase: 'running' }] }), false)
  assert.equal(desktopWorkSettled({
    tasks: [{ phase: 'completed', authorization: { status: 'pending' } }],
  }), false)
  assert.equal(desktopWorkSettled({ messages: [{ live: true }] }), false)
  assert.equal(desktopWorkSettled({ voiceState: 'speaking' }), false)
  assert.equal(desktopWorkSettled({ voiceState: 'listening' }), false)
})

test('only hides a healthy active desktop', () => {
  assert.equal(desktopCanHide({
    settled: true,
    connectionState: 'connected',
  }), true)
  assert.equal(desktopCanHide({
    settled: true,
    connectionState: 'unavailable',
  }), false)
  assert.equal(desktopCanHide({
    settled: true,
    connectionState: 'connected',
    lifecycle: 'waking',
  }), false)
})

test('starts the timeout after both interaction and work have ended', () => {
  assert.equal(desktopHideDeadline({
    lastInteractionAt: 1_000,
    workSettledAt: 10_000,
    timeoutSeconds: 120,
  }), 130_000)
})

test('reads the wake word enabled flag from the URL', () => {
  assert.equal(desktopWakeWordEnabled(''), false)
  assert.equal(desktopWakeWordEnabled('?wakeWordEnabled=true'), true)
  assert.equal(desktopWakeWordEnabled('?wakeWordEnabled=false'), false)
})
