import assert from 'node:assert/strict'
import test from 'node:test'
import {
  acceptsVoiceState,
  microphoneSamplesDuringManualInput,
  microphoneControlEvent,
  releasesManualInputGuard,
  realtimeClientMode,
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
  }), {
    type: 'input.unmute',
  })
})

test('briefly holds microphone transport while manual input starts a response', () => {
  const samples = Float32Array.from([0.25, -0.5])
  assert.equal(microphoneSamplesDuringManualInput(samples), samples)
  assert.deepEqual(
    [...microphoneSamplesDuringManualInput(samples, true)],
    [0, 0],
  )

  assert.equal(releasesManualInputGuard({
    type: 'response.started',
    turnId: 'text_expected',
  }, 'text_expected'), true)
  assert.equal(releasesManualInputGuard({
    type: 'response.started',
    turnId: 'voice_other',
  }, 'text_expected'), false)
  assert.equal(releasesManualInputGuard({ type: 'error' }, 'text_expected'), true)
})

test('hidden desktop capture enters wake-word-only sleep instead of unmuting input', () => {
  assert.deepEqual(microphoneControlEvent({
    enabled: true,
    inputOnlyMute: true,
    wakeWordOnly: true,
  }), {
    type: 'sleep',
  })
})

test('regular voice controls retain full mute behavior', () => {
  assert.deepEqual(microphoneControlEvent({ enabled: false }), {
    type: 'mute',
  })
  assert.deepEqual(microphoneControlEvent({
    enabled: true,
  }), {
    type: 'unmute',
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

test('separates non-voice clients from microphone-only mute', () => {
  assert.deepEqual(realtimeClientMode({
    enabled: false,
    inputReady: false,
  }), {
    textOnly: true,
    inputEnabled: false,
    outputEnabled: true,
  })
  assert.deepEqual(realtimeClientMode({
    enabled: true,
    inputReady: true,
  }), {
    textOnly: false,
    inputEnabled: true,
    outputEnabled: true,
  })
  assert.deepEqual(realtimeClientMode({
    enabled: false,
    inputReady: false,
    inputOnlyMute: true,
  }), {
    textOnly: false,
    inputEnabled: false,
    outputEnabled: true,
  })
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

test('keeps visual state semantic instead of inferring it from local volume', () => {
  assert.equal(visualVoiceState('idle'), 'idle')
  assert.equal(visualVoiceState('listening'), 'listening')
  assert.equal(visualVoiceState('processing'), 'processing')
  assert.equal(visualVoiceState('speaking'), 'speaking')
})
