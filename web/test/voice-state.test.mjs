import assert from 'node:assert/strict'
import test from 'node:test'
import {
  acceptsVoiceState,
  microphoneControlEvent,
  retainedRealtimeProvider,
  shouldAdvertiseVoice,
  shouldClaimReleasedVoice,
  visualVoiceState,
} from '../src/useRealtimeVoice.js'

test('keeps a persisted front end only while the server still offers it', () => {
  const providers = [{ key: 'dashscope' }, { key: 'speech-to-speech' }]

  assert.equal(
    retainedRealtimeProvider('speech-to-speech', providers),
    'speech-to-speech',
  )
  // Selecting the server default is always valid.
  assert.equal(retainedRealtimeProvider('', providers), '')
  // A front end this server does not expose degrades to the default instead of
  // being sent on every connect and refused.
  assert.equal(retainedRealtimeProvider('removed', providers), '')
  assert.equal(retainedRealtimeProvider('speech-to-speech', []), '')
  assert.equal(retainedRealtimeProvider('speech-to-speech', undefined), '')
})

test('desktop microphone controls mute only input', () => {
  assert.deepEqual(microphoneControlEvent({
    enabled: false,
    inputOnlyMute: true,
  }), {
    type: 'input.mute',
  })
  assert.deepEqual(microphoneControlEvent({
    enabled: true,
    inputOnlyMute: true,
    takeover: true,
  }), {
    type: 'input.unmute',
    takeover: true,
  })
})

test('regular voice controls retain full mute behavior', () => {
  assert.deepEqual(microphoneControlEvent({ enabled: false }), {
    type: 'mute',
  })
  assert.deepEqual(microphoneControlEvent({
    enabled: true,
    takeover: false,
  }), {
    type: 'unmute',
    takeover: false,
  })
})

test('ignores a stale direct-model state from an older voice turn', () => {
  assert.equal(acceptsVoiceState({
    type: 'voice.state',
    state: 'idle',
    turnId: 'voice-100-1',
    origin: 'model',
  }, 'voice-200-2'), false)
})

test('claims voice when another frontend releases a user-requested handoff', () => {
  assert.equal(shouldClaimReleasedVoice({
    type: 'voice.ownership',
    state: 'available',
  }, true), true)
  assert.equal(shouldClaimReleasedVoice({
    type: 'voice.ownership',
    state: 'busy',
  }, true), false)
  assert.equal(shouldClaimReleasedVoice({
    type: 'voice.ownership',
    state: 'available',
  }, false), false)
})

test('advertises voice only after microphone input is ready', () => {
  assert.equal(shouldAdvertiseVoice(true, false), false)
  assert.equal(shouldAdvertiseVoice(false, true), false)
  assert.equal(shouldAdvertiseVoice(true, true), true)
})

test('shows agent and announcement playback even when it belongs to an older turn', () => {
  assert.equal(acceptsVoiceState({
    type: 'voice.state',
    state: 'speaking',
    turnId: 'voice-100-1',
    origin: 'agent',
  }, 'voice-200-2'), true)
  assert.equal(acceptsVoiceState({
    type: 'voice.state',
    state: 'speaking',
    turnId: 'voice-100-1',
    origin: 'announcement',
  }, 'voice-200-2'), true)
})

test('shows local microphone activity immediately without changing model state', () => {
  assert.equal(visualVoiceState('idle', true, true), 'listening')
  assert.equal(visualVoiceState('thinking', true, true), 'listening')
  assert.equal(visualVoiceState('speaking', true, true), 'listening')
  assert.equal(visualVoiceState('thinking', false, true), 'thinking')
  assert.equal(visualVoiceState('idle', true, false), 'idle')
})
