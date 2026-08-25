import { GatewayServerEvent } from './realtime-events.mjs'

const DEFAULT_OWNERSHIP = Object.freeze({
  state: 'available',
  holder: null,
})

export function createGatewayClientState({
  connectionState = 'connecting',
} = {}) {
  return {
    connectionState,
    voiceState: 'idle',
    wakeWordActive: false,
    ownership: { ...DEFAULT_OWNERSHIP },
    currentTurnId: '',
  }
}

export function acceptsGatewayVoiceState(event, currentTurnId) {
  return (
    !event?.turnId
    || event.turnId === currentTurnId
    || event.origin !== 'model'
  )
}

export function reduceGatewayClientState(current, event) {
  const state = current || createGatewayClientState()
  if (!event || typeof event !== 'object') return state

  switch (event.type) {
    case GatewayServerEvent.GATEWAY_CONNECTED:
      return {
        ...state,
        connectionState: 'connecting',
      }

    case GatewayServerEvent.GATEWAY_DISCONNECTED:
      return {
        ...state,
        connectionState: 'unavailable',
        voiceState: 'idle',
      }

    case GatewayServerEvent.VOICE_READY:
      return event.inputSampleRate
        ? { ...state, connectionState: 'connected' }
        : state

    case GatewayServerEvent.VOICE_CONNECTION:
      return {
        ...state,
        connectionState: event.state || 'connecting',
      }

    case GatewayServerEvent.TURN_STARTED:
      return {
        ...state,
        currentTurnId: event.turnId || '',
      }

    case GatewayServerEvent.VOICE_STATE:
      if (!acceptsGatewayVoiceState(event, state.currentTurnId)) return state
      return {
        ...state,
        voiceState: event.state || state.voiceState,
      }

    case GatewayServerEvent.VOICE_SLEEP:
      if (event.state !== 'enabled' && event.state !== 'disabled') return state
      return {
        ...state,
        wakeWordActive: event.state === 'enabled',
      }

    case GatewayServerEvent.VOICE_OWNERSHIP:
      return {
        ...state,
        ownership: {
          state: event.state || 'available',
          holder: event.holder || null,
        },
      }

    case GatewayServerEvent.VOICE_DEACTIVATED:
      return {
        ...state,
        ownership: {
          state: 'busy',
          holder: event.holder || null,
        },
      }

    default:
      return state
  }
}
