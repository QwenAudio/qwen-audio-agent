import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyDesktopClientState,
  desktopAutoHideSeconds,
  desktopCanFinishWaking,
  desktopCanHide,
  DESKTOP_WAKE_GRACE_MS,
  desktopHideDeadline,
  desktopTasksActive,
  desktopTasksWorking,
  desktopWakeWordEnabled,
  desktopWorkSettled,
  performDesktopClientAction,
} from '../src/desktop-hide.js'
import {
  GatewayClientProtocolEvent,
} from '../../shared/gateway-client-protocol.mjs'

test('distinguishes active tasks from tasks waiting for authorization', () => {
  assert.equal(desktopTasksActive([]), false)
  assert.equal(desktopTasksWorking([]), false)

  const running = { phase: 'delegated' }
  assert.equal(desktopTasksActive([running]), true)
  assert.equal(desktopTasksWorking([running]), true)
  for (const kind of ['work', 'control', 'scheduled', 'delegated', 'custom']) {
    assert.equal(desktopTasksActive([{ kind, phase: 'running' }]), true)
  }

  // 等待授权仍是 active（阻止自动休眠），但不属于动画 working 状态。
  const pending = {
    phase: 'running',
    authorization: { status: 'pending' },
  }
  assert.equal(desktopTasksActive([pending]), true)
  assert.equal(desktopTasksWorking([pending]), false)

  const thinking = {
    phase: 'running',
    activity: [{ kind: 'thinking', status: 'running' }],
  }
  assert.equal(desktopTasksWorking([thinking]), true)

  const done = { phase: 'completed' }
  assert.equal(desktopTasksActive([done]), false)
  assert.equal(desktopTasksWorking([done]), false)
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

test('reports Client Action completion only after the desktop is hidden', async () => {
  const lifecycle = []
  const hideRequests = []
  const result = await performDesktopClientAction({
    type: GatewayClientProtocolEvent.CLIENT_ACTION_REQUEST,
    name: 'desktop.presence.enter_sleep',
  }, {
    desktop: true,
    bridge: { enterHide: async options => {
      hideRequests.push(options)
      return { state: 'hidden' }
    } },
    onLifecycle: state => lifecycle.push(state),
    // Explicit user/model sleep must still work immediately after wake.
    lastWakeAt: Date.now(),
  })
  assert.deepEqual(result, {
    status: 'completed',
    output: { state: 'hidden' },
  })
  assert.deepEqual(lifecycle, ['hidden'])
  assert.deepEqual(hideRequests, [{ explicit: true }])

  const unsupported = await performDesktopClientAction({
    type: GatewayClientProtocolEvent.CLIENT_ACTION_REQUEST,
    name: 'hardware.light.turn_on',
  }, { desktop: true })
  assert.equal(unsupported.status, 'unsupported')
})

test('uses a 60 second desktop hide default and supports never', () => {
  assert.equal(desktopAutoHideSeconds(''), 60)
  assert.equal(desktopAutoHideSeconds('?autoHideSeconds=300'), 300)
  assert.equal(desktopAutoHideSeconds('?autoHideSeconds=0'), 0)
  assert.equal(desktopAutoHideSeconds('?autoHideSeconds=5'), 60)
  assert.equal(desktopAutoHideSeconds('?autoSleepSeconds=300'), 300)
})

test('waits for tasks, permission prompts, and active voice states', () => {
  assert.equal(desktopWorkSettled(), true)
  assert.equal(desktopWorkSettled({ tasks: [{ phase: 'running' }] }), false)
  assert.equal(desktopWorkSettled({
    tasks: [{ phase: 'completed', authorization: { status: 'pending' } }],
  }), false)
  // A response interrupted by sleep may leave stale rendering metadata.
  // Current task and voice state remain the authoritative activity gates.
  assert.equal(desktopWorkSettled({ messages: [{ live: true }] }), true)
  assert.equal(desktopWorkSettled({ voiceState: 'speaking' }), false)
  assert.equal(desktopWorkSettled({ voiceState: 'listening' }), false)
  assert.equal(desktopWorkSettled({ voiceState: 'processing' }), false)
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

test('finishes waking from the Gateway connection without waiting for microphone capture', () => {
  assert.equal(desktopCanFinishWaking('connected'), true)
  assert.equal(desktopCanFinishWaking('unavailable'), true)
  assert.equal(desktopCanFinishWaking('connecting'), false)
  assert.equal(desktopCanFinishWaking('hidden'), false)
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
