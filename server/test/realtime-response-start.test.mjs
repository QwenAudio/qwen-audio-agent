import assert from 'node:assert/strict'
import test from 'node:test'
import { config } from '../src/core/config.mjs'
import { RealtimeFrontend, REALTIME_PROVIDERS } from '../src/voice/realtime-provider.mjs'
import {
  DASHSCOPE_AUDIO_30_REALTIME_MODEL,
  DASHSCOPE_AUDIO_31_REALTIME_MODEL,
  DASHSCOPE_AUDIO_31_FLASH_REALTIME_MODEL,
  DASHSCOPE_AUDIO_FLASH_REALTIME_MODEL,
  DASHSCOPE_OMNI_FLASH_REALTIME_MODEL,
} from '../../shared/realtime-provider-catalog.mjs'

function harness(t, model = DASHSCOPE_AUDIO_30_REALTIME_MODEL) {
  const previous = { audioProvider: config.audioProvider, realtimeModel: config.realtimeModel }
  Object.assign(config, { audioProvider: 'dashscope', realtimeModel: model })
  const events = []
  const frontend = new RealtimeFrontend({
    provider: REALTIME_PROVIDERS.dashscope,
    onEvent: event => events.push(event),
  })
  frontend.ready = true
  frontend.sessionConfigured = true
  frontend.send = () => {}
  t.after(() => {
    frontend.close()
    Object.assign(config, previous)
  })
  const receive = event => frontend.handleProviderEvent(event)
  const start = id => receive({ type: 'response.created', response: { id } })
  const done = (id, status = 'completed') => receive({ type: 'response.done', response: { id, status } })
  const final = (id, type = 'response.audio_transcript.done') => receive({
    type, response_id: id, transcript: 'answer', text: 'answer',
  })
  return { frontend, events, receive, start, done, final }
}

for (const model of [
  DASHSCOPE_AUDIO_30_REALTIME_MODEL, DASHSCOPE_AUDIO_31_REALTIME_MODEL,
  DASHSCOPE_AUDIO_31_FLASH_REALTIME_MODEL, DASHSCOPE_AUDIO_FLASH_REALTIME_MODEL,
]) {
  test(`${model}: rejects early output without hiding input or control errors`, t => {
    const h = harness(t, model)
    for (const type of [
      'response.audio.delta', 'response.audio_transcript.delta', 'response.audio_transcript.done',
      'response.function_call_arguments.done', 'response.done',
    ]) {
      assert.deepEqual(h.receive({ type, response_id: 'early' }), [])
    }
    assert.equal(h.frontend.activeResponses.size, 0)
    for (const event of [
      { type: 'input_audio_buffer.speech_started', item_id: 'input' },
      { type: 'error', error: { message: 'test control error' } },
    ]) assert.deepEqual(h.receive(event), [event])
    h.start('early')
    assert.equal(h.final('early').length, 1)
  })
}

test('Omni keeps its implicit response-start behavior', t => {
  const h = harness(t, DASHSCOPE_OMNI_FLASH_REALTIME_MODEL)
  assert.equal(h.frontend.capabilities.requiresResponseCreated, false)
  assert.equal(h.receive({
    type: 'response.audio_transcript.delta', response_id: 'implicit', delta: 'hello',
  }).length, 1)
  assert.equal(h.frontend.activeResponses.has('implicit'), true)
})

for (const type of [
  'response.audio_transcript.done', 'response.output_audio_transcript.done',
  'response.text.done', 'response.output_text.done',
]) {
  test(`one late ${type} is presentation-only`, t => {
    const h = harness(t)
    h.start('old')
    h.done('old')
    h.frontend.responseSlot.occupy()
    for (const type of ['response.audio.delta', 'response.function_call_arguments.done']) {
      assert.deepEqual(h.receive({ type, response_id: 'old' }), [])
    }
    assert.equal(h.final('old', type).length, 1)
    assert.equal(h.frontend.activeResponses.size, 0)
    assert.equal(h.frontend.responseSlot.phase, 'pending')
    assert.deepEqual(h.final('old', type), [], 'a duplicate final cannot reopen presentation')
    assert.deepEqual(h.done('old'), [], 'a duplicate done cannot release the new slot')
    assert.equal(h.frontend.responseSlot.phase, 'pending')
  })
}

test('a final received before response.done leaves no late-final permission', t => {
  const h = harness(t)
  h.start('finished')
  h.final('finished')
  h.done('finished')
  assert.deepEqual(h.final('finished'), [])
  assert.equal(h.frontend.activeResponses.size, 0)
})

for (const status of ['failed', 'cancelled', 'incomplete']) {
  test(`${status} responses cannot be revived by a final transcript`, t => {
    const h = harness(t)
    h.start('failed')
    h.done('failed', status)
    assert.deepEqual(h.final('failed'), [])
  })
}

test('local cancellation and response errors discard late-final permission', t => {
  const h = harness(t)
  h.start('cancelled')
  h.frontend.cancel()
  h.done('cancelled')
  assert.deepEqual(h.final('cancelled'), [])
  h.start('errored')
  h.receive({ type: 'error', error: { message: 'test response error' } })
  assert.equal(h.frontend.activeResponses.size, 0)
  assert.deepEqual(h.final('errored'), [])
})

test('late-final bookkeeping is bounded and cleared with the connection', t => {
  const h = harness(t)
  for (let index = 0; index <= 100; index += 1) {
    h.start(`response-${index}`)
    h.done(`response-${index}`)
  }
  assert.deepEqual(h.final('response-0'), [])
  assert.equal(h.final('response-100').length, 1)
  h.frontend.resetResponses()
  assert.deepEqual(h.final('response-99'), [])
  assert.equal(h.frontend.activeResponses.size, 0)
})
