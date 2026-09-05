import assert from 'node:assert/strict'
import test from 'node:test'
import {
  OBSERVATION_INTERVAL_MS,
  OBSERVATION_MAX_FRAMES,
  RealtimeObservationRuntime,
} from '../src/voice/realtime-observation-runtime.mjs'
import { openAiCompatibleProtocol } from '../src/voice/providers/openai-compatible-protocol.mjs'

function fixture({ supported = true } = {}) {
  let now = 0
  const providerEvents = []
  const gatewayEvents = []
  const errors = []
  const frontend = {
    transportCapabilities: { observationInput: supported },
    send: event => providerEvents.push(event),
  }
  const runtime = new RealtimeObservationRuntime({
    ensureFrontend: async () => {},
    getFrontend: () => frontend,
    send: event => gatewayEvents.push(event),
    onError: error => errors.push(error),
    now: () => now,
  })
  return {
    runtime,
    frontend,
    providerEvents,
    gatewayEvents,
    errors,
    setNow(value) {
      now = value
    },
  }
}

const JPEG = '/9j/fake'

test('encodes a camera frame with the DashScope image-buffer event', () => {
  assert.deepEqual(openAiCompatibleProtocol.imageAppend(JPEG), {
    type: 'input_image_buffer.append',
    image: JPEG,
  })
})

test('starts explicitly and forwards observation frames without creating responses', async () => {
  const state = fixture()
  assert.equal(await state.runtime.start(), true)
  assert.deepEqual(state.gatewayEvents.map(event => event.state), ['starting', 'active'])
  assert.equal(state.runtime.frame({ image: JPEG, sequence: 1 }), true)
  assert.deepEqual(state.providerEvents, [{
    type: 'input_image_buffer.append',
    image: JPEG,
  }])
  assert.equal(
    state.providerEvents.some(event => event.type === 'response.create'),
    false,
  )
})

test('limits observation to about one frame per second and retains eight frames', async () => {
  const state = fixture()
  await state.runtime.start()
  for (let sequence = 0; sequence < OBSERVATION_MAX_FRAMES + 2; sequence += 1) {
    state.setNow(sequence * OBSERVATION_INTERVAL_MS)
    assert.equal(state.runtime.frame({ image: JPEG, sequence }), true)
  }
  state.setNow(OBSERVATION_INTERVAL_MS * (OBSERVATION_MAX_FRAMES + 1) + 1)
  assert.equal(state.runtime.frame({ image: JPEG, sequence: 99 }), false)
  assert.equal(state.runtime.snapshot().frames, OBSERVATION_MAX_FRAMES)
  assert.equal(state.providerEvents.length, OBSERVATION_MAX_FRAMES + 2)
})

test('rejects malformed or oversized frames without forwarding them', async () => {
  const state = fixture()
  await state.runtime.start()
  assert.equal(state.runtime.frame({ image: 'not base64!' }), false)
  assert.equal(state.runtime.frame({ image: 'AA=' }), false)
  assert.equal(state.runtime.frame({ image: `A${'a'.repeat(256 * 1024)}` }), false)
  assert.equal(state.providerEvents.length, 0)
  assert.equal(state.errors.length, 3)
})

test('fails closed when the active model does not support observation', async () => {
  const state = fixture({ supported: false })
  assert.equal(await state.runtime.start(), false)
  assert.equal(state.runtime.snapshot().state, 'unavailable')
  assert.equal(state.errors.length, 1)
  assert.equal(state.errors[0].message, '当前 Realtime 模型不支持画面观察')
})

test('stop clears raw frame memory and publishes an idle state', async () => {
  const state = fixture()
  await state.runtime.start()
  state.runtime.frame({ image: JPEG, sequence: 1 })
  state.runtime.stop('page_hidden')
  assert.deepEqual(state.runtime.snapshot(), {
    state: 'idle',
    frames: 0,
    lastFrameAt: 0,
  })
  assert.deepEqual(state.gatewayEvents.at(-1), {
    type: 'observation.state',
    state: 'idle',
    frames: 0,
    reason: 'page_hidden',
  })
})
