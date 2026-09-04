import assert from 'node:assert/strict'
import test from 'node:test'
import {
  OBSERVATION_INTERVAL_MS,
  OBSERVATION_MAX_FRAMES,
  ObservationSessionRuntime,
} from '../src/voice/observation-session-runtime.mjs'

const JPEG = '/9j/fake'

test('runs a bounded observation session without a Realtime provider', async () => {
  let now = 0
  const gatewayEvents = []
  const frames = []
  const session = new ObservationSessionRuntime({
    send: event => gatewayEvents.push(event),
    onFrame: frame => frames.push(frame),
    now: () => now,
  })

  assert.equal(await session.start(), true)
  assert.deepEqual(gatewayEvents.map(event => event.state), ['starting', 'active'])

  assert.equal(session.frame({ image: JPEG, sequence: 3 }), true)
  assert.deepEqual(frames, [{
    image: JPEG,
    sequence: 3,
    capturedAt: 0,
  }])
  assert.deepEqual(session.snapshotFrames(), frames)

  now = OBSERVATION_INTERVAL_MS
  for (let sequence = 4; sequence <= OBSERVATION_MAX_FRAMES + 3; sequence += 1) {
    assert.equal(session.frame({ image: JPEG, sequence }), true)
    now += OBSERVATION_INTERVAL_MS
  }
  assert.equal(session.snapshot().frames, OBSERVATION_MAX_FRAMES)
  assert.equal(session.snapshotFrames()[0].sequence, 4)

  session.stop('page_hidden')
  assert.deepEqual(session.snapshot(), {
    state: 'idle',
    frames: 0,
    lastFrameAt: 0,
  })
  assert.deepEqual(gatewayEvents.at(-1), {
    type: 'observation.state',
    state: 'idle',
    frames: 0,
    reason: 'page_hidden',
  })
})

test('does not become active when a consumer preparation step fails', async () => {
  const errors = []
  const session = new ObservationSessionRuntime({
    onError: error => errors.push(error),
  })

  assert.equal(await session.start({
    prepare: async () => {
      throw new Error('consumer_unavailable')
    },
  }), false)
  assert.equal(session.snapshot().state, 'unavailable')
  assert.equal(errors.length, 1)
  assert.equal(errors[0].message, 'consumer_unavailable')
})
