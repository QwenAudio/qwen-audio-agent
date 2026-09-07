import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CAMERA_OBSERVATION_MODE,
  INITIAL_CAMERA_STATE,
  cameraCloseReason,
  cameraLifecycleReducer,
} from '../src/camera-lifecycle.js'

test('opens a camera session without claiming that capture is ready', () => {
  const state = cameraLifecycleReducer({
    ...INITIAL_CAMERA_STATE,
    ready: true,
    observationRequested: true,
    observationMode: CAMERA_OBSERVATION_MODE.CONTINUOUS,
    observationFrameCount: 4,
  }, { type: 'opened' })

  assert.deepEqual(state, {
    open: true,
    ready: false,
    observationRequested: false,
    observationMode: '',
    observationFrameCount: 0,
  })
})

test('tracks readiness and continuous observation frames', () => {
  let state = cameraLifecycleReducer(undefined, { type: 'opened' })
  state = cameraLifecycleReducer(state, { type: 'ready' })
  state = cameraLifecycleReducer(state, {
    type: 'observation_started',
    mode: CAMERA_OBSERVATION_MODE.CONTINUOUS,
  })
  state = cameraLifecycleReducer(state, { type: 'frame_count', count: 3.9 })

  assert.equal(state.open, true)
  assert.equal(state.ready, true)
  assert.equal(state.observationRequested, true)
  assert.equal(state.observationMode, CAMERA_OBSERVATION_MODE.CONTINUOUS)
  assert.equal(state.observationFrameCount, 3)
})

test('keeps one-shot question mode distinct from continuous observation', () => {
  const state = cameraLifecycleReducer(
    { ...INITIAL_CAMERA_STATE, open: true, ready: true },
    { type: 'observation_started', mode: CAMERA_OBSERVATION_MODE.QUESTION },
  )

  assert.equal(state.observationRequested, true)
  assert.equal(state.observationMode, CAMERA_OBSERVATION_MODE.QUESTION)
  assert.equal(state.observationFrameCount, 0)
})

test('stopping observation preserves the open camera but clears observation state', () => {
  const state = cameraLifecycleReducer({
    open: true,
    ready: true,
    observationRequested: true,
    observationMode: CAMERA_OBSERVATION_MODE.QUESTION,
    observationFrameCount: 1,
  }, { type: 'observation_stopped' })

  assert.deepEqual(state, {
    open: true,
    ready: true,
    observationRequested: false,
    observationMode: '',
    observationFrameCount: 0,
  })
})

test('closing the camera releases every local lifecycle flag', () => {
  const state = cameraLifecycleReducer({
    open: true,
    ready: true,
    observationRequested: true,
    observationMode: CAMERA_OBSERVATION_MODE.CONTINUOUS,
    observationFrameCount: 8,
  }, { type: 'closed' })

  assert.deepEqual(state, INITIAL_CAMERA_STATE)
})

test('maps hidden, disconnected, model-changed, and stopped states to close reasons', () => {
  assert.equal(cameraCloseReason({ hidden: true }), 'page_hidden')
  assert.equal(
    cameraCloseReason({ connectionState: 'unavailable' }),
    'gateway_disconnected',
  )
  assert.equal(cameraCloseReason({
    previousObservationAvailable: true,
    observationAvailable: false,
  }), 'model_changed')
  assert.equal(cameraCloseReason({
    observationRequested: true,
    observationState: 'unavailable',
  }), 'provider_unavailable')
  assert.equal(cameraCloseReason({
    observationRequested: true,
    observationState: 'idle',
    previousObservationState: 'active',
  }), 'observation_stopped')
})
