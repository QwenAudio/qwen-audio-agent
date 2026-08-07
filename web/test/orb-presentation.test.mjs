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

test('exposes listening level, error, and dragging states to the desktop orb', () => {
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
    connectionError: true,
    connecting: true,
    ownershipBusy: true,
    voiceState: 'listening',
    tasksActive: true,
    attentionPending: true,
  }
  assert.equal(resolveOrbVisualState(everything), 'hidden')
  assert.equal(
    resolveOrbVisualState({ ...everything, lifecycle: 'waking' }),
    'waking',
  )
  assert.equal(
    resolveOrbVisualState({ ...everything, lifecycle: 'active' }),
    'error',
  )
  // 对话态优先于所有后台态。
  for (const voiceState of ['listening', 'thinking', 'speaking']) {
    assert.equal(resolveOrbVisualState({
      ...everything,
      lifecycle: 'active',
      connectionError: false,
      voiceState,
    }), voiceState)
  }
  // 后台态优先级：attention > working > occupied > connecting > idle。
  const background = {
    lifecycle: 'active',
    connectionError: false,
    connecting: true,
    ownershipBusy: true,
    voiceState: 'idle',
    tasksActive: true,
    attentionPending: true,
  }
  assert.equal(resolveOrbVisualState(background), 'attention')
  assert.equal(
    resolveOrbVisualState({ ...background, attentionPending: false }),
    'working',
  )
  assert.equal(resolveOrbVisualState({
    ...background,
    attentionPending: false,
    tasksActive: false,
  }), 'occupied')
  assert.equal(resolveOrbVisualState({
    ...background,
    attentionPending: false,
    tasksActive: false,
    ownershipBusy: false,
  }), 'connecting')
  assert.equal(resolveOrbVisualState({
    ...background,
    attentionPending: false,
    tasksActive: false,
    ownershipBusy: false,
    connecting: false,
  }), 'idle')
  // 无入参与未知语音态透传。
  assert.equal(resolveOrbVisualState(), 'idle')
  assert.equal(resolveOrbVisualState({ voiceState: 'custom' }), 'custom')
})
