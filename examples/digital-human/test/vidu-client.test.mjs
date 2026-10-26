import test from 'node:test'
import assert from 'node:assert/strict'
import { createSourcePlayback } from '../client/source-playback.mjs'
import { createViduController } from '../client/renderers/vidu.mjs'
import { createArtcPlayer } from '../client/renderers/artc-player.mjs'

const tick = () => new Promise(resolve => setImmediate(resolve))
const pcm = Buffer.from([0, 0, 0, 64, 0, 192, 0, 32]).toString('base64')
function fixture({ audible = false } = {}) {
  const receipts = [], statuses = [], nodes = [], jobs = [], sent = [], failures = [], gains = []
  const context = { state: 'running', currentTime: 0, destination: {},
    createGain() { const n = { gain: { value: 1 }, connect() {}, disconnect() {} }; gains.push(n); return n },
    createBuffer(_channels, count, rate) { const samples = new Float32Array(count); return { duration: count / rate, getChannelData: () => samples } },
    createBufferSource() { const n = { connect() {}, disconnect() {}, start(at) { this.at = at }, stop() { this.stopped = true } }; nodes.push(n); return n },
  }
  const source = createSourcePlayback({ audioContext: context, audible, sendGateway: e => receipts.push(e), onStatus: e => statuses.push(e),
    setTimer(fn, delay) { const job = { fn, delay }; jobs.push(job); return job }, clearTimer(job) { if (job) job.cancelled = true } })
  const player = { connect(_rtc, callbacks) { this.callbacks = callbacks }, setAudible(value) { this.audible = value }, close() { this.closed = true } }
  const controller = createViduController({ player, sourcePlayback: source, sendRenderer: e => { sent.push(e); return true }, onError: e => failures.push(e.message) })
  const audio = id => controller.handleGateway({ type: 'audio.delta', responseId: id, audio: pcm, sampleRate: 24000 })
  const done = id => controller.handleGateway({ type: 'audio.done', responseId: id })
  const end = node => { context.currentTime = node.at + node.buffer.duration; node.onended?.() }
  return { controller, source, context, receipts, statuses, nodes, gains, jobs, sent, failures, player, audio, done, end }
}

test('original PCM creates source receipts even when Vidu never becomes ready or returns media', () => {
  const f = fixture(); f.audio('a'); f.done('a')
  assert.deepEqual(f.receipts, [])
  assert.equal(f.gains[0].gain.value, 0)
  assert.deepEqual([...f.nodes[0].buffer.getChannelData(0)], [0, 0.5, -0.5, 0.25])
  f.end(f.nodes[0])
  assert.deepEqual(f.receipts.map(e => e.type), ['playback.started', 'playback.ended'])
  assert.deepEqual(f.sent, []) // initialization never blocks the source timeline
  f.controller.close()
})

test('audible reference and muted mirror have identical source data, schedules and Gateway receipts', () => {
  const muted = fixture(), audible = fixture({ audible: true })
  for (const f of [muted, audible]) {
    f.audio('a'); f.audio('a'); f.done('a'); f.audio('b'); f.done('b')
    for (const n of f.nodes) f.end(n)
  }
  assert.deepEqual(muted.nodes.map(n => n.at), audible.nodes.map(n => n.at))
  assert.deepEqual(muted.nodes.map(n => [...n.buffer.getChannelData(0)]), audible.nodes.map(n => [...n.buffer.getChannelData(0)]))
  assert.deepEqual(muted.receipts, audible.receipts)
  assert.equal(muted.gains[0].gain.value, 0); assert.equal(audible.gains[0].gain.value, 1)
  muted.controller.close(); audible.controller.close()
})

test('source clear cancels originals but never stops, mutes or interrupts the Vidu presentation', () => {
  const f = fixture()
  f.controller.handleRenderer(JSON.stringify({ type: 'session.ready' }))
  f.audio('a'); f.done('a')
  const old = f.nodes[0].onended
  f.controller.handleGateway({ type: 'playback.clear', reason: 'user_interruption' })
  assert.equal(f.nodes[0].stopped, true)
  assert.equal(f.receipts.at(-1).type, 'playback.cancelled')
  assert.equal(f.player.closed, undefined); assert.equal(f.player.audible, undefined)
  old(); f.audio('a')
  assert.equal(f.nodes.length, 1)
  assert.ok(!f.sent.some(e => e.type === 'turn.finish'))
  f.audio('b'); f.done('b'); f.end(f.nodes[1])
  assert.equal(f.receipts.at(-1).type, 'playback.ended')
  f.controller.close()
})

test('renderer error and disconnection cannot cancel, end or delay the original playback', () => {
  const f = fixture(); f.audio('a'); f.done('a')
  f.controller.handleRenderer(JSON.stringify({ type: 'renderer.error', message: 'vendor unavailable' }))
  f.controller.rendererDisconnected('late disconnect')
  assert.deepEqual(f.receipts, [])
  assert.equal(f.failures.length, 1)
  f.end(f.nodes[0])
  f.audio('b'); f.done('b'); f.end(f.nodes[1])
  assert.deepEqual(f.receipts.map(e => e.type), ['playback.started', 'playback.ended', 'playback.started', 'playback.ended'])
  f.controller.close()
})

test('a throwing display transport cannot interrupt original PCM scheduling or completion', () => {
  const f = fixture(), failures = []
  let fail = false
  const controller = createViduController({ player: f.player, sourcePlayback: f.source,
    sendRenderer: () => { if (fail) throw new Error('socket closed'); return true }, onError: e => failures.push(e.message) })
  controller.handleRenderer(JSON.stringify({ type: 'session.ready' }))
  fail = true
  controller.handleGateway({ type: 'audio.delta', responseId: 'r', audio: pcm })
  controller.handleGateway({ type: 'audio.done', responseId: 'r' })
  f.end(f.nodes[0])
  assert.deepEqual(f.receipts.map(e => e.type), ['playback.started', 'playback.ended'])
  assert.equal(failures.length, 1)
  assert.doesNotThrow(() => controller.close())
})

test('input mute does not stop originals; original output selection changes only gains', () => {
  const f = fixture(); f.audio('a')
  f.controller.handleGateway({ type: 'input.mute' })
  f.controller.setSourceAudible(true)
  assert.equal(f.gains[0].gain.value, 1); assert.equal(f.player.audible, false)
  f.controller.setSourceAudible(false)
  assert.equal(f.gains[0].gain.value, 0); assert.equal(f.player.audible, true)
  assert.equal(f.nodes.length, 1); assert.deepEqual(f.receipts, [])
  f.controller.close()
})

test('queued source packets are mirrored in order after bridge opens, with no turn ready barrier', () => {
  const f = fixture(); f.audio('a'); f.done('a'); f.audio('b'); f.done('b')
  f.controller.handleRenderer(JSON.stringify({ type: 'session.ready' }))
  assert.deepEqual(f.sent.map(e => e.type), ['session.open', 'turn.start', 'audio.append', 'audio.end', 'turn.start', 'audio.append', 'audio.end'])
  assert.equal(f.sent[2].audio, pcm)
  f.controller.close()
})

function nativeFixture(t, { blocked = false, delayedTrack = false, hangingJoin = false } = {}) {
  const engines = [], errors = []
  let resolveTrack
  const video = { srcObject: null, muted: true, paused: true, readyState: 2,
    pause() { this.paused = true }, async play() { if (blocked) throw Error('blocked'); this.paused = false } }
  const stream = tracks => ({ tracks: [...tracks], addTrack(t) { this.tracks.push(t) }, getTracks() { return this.tracks } })
  const sdk = { isSupported: async () => ({ support: true }), getInstance() {
    const handlers = {}, engine = { handlers, on(name, fn) { handlers[name] = fn }, setPlayoutVolume(v) { this.volume = v },
      getAudioTrack: () => delayedTrack ? new Promise(resolve => { resolveTrack = resolve }) : { kind: 'audio' }, getVideoTrack: async () => ({ kind: 'video' }),
      setChannelProfile() {}, publishLocalAudioStream() {}, publishLocalVideoStream() {}, enableLocalVideo() {},
      setDefaultSubscribeAllRemoteAudioStreams() {}, setDefaultSubscribeAllRemoteVideoStreams() {},
      async joinChannel() { if (hangingJoin) await new Promise(() => {}) }, async leaveChannel() {}, async destroy() { this.destroyed = true } }
    engines.push(engine); return engine
  } }
  const player = createArtcPlayer({ video, loadSdk: async () => sdk, makeStream: stream, now: () => 1000,
    setTimer: () => 1, clearTimer() {} })
  player.connect({ user_id: 'viewer', avatar_user_id: 'avatar', token: 'scoped', expires_at: 100 }, { onError: e => errors.push(e.message) })
  t.after(() => player.close())
  return { player, video, engines, errors, resolveTrack: () => resolveTrack?.({ kind: 'audio' }) }
}

test('RTC continuously plays original audio and video in one element with no per-turn lifecycle or analysis', async t => {
  const f = nativeFixture(t); await tick()
  await f.engines[0].handlers.audioSubscribeStateChanged('avatar', 0, 3)
  await f.engines[0].handlers.videoSubscribeStateChanged('avatar', 0, 3)
  await tick()
  assert.equal(f.engines[0].volume, 0)
  assert.equal(f.video.muted, false); assert.equal(f.video.paused, false)
  assert.deepEqual(f.video.srcObject.getTracks().map(t => t.kind), ['audio', 'video'])
  assert.equal(f.player.startTurn, undefined); assert.equal(f.player.stop, undefined)
  f.player.setAudible(false); assert.equal(f.video.muted, true)
  f.player.setAudible(true); assert.equal(f.video.muted, false)
  assert.deepEqual(f.errors, [])
})

test('late track and unresolved join cleanup cannot revive a closed presentation', async t => {
  const f = nativeFixture(t, { delayedTrack: true }); await tick()
  const attaching = f.engines[0].handlers.audioSubscribeStateChanged('avatar', 0, 3)
  const closing = f.player.close(); f.resolveTrack(); await attaching; await closing
  assert.equal(f.video.srcObject, null); assert.equal(f.engines[0].destroyed, true)
  const hanging = nativeFixture(t, { hangingJoin: true }); await tick()
  await hanging.player.close(); assert.equal(hanging.engines[0].destroyed, true)
})

test('blocked RTC autoplay is a presentation error only', async t => {
  const f = nativeFixture(t, { blocked: true }); await tick()
  await f.engines[0].handlers.audioSubscribeStateChanged('avatar', 0, 3); await tick()
  assert.match(f.errors[0], /failed or blocked/)
  await f.player.close(); assert.equal(f.engines[0].destroyed, true)
})
