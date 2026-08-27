import assert from 'node:assert/strict'
import test from 'node:test'
import {
  desktopOrbClassName,
  resolveOrbVisualState,
} from '../src/orb-presentation.js'

test('keeps speaking animation active while microphone input is muted', () => {
  assert.equal(desktopOrbClassName({
    state: 'speaking',
    enabled: false,
  }), 'desktop-orb-stage speaking input-muted')
})

test('exposes semantic listening, error, and dragging states to the desktop orb', () => {
  assert.equal(desktopOrbClassName({
    state: 'listening',
    enabled: true,
    error: true,
    dragging: true,
  }), 'desktop-orb-stage listening enabled error dragging')
})

test('keeps the waking lifecycle distinct from an error', () => {
  const className = desktopOrbClassName({
    state: 'waking',
    enabled: true,
    lifecycle: 'waking',
  })
  assert.match(className, /\bwaking\b/)
  assert.doesNotMatch(className, /\berror\b/)
})

test('arbitrates visual states by layered priority', () => {
  // 满载输入：每一层压过下一层。
  const everything = {
    lifecycle: 'hidden',
    runtimeState: 'starting',
    connectionError: true,
    connecting: true,
    ownershipBusy: true,
    voiceState: 'listening',
    tasksWorking: true,
  }
  assert.equal(resolveOrbVisualState(everything), 'hidden')
  assert.equal(
    resolveOrbVisualState({ ...everything, lifecycle: 'waking' }),
    'waking',
  )
  assert.equal(
    resolveOrbVisualState({ ...everything, lifecycle: 'active' }),
    'starting',
  )
  assert.equal(
    resolveOrbVisualState({
      ...everything,
      lifecycle: 'active',
      runtimeState: 'failed',
    }),
    'error',
  )
  // 对话态优先于所有后台态。
  for (const voiceState of ['listening', 'processing', 'speaking']) {
    assert.equal(resolveOrbVisualState({
      ...everything,
      lifecycle: 'active',
      runtimeState: 'ready',
      connectionError: false,
      voiceState,
    }), voiceState)
  }
  // 后台态优先级：working > occupied > connecting > idle。
  const background = {
    lifecycle: 'active',
    runtimeState: 'ready',
    connectionError: false,
    connecting: true,
    ownershipBusy: true,
    voiceState: 'idle',
    tasksWorking: true,
  }
  assert.equal(resolveOrbVisualState(background), 'working')
  assert.equal(resolveOrbVisualState({
    ...background,
    tasksWorking: false,
  }), 'occupied')
  assert.equal(resolveOrbVisualState({
    ...background,
    tasksWorking: false,
    ownershipBusy: false,
  }), 'connecting')
  assert.equal(resolveOrbVisualState({
    ...background,
    tasksWorking: false,
    ownershipBusy: false,
    connecting: false,
  }), 'idle')
  // 无入参时待机；未知 Provider 状态不能泄漏给皮肤。
  assert.equal(resolveOrbVisualState(), 'idle')
  assert.equal(resolveOrbVisualState({ voiceState: 'custom' }), 'idle')
})
