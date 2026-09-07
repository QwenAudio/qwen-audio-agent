export const CAMERA_OBSERVATION_MODE = Object.freeze({
  CONTINUOUS: 'continuous',
  QUESTION: 'question',
})

export const INITIAL_CAMERA_STATE = Object.freeze({
  open: false,
  ready: false,
  observationRequested: false,
  observationMode: '',
  observationFrameCount: 0,
})

export function cameraCloseReason({
  hidden = false,
  connectionState = 'connected',
  previousObservationAvailable = true,
  observationAvailable = true,
  observationRequested = false,
  observationState = 'idle',
  previousObservationState = 'idle',
} = {}) {
  if (hidden) return 'page_hidden'
  if (['unavailable', 'hidden'].includes(connectionState)) {
    return 'gateway_disconnected'
  }
  if (previousObservationAvailable && !observationAvailable) {
    return 'model_changed'
  }
  if (!observationRequested) return ''
  if (observationState === 'unavailable') return 'provider_unavailable'
  if (
    observationState === 'idle'
    && ['starting', 'active', 'unavailable'].includes(previousObservationState)
  ) return 'observation_stopped'
  return ''
}

export function cameraLifecycleReducer(
  state = INITIAL_CAMERA_STATE,
  action = {},
) {
  switch (action.type) {
    case 'opened':
      return {
        ...state,
        open: true,
        ready: false,
        observationRequested: false,
        observationMode: '',
        observationFrameCount: 0,
      }
    case 'ready':
      return { ...state, ready: true }
    case 'observation_started':
      return {
        ...state,
        observationRequested: true,
        observationMode: action.mode === CAMERA_OBSERVATION_MODE.QUESTION
          ? CAMERA_OBSERVATION_MODE.QUESTION
          : CAMERA_OBSERVATION_MODE.CONTINUOUS,
        observationFrameCount: 0,
      }
    case 'frame_count':
      return {
        ...state,
        observationFrameCount: Math.max(0, Math.floor(Number(action.count) || 0)),
      }
    case 'observation_stopped':
      return {
        ...state,
        observationRequested: false,
        observationMode: '',
        observationFrameCount: 0,
      }
    case 'closed':
      return { ...INITIAL_CAMERA_STATE }
    default:
      return state
  }
}
