import assert from 'node:assert/strict'
import test from 'node:test'
import { doubaoSeeduplexProvider } from '../src/voice/providers/doubao-seeduplex.mjs'
import {
  createDoubaoSeeduplexProtocol,
  pcmFloat32Base64ToPcm16,
} from '../src/voice/providers/doubao-seeduplex-protocol.mjs'

function float32Base64(samples) {
  const bytes = Buffer.alloc(samples.length * 4)
  samples.forEach((sample, index) => bytes.writeFloatLE(sample, index * 4))
  return bytes.toString('base64')
}

test('Doubao Seeduplex provider builds the documented session shape', () => {
  const session = doubaoSeeduplexProvider.buildSession({
    agentContext: {},
    sessionOptions: { voice: 'test-voice' },
  })

  assert.equal(session.model, '1.2.6.1')
  assert.equal(session.audio.input.format.type, 'pcm')
  assert.equal(session.audio.input.format.rate, 16000)
  assert.equal(session.audio.output.format.type, 'pcm')
  assert.equal(session.audio.output.format.rate, 24000)
  assert.equal(session.audio.output.voice, 'test-voice')
  assert.ok(session.tools.every(tool => tool.type === 'function' && tool.name))
})

test('Doubao Seeduplex protocol emits session.create and audio append events', () => {
  const protocol = createDoubaoSeeduplexProtocol()
  assert.deepEqual(protocol.connectionMessages({
    session: { model: '1.2.6.1' },
  }), [{
    type: 'session.create',
    session: { model: '1.2.6.1' },
  }])
  assert.deepEqual(protocol.audioAppend('AAAA'), {
    type: 'input_audio_buffer.append',
    audio: 'AAAA',
  })
  assert.deepEqual(protocol.responseCancel(), { type: 'response.cancel' })
  assert.deepEqual(protocol.inputMute(), { type: 'input_audio_mute.commit' })
  assert.deepEqual(protocol.inputUnmute(), { type: 'input_audio_unmute.commit' })
})

test('Doubao Seeduplex protocol normalizes text, audio and completion events', () => {
  const protocol = createDoubaoSeeduplexProtocol()

  const text = protocol.normalizeIncoming({
    type: 'response.output_text.delta',
    text: '你好',
  })
  assert.equal(text[0].type, 'response.created')
  assert.match(text[0].response.id, /^response_/u)
  assert.deepEqual(text[1], {
    type: 'response.text.delta',
    response_id: text[0].response.id,
    delta: '你好',
    text: '你好',
  })

  const audio = protocol.normalizeIncoming({
    type: 'response.output_audio.delta',
    audio: float32Base64([-1, -0.5, 0, 0.5, 1]),
  })
  assert.equal(audio[0].type, 'response.output_audio.delta')
  assert.equal(audio[0].response_id, text[0].response.id)
  assert.equal(audio[0].sampleRate, 24000)
  const pcm = Buffer.from(audio[0].delta, 'base64')
  assert.deepEqual(
    Array.from({ length: 5 }, (_, index) => pcm.readInt16LE(index * 2)),
    [-32768, -16384, 0, 16384, 32767],
  )
})

test('Doubao Seeduplex Float32 PCM conversion rejects partial samples', () => {
  assert.throws(
    () => pcmFloat32Base64ToPcm16(Buffer.alloc(3).toString('base64')),
    /Float32 PCM/,
  )
})

test('Doubao Seeduplex protocol expands function-call item arrays', () => {
  const protocol = createDoubaoSeeduplexProtocol()
  const events = protocol.normalizeIncoming({
    type: 'response.function_call_arguments.done',
    items: [
      { call_id: 'call_1', name: 'get_current_time', arguments: '{"timezone":"Asia/Shanghai"}' },
    ],
  })

  assert.equal(events[0].type, 'response.created')
  assert.deepEqual(events[1], {
    type: 'response.function_call_arguments.done',
    response_id: events[0].response.id,
    call_id: 'call_1',
    name: 'get_current_time',
    arguments: '{"timezone":"Asia/Shanghai"}',
  })

  const done = protocol.normalizeIncoming({ type: 'response.done' })
  assert.deepEqual(done, [{
    type: 'response.done',
    response_id: events[0].response.id,
    response: { id: events[0].response.id, status: 'completed' },
  }])
})

test('Doubao Seeduplex translates ASR transcription events for the Gateway input pipeline', () => {
  const protocol = createDoubaoSeeduplexProtocol()

  const started = protocol.normalizeIncoming({
    type: 'conversation.item.input_audio_transcription.started',
    item_id: 'item_asr_1',
    event_id: 'event_1',
  })
  assert.deepEqual(started, [{
    type: 'input_audio_buffer.speech_started',
    item_id: 'item_asr_1',
    event_id: 'event_1',
  }])

  const delta = protocol.normalizeIncoming({
    type: 'conversation.item.input_audio_transcription.delta',
    item_id: 'item_asr_1',
    delta: '你好',
  })
  assert.equal(delta[0].type, 'conversation.item.input_audio_transcription.delta')
  assert.equal(delta[0].text, '')
  assert.equal(delta[0].stash, '你好')

  const completed = protocol.normalizeIncoming({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'item_asr_1',
    text: '你好世界',
  })
  assert.equal(completed[0].type, 'conversation.item.input_audio_transcription.completed')
  assert.equal(completed[0].transcript, '你好世界')
})

test('Doubao Seeduplex reuses the active ASR item id when delta and completed omit it', () => {
  const protocol = createDoubaoSeeduplexProtocol()

  protocol.normalizeIncoming({
    type: 'conversation.item.input_audio_transcription.started',
    item_id: 'item_asr_9',
  })

  const delta = protocol.normalizeIncoming({
    type: 'conversation.item.input_audio_transcription.delta',
    delta: 'partial',
  })
  assert.equal(delta[0].item_id, 'item_asr_9')
  assert.equal(delta[0].stash, 'partial')

  const completed = protocol.normalizeIncoming({
    type: 'conversation.item.input_audio_transcription.completed',
    transcript: 'final text',
  })
  assert.equal(completed[0].item_id, 'item_asr_9')
  assert.equal(completed[0].transcript, 'final text')
})

test('Doubao Seeduplex synthesizes a speech_started item id and leaves response events untouched', () => {
  const protocol = createDoubaoSeeduplexProtocol()

  const started = protocol.normalizeIncoming({
    type: 'conversation.item.input_audio_transcription.started',
  })
  assert.equal(started[0].type, 'input_audio_buffer.speech_started')
  assert.match(started[0].item_id, /^item_/u)

  const text = protocol.normalizeIncoming({
    type: 'response.output_text.delta',
    text: 'hi',
  })
  assert.equal(text[0].type, 'response.created')
  assert.equal(text[1].type, 'response.text.delta')
  assert.equal(text[1].delta, 'hi')
})
