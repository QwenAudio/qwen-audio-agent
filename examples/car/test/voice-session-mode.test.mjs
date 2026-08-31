import assert from 'node:assert/strict'
import test from 'node:test'
import { cockpitVoiceConnectionMode } from '../react-app/src/hooks/voiceSessionMode.js'

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
