import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { ProcessWebRtcMedia } from '../src/transport/webrtc/media-process.mjs'

class FakeChild extends EventEmitter {
  connected = true
  messages = []
  hang = false
  send(message, callback) {
    this.messages.push(message)
    queueMicrotask(() => {
      callback?.(null)
      if (message.type === 'init') this.emit('message', { type: 'ready' })
      if (message.type === 'answer' && !this.hang) this.emit('message', { type: 'answer', id: message.id, sdp: 'test-answer' })
      if (message.type === 'close' && !this.hang) {
        this.emit('message', { type: 'closed' })
        this.connected = false
        this.emit('close', 0, null)
      }
    })
    return true
  }
  kill(signal) { this.connected = false; this.emit('close', null, signal) }
}

test('media worker receives only transport options and a minimal environment', async () => {
  const child = new FakeChild()
  let spawnOptions
  const media = new ProcessWebRtcMedia({
    forkProcess: (_file, _args, options) => { spawnOptions = options; return child },
    video: true, inputSampleRate: 16000,
  })
  assert.equal(Object.hasOwn(spawnOptions.env, 'DASHSCOPE_API_KEY'), false)
  assert.equal(Object.hasOwn(spawnOptions.env, 'NODE_OPTIONS'), false)
  assert.deepEqual(spawnOptions.execArgv, [])
  assert.deepEqual(child.messages[0].options, { iceServers: [], iceTransportPolicy: 'all', video: true, videoOutput: false, inputSampleRate: 16000 })
  assert.equal(await media.answer('offer'), 'test-answer')
  let opened = 0
  media.onOpen = () => { opened++ }
  child.emit('message', { type: 'open' })
  child.emit('message', { type: 'open' })
  assert.equal(opened, 1)
  assert.equal(media.connected(), true)
  media.inputSampleRate = 24000
  assert.deepEqual(child.messages.at(-1), { type: 'rate', value: 24000 })
  const first = media.close()
  assert.equal(media.close(), first)
  assert.deepEqual(await first, { code: 0, signal: null, graceful: true, acknowledged: true, forced: false })
})

test('native process crash rejects negotiation and notifies only once', async () => {
  const child = new FakeChild()
  child.hang = true
  const diagnostics = []
  const media = new ProcessWebRtcMedia({ forkProcess: () => child, onDiagnostic: event => diagnostics.push(event) })
  let closed = 0
  media.onClose = () => { closed++; media.close() }
  const answer = media.answer('offer')
  const rejection = assert.rejects(answer, error => error.code === 'media_worker_exited')
  await media.initialized
  child.emit('close', null, 'SIGSEGV')
  await rejection
  const exit = await media.whenClosed()
  assert.equal(exit.graceful, false)
  assert.equal(exit.signal, 'SIGSEGV')
  assert.equal(closed, 1)
  assert.equal(diagnostics.length, 1)
})

test('shutdown requires acknowledgement and a clean exit, not merely process termination', async () => {
  const child = new FakeChild()
  child.hang = true
  const diagnostics = []
  const media = new ProcessWebRtcMedia({ forkProcess: () => child, shutdownTimeoutMs: 20, onDiagnostic: event => diagnostics.push(event) })
  await media.initialized
  const exit = await media.close()
  assert.equal(exit.forced, true)
  assert.equal(exit.acknowledged, false)
  assert.equal(exit.graceful, false)
  assert.equal(exit.signal, 'SIGKILL')
  assert.equal(diagnostics.length, 1)
})

test('callbacks from an exited child cannot revive a connection', async () => {
  const child = new FakeChild()
  const media = new ProcessWebRtcMedia({ forkProcess: () => child })
  await media.initialized
  await media.close()
  let events = 0
  media.onAudio = () => { events++ }
  media.onOpen = () => { events++ }
  child.emit('message', { type: 'open' })
  child.emit('message', { type: 'audio', data: 'AAAA' })
  assert.equal(events, 0)
  assert.equal(media.connected(), false)
})

test('avatar control forwards to the worker and media events surface via onDhEvent', async () => {
  const child = new FakeChild()
  const media = new ProcessWebRtcMedia({
    forkProcess: () => child,
    videoOutput: true,
    digitalHuman: { modulePath: '/abs/adapter.mjs', adapterOptions: { connectTimeoutMs: 5000 } },
  })
  await media.initialized
  assert.equal(child.messages[0].options.videoOutput, true)
  const binding = { protocol: 'dhav', protocolVersion: 1, media: { url: 'wss://renderer/media', token: 'scoped' } }
  media.dhOpen(binding)
  assert.deepEqual(child.messages.at(-1), { type: 'dh.open', binding, adapterModulePath: '/abs/adapter.mjs', adapterOptions: { connectTimeoutMs: 5000 } })
  const turn = { avatarSessionId: 'av1', responseId: 'r1', generation: 0 }
  media.dhBegin(turn, { sampleRate: 24000 })
  assert.deepEqual(child.messages.at(-1), { type: 'dh.begin', turn, format: { sampleRate: 24000 } })
  // An idle turn is flagged so the worker publishes its frames directly.
  media.dhBegin(turn, { sampleRate: 24000 }, true)
  assert.deepEqual(child.messages.at(-1), { type: 'dh.begin', turn, format: { sampleRate: 24000 }, idle: true })
  media.dhFinish(turn)
  assert.deepEqual(child.messages.at(-1), { type: 'dh.finish', turn })
  media.dhClear(1)
  assert.deepEqual(child.messages.at(-1), { type: 'dh.clear', generation: 1 })
  // A pre-commit renderer fallback keeps the response's plain-audio egress open.
  media.dhClear(1, false)
  assert.deepEqual(child.messages.at(-1), { type: 'dh.clear', generation: 1, block: false })
  media.dhClear(1, true)
  assert.deepEqual(child.messages.at(-1), { type: 'dh.clear', generation: 1 })
  media.dhClose()
  assert.deepEqual(child.messages.at(-1), { type: 'dh.close' })
  const received = []
  media.onDhEvent = payload => received.push(payload)
  child.emit('message', { type: 'dh', op: 'first_media', responseId: 'r1', generation: 0 })
  child.emit('message', { type: 'dh', op: 'drained', responseId: 'r1', generation: 0 })
  assert.deepEqual(received, [
    { type: 'dh', op: 'first_media', responseId: 'r1', generation: 0 },
    { type: 'dh', op: 'drained', responseId: 'r1', generation: 0 },
  ])
  await media.close()
})
