import assert from 'node:assert/strict'
import test from 'node:test'
import {
  COCKPIT_CONNECTION_INTERRUPTED,
  cockpitConnectionError,
  cockpitVoiceConnectionMode,
  publishCockpitVoiceIntent,
} from '../src/hooks/voiceSessionMode.js'

test('publishes voice intent once and retries it after a disconnected send', () => {
  const events = []
  let connected = false
  const client = {
    send(event) {
      if (!connected) return false
      events.push(event)
      return true
    },
  }

  let published = publishCockpitVoiceIntent(client, false)
  assert.equal(published, null)
  assert.deepEqual(events, [])

  connected = true
  published = publishCockpitVoiceIntent(client, false, published)
  assert.equal(published, false)
  assert.deepEqual(events, [{ type: 'unmute' }])

  published = publishCockpitVoiceIntent(client, false, published)
  assert.equal(published, false)
  assert.equal(events.length, 1)

  published = publishCockpitVoiceIntent(client, true, published)
  assert.equal(published, true)
  assert.deepEqual(events.at(-1), { type: 'mute' })
})

test('keeps a muted cockpit Client voice-capable without claiming voice', () => {
  assert.deepEqual(cockpitVoiceConnectionMode(true), {
    voiceEnabled: false,
    inputEnabled: false,
    outputEnabled: false,
    textOnly: false,
  })
})

test('enables both voice directions when the cockpit microphone starts active', () => {
  assert.deepEqual(cockpitVoiceConnectionMode(false, 'longanlufeng'), {
    voiceEnabled: true,
    inputEnabled: true,
    outputEnabled: true,
    textOnly: false,
    outputVoice: 'longanlufeng',
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
