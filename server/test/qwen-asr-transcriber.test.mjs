import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { createQwenAsrTranscriber } from '../src/dictation/qwen-asr-transcriber.mjs'

class FakeWebSocket extends EventEmitter {
  static OPEN = 1
  static instances = []

  constructor(url, options) {
    super()
    this.url = url
    this.options = options
    this.readyState = FakeWebSocket.OPEN
    this.sent = []
    this.closed = false
    FakeWebSocket.instances.push(this)
    queueMicrotask(() => this.emit('open'))
  }

  send(value) {
    this.sent.push(JSON.parse(value))
  }

  close() {
    this.closed = true
    this.readyState = 3
    this.emit('close')
  }

  message(event) {
    this.emit('message', JSON.stringify(event))
  }
}

async function startedTranscriber(callbacks = {}) {
  FakeWebSocket.instances = []
  const transcriber = createQwenAsrTranscriber({
    baseUrl: 'wss://example.test/api-ws/v1/realtime',
    model: 'qwen3-asr-flash-realtime',
    apiKey: 'test-key',
    WebSocketImpl: FakeWebSocket,
    ...callbacks,
  })
  const starting = transcriber.start({ locale: 'zh-CN' })
  await new Promise(resolve => setImmediate(resolve))
  const socket = FakeWebSocket.instances[0]
  socket.message({ type: 'session.updated' })
  await starting
  return { socket, transcriber }
}

test('opens the dedicated Qwen ASR endpoint and configures server VAD', async () => {
  const { socket } = await startedTranscriber()
  assert.equal(
    socket.url,
    'wss://example.test/api-ws/v1/realtime?model=qwen3-asr-flash-realtime',
  )
  assert.deepEqual(socket.options, {
    headers: {
      Authorization: 'Bearer test-key',
      'OpenAI-Beta': 'realtime=v1',
    },
  })
  assert.deepEqual(socket.sent, [{
    type: 'session.update',
    event_id: socket.sent[0].event_id,
    session: {
      modalities: ['text'],
      input_audio_format: 'pcm',
      sample_rate: 16000,
      input_audio_transcription: { language: 'zh' },
      turn_detection: {
        type: 'server_vad',
        threshold: 0,
        silence_duration_ms: 400,
      },
    },
  }])
  assert.match(socket.sent[0].event_id, /^event_/)
})
test('streams audio only while active and maps partial and final events', async () => {
  const deltas = []
  const finals = []
  const { socket, transcriber } = await startedTranscriber({
    onDelta: text => deltas.push(text),
    onFinal: text => finals.push(text),
  })
  transcriber.appendAudio('chunk-one')
  transcriber.pause()
  transcriber.appendAudio('ignored')
  transcriber.resume()
  transcriber.appendAudio('chunk-two')
  socket.message({
    type: 'conversation.item.input_audio_transcription.text',
    transcript: 'par',
  })
  socket.message({
    type: 'conversation.item.input_audio_transcription.completed',
    transcript: 'partial final',
  })

  assert.deepEqual(socket.sent.slice(1).map(event => ({
    type: event.type,
    audio: event.audio,
  })), [
    { type: 'input_audio_buffer.append', audio: 'chunk-one' },
    { type: 'input_audio_buffer.append', audio: 'chunk-two' },
  ])
  assert.deepEqual(deltas, ['par'])
  assert.deepEqual(finals, ['partial final'])
})

test('finishes cleanly or discards immediately on cancel', async () => {
  const first = await startedTranscriber()
  first.transcriber.close({ finish: true })
  assert.equal(first.socket.sent.at(-1).type, 'session.finish')
  assert.equal(first.socket.closed, false)
  first.socket.message({ type: 'session.finished' })
  assert.equal(first.socket.closed, true)

  const second = await startedTranscriber()
  second.transcriber.close({ finish: false })
  assert.equal(second.socket.closed, true)
  assert.equal(
    second.socket.sent.some(event => event.type === 'session.finish'),
    false,
  )
})

test('reports provider errors without constructing a realtime fallback', async () => {
  const errors = []
  const { socket } = await startedTranscriber({
    onError: error => errors.push(error.message),
  })
  socket.message({ type: 'error', error: { message: 'ASR unavailable' } })
  assert.deepEqual(errors, ['ASR unavailable'])
  assert.equal(FakeWebSocket.instances.length, 1)
})
