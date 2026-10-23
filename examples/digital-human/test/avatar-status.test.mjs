// The avatar state -> visual vocabulary mapping is pure logic and drives both
// the header light and the stage placeholder, so it is covered here rather than
// only through the (non-hermetic) browser smoke test.
import test from 'node:test'
import assert from 'node:assert/strict'
import { avatarVisualState, avatarStatusDot } from '../client/avatar-status.js'

test('audio-only fallback remains visible after real playback starts', () => {
  assert.equal(avatarVisualState({
    state: 'connected', playback: 'speaking', avatarState: { state: 'speaking', output: 'audio_only' },
  }), 'audio_only')
})

test('renderer state wins over the connection state', () => {
  assert.equal(avatarVisualState({ avatarState: { state: 'rendering' }, state: 'connected' }), 'processing')
  assert.equal(avatarVisualState({ avatarState: { state: 'speaking' }, state: 'connected' }), 'speaking')
  assert.equal(avatarVisualState({ avatarState: { state: 'listening' }, state: 'connected' }), 'listening')
  assert.equal(avatarVisualState({ avatarState: { state: 'audio_only' }, state: 'connected' }), 'audio_only')
  assert.equal(avatarVisualState({ avatarState: { state: 'error' }, state: 'connected' }), 'error')
})

test('an unknown renderer state falls back to the connection state', () => {
  assert.equal(avatarVisualState({ avatarState: { state: 'bogus' }, state: 'connected' }), 'idle')
  assert.equal(avatarVisualState({ avatarState: null, state: 'connecting' }), 'connecting')
  assert.equal(avatarVisualState({ avatarState: null, state: 'error' }), 'error')
})

test('a connected session is 待命 while muted and 正在听 while capturing', () => {
  // The WebRTC session stays connected with the mic off, so mute must not read
  // as listening: nothing is being captured.
  assert.equal(avatarVisualState({ state: 'connected', micEnabled: false }), 'idle')
  assert.equal(avatarVisualState({ state: 'connected', micEnabled: true }), 'listening')
})

test('audible playback outranks the mic toggle', () => {
  assert.equal(avatarVisualState({ state: 'connected', playback: 'speaking', micEnabled: true }), 'speaking')
})

test('no transport at all is idle', () => {
  assert.equal(avatarVisualState(null), 'idle')
  assert.equal(avatarVisualState({}), 'idle')
})

test('audio_only borrows the amber dot but keeps its own label key', () => {
  // The status light has no dedicated colour for the degraded state.
  assert.equal(avatarStatusDot('audio_only'), 'processing')
  for (const visual of ['idle', 'listening', 'processing', 'speaking', 'error', 'connecting']) {
    assert.equal(avatarStatusDot(visual), visual)
  }
})
