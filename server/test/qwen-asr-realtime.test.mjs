import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'

import { createQwenAsrTranscriber } from '../src/voice/providers/qwen-asr-realtime.mjs'

class FakeSocket extends EventEmitter {
  static OPEN = 1
  readyState = 0
  sent = []
  constructor(url, options) { super(); this.url = url; this.options = options }
  send(value) { this.sent.push(JSON.parse(value)) }
  close() { this.readyState = 3; this.emit('close') }
  open() { this.readyState = 1; this.emit('open') }
  message(value) { this.emit('message', JSON.stringify(value)) }
}

test('uses dedicated credentials and normalizes Qwen ASR partial/final events', () => {
  let socket
  const callbacks = { ready: 0, partial: [], final: [], error: [] }
  const transcriber = createQwenAsrTranscriber({
    apiKey: 'dictation-only',
    baseUrl: 'wss://example.test/realtime',
    model: 'qwen3-asr-flash-realtime',
    WebSocketClass: class extends FakeSocket { constructor(...args) { super(...args); socket = this } },
  })
  transcriber.start({
    ready: () => { callbacks.ready += 1 },
    partial: value => callbacks.partial.push(value),
    final: value => callbacks.final.push(value),
    error: value => callbacks.error.push(value),
  })
  assert.equal(socket.options.headers.Authorization, 'Bearer dictation-only')
  socket.open()
  assert.equal(callbacks.ready, 1)
  assert.deepEqual(socket.sent[0].session.turn_detection, {
    type: 'server_vad', threshold: 0.2, silence_duration_ms: 400,
  })
  transcriber.append('YWJj')
  assert.equal(socket.sent[1].type, 'input_audio_buffer.append')
  socket.message({ type: 'conversation.item.input_audio_transcription.text', text: 'par' })
  socket.message({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'final' })
  assert.deepEqual(callbacks.partial, ['par'])
  assert.deepEqual(callbacks.final, ['final'])
  assert.equal(JSON.stringify(socket.sent).includes('dictation-only'), false)
})

test('pause gates audio without reconnecting the provider session', () => {
  let socket
  const transcriber = createQwenAsrTranscriber({
    apiKey: 'key', baseUrl: 'wss://example.test/realtime',
    WebSocketClass: class extends FakeSocket { constructor(...args) { super(...args); socket = this } },
  })
  transcriber.start({ error: () => {} })
  socket.open()
  transcriber.pause()
  assert.equal(socket.readyState, 1)
  assert.equal(transcriber.resume(), true)
})
