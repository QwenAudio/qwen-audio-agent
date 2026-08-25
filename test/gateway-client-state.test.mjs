import assert from 'node:assert/strict'
import test from 'node:test'
import {
  acceptsGatewayVoiceState,
  createGatewayClientState,
  reduceGatewayClientState,
} from '../shared/gateway-client-state.mjs'

function reduce(events, initial = createGatewayClientState()) {
  return events.reduce(reduceGatewayClientState, initial)
}

test('creates one stable client-state vocabulary', () => {
  assert.deepEqual(createGatewayClientState(), {
    connectionState: 'connecting',
    voiceReady: false,
    voiceState: 'idle',
    wakeWordActive: false,
    ownership: {
      state: 'available',
      holder: null,
    },
    currentTurnId: '',
  })
  assert.equal(
    createGatewayClientState({ connectionState: 'hidden' }).connectionState,
    'hidden',
  )
})

test('projects Gateway and Realtime connection events', () => {
  const handshaken = reduceGatewayClientState(createGatewayClientState(), {
    type: 'voice.connection',
    state: 'connected',
  })
  assert.equal(handshaken.connectionState, 'connected')
  assert.equal(handshaken.voiceReady, false)

  const connected = reduce([
    { type: 'gateway.connected' },
    { type: 'voice.ready', inputSampleRate: 16_000 },
  ])
  assert.equal(connected.connectionState, 'connected')
  assert.equal(connected.voiceReady, true)

  const retrying = reduceGatewayClientState(connected, {
    type: 'voice.connection',
    state: 'unavailable',
  })
  assert.equal(retrying.connectionState, 'unavailable')
  assert.equal(retrying.voiceReady, false)

  const disconnected = reduceGatewayClientState({
    ...retrying,
    voiceState: 'speaking',
  }, { type: 'gateway.disconnected' })
  assert.equal(disconnected.connectionState, 'unavailable')
  assert.equal(disconnected.voiceReady, false)
  assert.equal(disconnected.voiceState, 'idle')
})

test('does not report ready from an incomplete voice.ready event', () => {
  const state = createGatewayClientState()
  assert.equal(
    reduceGatewayClientState(state, { type: 'voice.ready' }),
    state,
  )
})

test('tracks the active turn and ignores stale direct-model voice state', () => {
  const state = reduce([
    { type: 'turn.started', turnId: 'voice-2' },
    {
      type: 'voice.state',
      state: 'speaking',
      turnId: 'voice-1',
      origin: 'model',
    },
  ])
  assert.equal(state.currentTurnId, 'voice-2')
  assert.equal(state.voiceState, 'idle')

  const announcement = reduceGatewayClientState(state, {
    type: 'voice.state',
    state: 'speaking',
    turnId: 'voice-1',
    origin: 'announcement',
  })
  assert.equal(announcement.voiceState, 'speaking')
  assert.equal(acceptsGatewayVoiceState({
    type: 'voice.state',
    turnId: 'voice-1',
    origin: 'model',
  }, 'voice-2'), false)
})

test('projects sleep and voice ownership without client-specific inference', () => {
  const active = reduce([
    { type: 'voice.sleep', state: 'enabled' },
    {
      type: 'voice.ownership',
      state: 'active',
      holder: { type: 'desktop', label: 'Desktop' },
    },
  ])
  assert.equal(active.wakeWordActive, true)
  assert.deepEqual(active.ownership, {
    state: 'active',
    holder: { type: 'desktop', label: 'Desktop' },
  })

  const deactivated = reduceGatewayClientState(active, {
    type: 'voice.deactivated',
    holder: { type: 'tui', label: 'TUI' },
  })
  assert.deepEqual(deactivated.ownership, {
    state: 'busy',
    holder: { type: 'tui', label: 'TUI' },
  })
  assert.equal(reduceGatewayClientState(deactivated, {
    type: 'voice.sleep',
    state: 'detected',
  }), deactivated)
})

test('preserves identity for events outside the client state projection', () => {
  const state = createGatewayClientState()
  assert.equal(reduceGatewayClientState(state, { type: 'audio.delta' }), state)
  assert.equal(reduceGatewayClientState(state, null), state)
})
