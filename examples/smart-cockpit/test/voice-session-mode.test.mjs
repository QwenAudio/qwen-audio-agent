import assert from 'node:assert/strict'
import test from 'node:test'
import {
  COCKPIT_CONNECTION_INTERRUPTED,
  cockpitConnectionError,
  cockpitVoiceConnectionMode,
} from '../client/src/hooks/voiceSessionMode.js'

test('keeps a muted cockpit Client voice-capable without claiming voice', () => {
  assert.deepEqual(cockpitVoiceConnectionMode(true), {
    voiceEnabled: false,
    inputEnabled: false,
    outputEnabled: false,
    textOnly: false,
  })
})

test('enables both voice directions when the cockpit microphone starts active', () => {
  assert.deepEqual(cockpitVoiceConnectionMode(false), {
    voiceEnabled: true,
    inputEnabled: true,
    outputEnabled: true,
    textOnly: false,
  })
})

test('clears a transient connection error as soon as the Gateway reconnects', () => {
  assert.equal(
    cockpitConnectionError('disconnected'),
    COCKPIT_CONNECTION_INTERRUPTED,
  )
  assert.equal(
    cockpitConnectionError('unavailable'),
    COCKPIT_CONNECTION_INTERRUPTED,
  )
  assert.equal(cockpitConnectionError('connected'), null)
  assert.equal(cockpitConnectionError('ready'), null)
  assert.equal(cockpitConnectionError('recovery_failed'), undefined)
})
