import test from 'node:test'
import assert from 'node:assert/strict'
import { AvatarPlaybackController } from '../client/avatar-playback.mjs'
import { createBrowserAvatarPlayer } from '../client/browser-avatar-player.mjs'
import { createDhavRenderer } from '../client/renderers/dhav.mjs'
import { encodePairedAv, encodeMediaEnd } from '../protocol/dhav.mjs'

const pcm = Buffer.from([1, 0, 2, 0]).toString('base64')
const delta = (responseId = 'a', audio = pcm) => ({ type: 'audio.delta', responseId, audio, sampleRate: 24000 })
const done = (responseId = 'a') => ({ type: 'audio.done', responseId })
function clock() {
  let next = 0
  const timers = new Map()
  return { timers, setTimer: callback => { timers.set(++next, callback); return next },
    clearTimer: id => timers.delete(id), run: () => { const pending = [...timers.values()]; timers.clear(); pending.forEach(fn => fn()) } }
}
function fakePlayer() {
  return { calls: [], callback: null, begin(key, callback) { this.key = key; this.callback = callback; this.calls.push(['begin', key]) },
    append(key, media) { this.calls.push(['append', key, media]) }, end(key) { this.calls.push(['end', key]) },
    clear(key) { this.calls.push(['clear', key]) } }
}
function setup(options = {}) {
  const receipts = []
  const timings = clock()
  // Deliberately RTC-like: no DHAV messages, session IDs or PCM output.
  const renderer = {
    calls: [], callbacks: null,
    startTurn(turn, callbacks) { this.turn = turn; this.callbacks = callbacks; this.calls.push(['start', turn]) },
    appendAudio(turn, audio) { this.calls.push(['append', turn, audio]) },
    endTurn(turn) { this.calls.push(['end', turn]) },
    cancelTurn(turn, reason) { this.calls.push(['cancel', turn, reason]) },
  }
  const player = fakePlayer()
  const controller = new AvatarPlaybackController({ renderer, fallbackPlayer: player, sendGateway: event => receipts.push(event), ...timings, ...options })
  return { controller, renderer, player, receipts, timings }
}

test('existing GCP audio events complete only after actual playback, with no model terminal event', () => {
  const { controller, renderer, receipts, timings } = setup()
  controller.handleGateway({ type: 'response.started', responseId: 'a' })
  controller.handleGateway({ type: 'transcript.delta', responseId: 'a', text: 'hello' })
  assert.equal(renderer.calls.length, 0)
  controller.handleGateway(delta())
  assert.deepEqual(renderer.calls.map(call => call[0]), ['start', 'append'])
  controller.handleGateway(done())
  assert.deepEqual(receipts, [])
  renderer.callbacks.onStarted()
  assert.deepEqual(receipts.map(event => event.type), ['playback.started'])
  assert.equal(controller.bufferedBytes, 0)
  renderer.callbacks.onDrained()
  renderer.callbacks.onDrained()
  assert.deepEqual(receipts.map(event => event.type), ['playback.started', 'playback.ended'])
  assert.equal(timings.timers.size, 0)
})

test('queues independent audio responses until actual drain; text-only responses do not preempt', () => {
  const { controller, renderer, receipts } = setup()
  controller.handleGateway(delta('a'))
  const a = renderer.callbacks
  controller.handleGateway({ type: 'response.started', responseId: 'text-only' })
  controller.handleGateway(delta('b'))
  controller.handleGateway(done('b'))
  assert.equal(renderer.calls.filter(call => call[0] === 'start').length, 1)
  controller.handleGateway(done('a'))
  a.onStarted()
  a.onDrained()
  assert.equal(renderer.turn.responseId, 'b')
  assert.deepEqual(renderer.calls.slice(-3).map(call => call[0]), ['start', 'append', 'end'])
  a.onStarted()
  assert.equal(receipts.length, 2)
  controller.close()
})

test('existing global clear fences late source, media callbacks and queued turns even with an extra id', () => {
  const { controller, renderer, receipts } = setup()
  controller.handleGateway(delta('a'))
  const stale = renderer.callbacks
  controller.handleGateway(delta('b'))
  controller.handleGateway({ type: 'response.started', responseId: 'not-yet-audio' })
  controller.handleGateway({ type: 'playback.clear', responseId: 'b' })
  assert.equal(controller.records.size, 0)
  controller.handleGateway({ type: 'playback.clear' })
  stale.onStarted()
  stale.onDrained()
  controller.handleGateway(delta('a'))
  controller.handleGateway(delta('b'))
  controller.handleGateway(delta('not-yet-audio'))
  assert.equal(renderer.calls.filter(call => call[0] === 'start').length, 1)
  assert.deepEqual(receipts.map(event => [event.type, event.responseId]), [['playback.cancelled', 'a'], ['playback.cancelled', 'b']])
  controller.handleGateway(delta('new'))
  assert.equal(renderer.turn.responseId, 'new')
  controller.close()
})

test('existing response.interrupted cancels only the matching response', () => {
  const { controller, renderer, receipts } = setup()
  controller.handleGateway(delta('a'))
  controller.handleGateway(delta('b'))
  controller.handleGateway({ type: 'response.interrupted', responseId: 'b' })
  assert.equal(renderer.turn.responseId, 'a')
  renderer.callbacks.onStarted()
  controller.handleGateway({ type: 'response.interrupted', responseId: 'a' })
  assert.deepEqual(receipts.map(e => e.type), ['playback.cancelled', 'playback.started', 'playback.cancelled'])
  assert.equal(controller.records.size, 0)
})

test('generic Gateway errors do not guess model status; authoritative global clear cancels playback', () => {
  const { controller, renderer, receipts } = setup()
  controller.handleGateway(delta())
  const callbacks = renderer.callbacks
  controller.handleGateway({ type: 'error', responseId: 'a', message: 'backend tool failed' })
  controller.handleGateway({ type: 'response.done', response: { id: 'a', status: 'failed' } })
  assert.equal(controller.active.id, 'a')
  assert.deepEqual(receipts, [])
  callbacks.onStarted()
  controller.handleGateway({ type: 'playback.clear', reason: 'provider_content_safety' })
  callbacks.onDrained()
  assert.deepEqual(receipts.map(event => event.type), ['playback.started', 'playback.cancelled'])
  assert.equal(receipts.at(-1).reason, 'provider_content_safety')
})

test('current listening state stops all audio for barge-in; stale model state is ignored', () => {
  const { controller, renderer, receipts } = setup()
  controller.handleGateway({ type: 'turn.started', turnId: 'current' })
  controller.handleGateway(delta('a'))
  const callbacks = renderer.callbacks
  controller.handleGateway(delta('b'))
  controller.handleGateway({ type: 'voice.state', state: 'listening', turnId: 'previous', origin: 'model' })
  assert.equal(controller.records.size, 2)
  controller.handleGateway({ type: 'voice.state', state: 'listening', turnId: 'current' })
  callbacks.onStarted()
  callbacks.onDrained()
  assert.deepEqual(receipts.map(event => [event.type, event.responseId, event.reason]), [
    ['playback.cancelled', 'a', 'user_interruption'], ['playback.cancelled', 'b', 'user_interruption'],
  ])
  assert.equal(controller.records.size, 0)
})

test('pre-playback renderer failure falls back once and fences the failed renderer', () => {
  const { controller, renderer, player, receipts } = setup()
  controller.handleGateway(delta())
  const stale = renderer.callbacks
  stale.onError(new Error('not available'))
  assert.deepEqual(player.calls.map(call => call[0]), ['begin', 'append'])
  assert.deepEqual(receipts, [])
  stale.onStarted()
  stale.onDrained()
  stale.onError(new Error('again'))
  controller.handleGateway(delta())
  controller.handleGateway(done())
  assert.equal(player.calls.filter(call => call[0] === 'append').length, 2)
  player.callback.onStarted()
  player.callback.onDrained()
  assert.deepEqual(receipts.map(e => e.type), ['playback.started', 'playback.ended'])
})

test('postcommit error never replays source; cancel flushes a delayed start before fallback decision', () => {
  const { controller, renderer, player, receipts } = setup()
  controller.handleGateway(delta())
  renderer.cancelTurn = () => renderer.callbacks.onStarted()
  renderer.callbacks.onError(new Error('media lost'))
  assert.equal(player.calls.length, 0)
  assert.deepEqual(receipts.map(e => e.type), ['playback.started', 'playback.cancelled'])
})

test('bounded source and queue; timeout fallback is cancelled on close without resurrection', () => {
  const { controller, renderer, player, receipts, timings } = setup({ maxBufferedBytes: 4, maxPendingResponses: 1 })
  controller.handleGateway(delta())
  controller.handleGateway(delta('b'))
  assert.equal(controller.records.size, 1)
  timings.run()
  assert.equal(player.calls[0][0], 'begin')
  const stale = player.callback
  controller.close()
  stale.onStarted()
  stale.onDrained()
  controller.handleGateway(delta('c'))
  assert.equal(renderer.calls.filter(c => c[0] === 'start').length, 1)
  assert.equal(receipts.at(-1).type, 'playback.cancelled')
  assert.equal(controller.bufferedBytes, 0)
  assert.equal(timings.timers.size, 0)
})

test('source overflow cancels and audio.done without audio never creates a renderer turn', () => {
  const { controller, renderer, receipts } = setup({ maxBufferedBytes: 4 })
  controller.handleGateway(done('none'))
  controller.handleGateway(delta('none'))
  assert.equal(renderer.calls.length, 0)
  controller.handleGateway(delta())
  controller.handleGateway(delta())
  assert.equal(receipts.at(-1).reason, 'source_buffer_limit')
  assert.equal(controller.records.size, 0)
})

test('invalid PCM, unsupported rate and queue overflow cancel once without fictional playback', () => {
  const { controller, receipts } = setup({ maxPendingResponses: 1 })
  controller.handleGateway({ type: 'playback.clear', responseId: 'unknown' })
  assert.deepEqual(receipts, [])
  controller.handleGateway(delta('invalid', 'not-pcm'))
  controller.handleGateway(delta('invalid', 'not-pcm'))
  controller.handleGateway({ ...delta('rate'), sampleRate: 48000 })
  controller.handleGateway({ ...delta('rate'), sampleRate: 48000 })
  controller.handleGateway(delta('a'))
  controller.handleGateway(delta('overflow'))
  controller.handleGateway(delta('overflow'))
  assert.deepEqual(receipts.map(event => [event.type, event.responseId]), [
    ['playback.cancelled', 'invalid'], ['playback.cancelled', 'rate'], ['playback.cancelled', 'overflow'],
  ])
  controller.close()
})

test('renderer disconnection before playback degrades once; further renderer events cannot commit', () => {
  const { controller, renderer, player, receipts } = setup()
  controller.handleGateway(delta())
  const stale = renderer.callbacks
  controller.rendererDisconnected()
  controller.rendererDisconnected()
  stale.onStarted()
  assert.deepEqual(receipts, [])
  assert.equal(player.calls.filter(call => call[0] === 'begin').length, 1)
  controller.handleGateway(done())
  player.callback.onStarted()
  player.callback.onDrained()
  assert.deepEqual(receipts.map(event => event.type), ['playback.started', 'playback.ended'])
})

function audioSetup() {
  const timings = clock()
  const sources = []
  const context = { state: 'running', currentTime: 0, destination: {},
    createBuffer(channels, length, rate) { const samples = new Float32Array(length); return { duration: length / rate, getChannelData: () => samples } },
    createBufferSource() {
      const source = { connect(target) { this.target = target }, disconnect() {}, start(at) { this.at = at },
        stop() { this.stopped = true; this.onended?.() } }
      sources.push(source)
      return source
    } }
  const painted = []
  const canvas = { getContext: () => ({ createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: data => painted.push(data) }) }
  const player = createBrowserAvatarPlayer({ audioContext: context, canvas, ...timings })
  return { player, context, sources, painted, timings }
}
const video = { format: 'i420', width: 2, height: 2, data: Uint8Array.of(100, 100, 100, 100, 128, 128) }
test('real player uses shared audio clock, direct output and actual source drain', () => {
  const { player, context, sources, painted, timings } = audioSetup()
  const events = []
  player.begin('a', { onStarted: () => events.push('start'), onDrained: () => events.push('end') })
  player.append('a', { audio: Uint8Array.of(1, 0, 2, 0), sampleRate: 24000, video })
  player.end('a')
  assert.deepEqual(events, [])
  assert.equal(sources[0].target, context.destination)
  assert.equal(painted.length, 0)
  context.currentTime = 0.02
  timings.run()
  assert.deepEqual(events, ['start'])
  assert.equal(painted.length, 1)
  context.currentTime = 0.03
  sources[0].onended()
  assert.deepEqual(events, ['start', 'end'])
  assert.equal(timings.timers.size, 0)
})

test('player clear fences queued onended, flushes elapsed start, and never reports drain', () => {
  const { player, context, sources, timings } = audioSetup()
  const events = []
  player.begin('a', { onStarted: () => events.push('start'), onDrained: () => events.push('end') })
  player.append('a', { audio: Uint8Array.of(1, 0), sampleRate: 24000 })
  const late = sources[0].onended
  context.currentTime = 0.021
  player.clear('a')
  late()
  timings.run()
  assert.equal(sources[0].stopped, true)
  assert.deepEqual(events, ['start'])
  assert.equal(timings.timers.size, 0)
})

test('clear after audio clock progressed then suspended preserves actual start before cancellation', () => {
  const { player, context } = audioSetup()
  const events = []
  player.begin('a', { onStarted: () => events.push('start'), onDrained: () => events.push('end') })
  player.append('a', { audio: Uint8Array.of(1, 0) })
  context.currentTime = 0.03
  context.state = 'suspended'
  player.clear('a')
  assert.deepEqual(events, ['start'])
})

test('first-render timeout with a paused AudioContext cancels; fallback cannot stick or claim delivery', () => {
  const audio = audioSetup()
  const { controller, receipts, timings } = setup({ fallbackPlayer: audio.player })
  controller.handleGateway(delta())
  audio.context.state = 'suspended'
  timings.run()
  assert.deepEqual(receipts.map(event => event.type), ['playback.cancelled'])
  assert.match(receipts[0].reason, /not running/)
  assert.equal(controller.records.size, 0)
  assert.equal(controller.bufferedBytes, 0)
  assert.equal(timings.timers.size, 0)
  assert.equal(audio.timings.timers.size, 0)
})

test('fallback suspended after scheduling is cancelled on the next tick instead of polling forever', () => {
  const audio = audioSetup()
  const { controller, renderer, receipts } = setup({ fallbackPlayer: audio.player })
  controller.handleGateway(delta())
  renderer.callbacks.onError(new Error('offline'))
  assert.equal(audio.sources.length, 1)
  audio.context.state = 'suspended'
  audio.timings.run()
  assert.deepEqual(receipts.map(event => event.type), ['playback.cancelled'])
  assert.equal(audio.sources[0].stopped, true)
  assert.equal(controller.records.size, 0)
  assert.equal(audio.timings.timers.size, 0)
})

test('suspended clock and silent placeholder cannot synthesize successful playback', () => {
  const { player, context, sources, timings } = audioSetup()
  const events = []
  player.begin('a', { onStarted: () => events.push('start'), onError: () => events.push('error') })
  context.state = 'suspended'
  assert.throws(() => player.append('a', { audio: Uint8Array.of(1, 0) }), /not running/)
  context.state = 'running'
  player.append('a', { audio: Uint8Array.of(0, 0), receiptEligible: false })
  player.end('a')
  context.currentTime = 1
  sources[0].onended()
  timings.run()
  assert.deepEqual(events, ['error'])
})

test('actual player bounds queued media and rejects late chunks after end', () => {
  const { player, sources } = audioSetup()
  player.begin('a', {})
  assert.throws(() => player.append('a', { audio: new Uint8Array(24000 * 2 * 11) }), /buffer limit/)
  player.append('a', { audio: Uint8Array.of(1, 0) })
  player.end('a')
  player.append('a', { audio: Uint8Array.of(1, 0) })
  assert.equal(sources.length, 1)
  player.clear('a')
})

function dhavSetup() {
  const timings = clock()
  const player = fakePlayer()
  const sent = []
  const callbacks = []
  const adapter = createDhavRenderer({ player, sendRenderer: event => sent.push(event), ...timings })
  adapter.handleMessage({ type: 'session.ready', avatarSessionId: 'session' })
  const turn = { responseId: 'a', generation: 1 }
  adapter.startTurn(turn, { onStarted: () => callbacks.push('start'), onDrained: () => callbacks.push('drain'), onError: e => callbacks.push(e.message) })
  const wireTurn = { ...turn, avatarSessionId: 'session' }
  const frame = (changes = {}) => encodePairedAv({ turn: wireTurn, sequence: 0, ptsUs: 0, durationUs: 1000,
    sampleOffset: 0, samples: 2, video: { ...video, data: Buffer.from(video.data) }, audio: Buffer.from([1, 0, 2, 0]), ...changes })
  return { adapter, player, sent, callbacks, turn, wireTurn, frame, timings }
}

test('DHAV adapter owns wire protocol, matches identity/generation and completes only at actual drain', () => {
  const { adapter, player, sent, callbacks, turn, wireTurn, frame, timings } = dhavSetup()
  adapter.appendAudio(turn, pcm)
  adapter.endTurn(turn)
  assert.deepEqual(sent.map(e => e.type), ['turn.start', 'audio.append', 'audio.end'])
  adapter.handleMessage(frame({ turn: { ...wireTurn, generation: 0 } }))
  adapter.handleMessage(frame({ turn: { ...wireTurn, avatarSessionId: 'stale' } }))
  assert.equal(player.calls.length, 1)
  adapter.handleMessage(frame())
  adapter.handleMessage(frame())
  assert.equal(player.calls.filter(c => c[0] === 'append').length, 1)
  adapter.handleMessage(encodeMediaEnd({ turn: wireTurn, lastSequence: 0 }))
  assert.deepEqual(callbacks, [])
  player.callback.onStarted()
  player.callback.onDrained()
  assert.deepEqual(callbacks, ['start', 'drain'])
  assert.equal(timings.timers.size, 0)
})

test('DHAV synthetic silence is excluded, sequence gaps fail, cancellation quarantines stale records', () => {
  const { adapter, player, callbacks, turn, frame, timings } = dhavSetup()
  adapter.handleMessage(frame({ silence: true, paddingSamples: 2 }))
  assert.equal(player.calls.length, 1)
  adapter.handleMessage(frame({ sequence: 2 }))
  assert.match(callbacks.at(-1), /discontinuity/)
  adapter.cancelTurn(turn, 'interrupted')
  adapter.handleMessage(frame({ sequence: 1 }))
  assert.equal(player.calls.filter(c => c[0] === 'append').length, 0)
  assert.equal(timings.timers.size, 0)
})
