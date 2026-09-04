import assert from 'node:assert/strict'
import test from 'node:test'
import { ForegroundObservationSink } from '../src/voice/foreground-observation-sink.mjs'

const JPEG = '/9j/fake'

test('forwards a frame through the provider image append protocol', async () => {
  const providerEvents = []
  const sink = new ForegroundObservationSink({
    ensureFrontend: async () => {},
    getFrontend: () => ({
      transportCapabilities: { observationInput: true },
      protocol: {
        imageAppend: image => ({ type: 'provider.image.append', image }),
      },
      send: event => providerEvents.push(event),
    }),
  })

  assert.equal(await sink.prepare(), true)
  assert.equal(sink.forward({ image: JPEG }), true)
  assert.deepEqual(providerEvents, [{
    type: 'provider.image.append',
    image: JPEG,
  }])
  assert.equal(providerEvents.some(event => event.type === 'response.create'), false)
})

test('fails closed when the frontend does not advertise observation', async () => {
  const errors = []
  const sink = new ForegroundObservationSink({
    getFrontend: () => ({
      transportCapabilities: { observationInput: false },
      send() {},
    }),
    onError: error => errors.push(error),
  })

  await assert.rejects(
    sink.prepare(),
    /当前 Realtime 模型不支持画面观察/,
  )
  assert.equal(sink.active, false)
  assert.equal(errors.length, 0)
})
