import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyDesktopClientState,
  desktopAutoHideSeconds,
  desktopCanHide,
  desktopHideDeadline,
  desktopWakeWordEnabled,
  desktopWorkSettled,
} from '../src/desktop-hide.js'

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
