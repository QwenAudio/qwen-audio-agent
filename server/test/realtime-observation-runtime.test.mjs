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
  const fixtureState = fixture()
  assert.equal(await fixtureState.runtime.start(), true)
  assert.deepEqual(
    fixtureState.gatewayEvents.map(event => event.state),
    ['starting', 'active'],
  )

  assert.equal(fixtureState.runtime.frame({ image: JPEG, sequence: 1 }), true)
  assert.deepEqual(fixtureState.providerEvents, [{
    type: 'input_image_buffer.append',
    image: JPEG,
  }])
  assert.equal(
    fixtureState.providerEvents.some(event => event.type === 'response.create'),
    false,
  )
})

test('limits observation to about one frame per second and retains eight frames', async () => {
  const fixtureState = fixture()
  await fixtureState.runtime.start()
  for (let sequence = 0; sequence < OBSERVATION_MAX_FRAMES + 2; sequence += 1) {
    fixtureState.setNow(sequence * OBSERVATION_INTERVAL_MS)
    assert.equal(fixtureState.runtime.frame({ image: JPEG, sequence }), true)
  }
  fixtureState.setNow(OBSERVATION_INTERVAL_MS * (OBSERVATION_MAX_FRAMES + 1) + 1)
  assert.equal(fixtureState.runtime.frame({ image: JPEG, sequence: 99 }), false)
  assert.equal(fixtureState.runtime.snapshot().frames, OBSERVATION_MAX_FRAMES)
  assert.equal(fixtureState.providerEvents.length, OBSERVATION_MAX_FRAMES + 2)
})

test('rejects malformed or oversized frames without forwarding them', async () => {
  const fixtureState = fixture()
  await fixtureState.runtime.start()
  assert.equal(fixtureState.runtime.frame({ image: 'not base64!' }), false)
  assert.equal(
    fixtureState.runtime.frame({ image: `A${'a'.repeat(256 * 1024)}` }),
    false,
  )
  assert.equal(fixtureState.providerEvents.length, 0)
  assert.equal(fixtureState.errors.length, 2)
})

test('fails closed when the active model does not support observation', async () => {
  const fixtureState = fixture({ supported: false })
  assert.equal(await fixtureState.runtime.start(), false)
  assert.equal(fixtureState.runtime.snapshot().state, 'unavailable')
  assert.equal(fixtureState.errors.length, 1)
  assert.equal(fixtureState.errors[0].message, '当前 Realtime 模型不支持画面观察')
})

test('stop clears raw frame memory and publishes an idle state', async () => {
  const fixtureState = fixture()
  await fixtureState.runtime.start()
  fixtureState.runtime.frame({ image: JPEG, sequence: 1 })
  fixtureState.runtime.stop('page_hidden')
  assert.deepEqual(fixtureState.runtime.snapshot(), {
    state: 'idle',
    frames: 0,
    lastFrameAt: 0,
  })
  assert.deepEqual(fixtureState.gatewayEvents.at(-1), {
    type: 'observation.state',
    state: 'idle',
    frames: 0,
    reason: 'page_hidden',
  })
})
