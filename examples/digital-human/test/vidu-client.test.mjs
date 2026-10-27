import test from 'node:test'
import assert from 'node:assert/strict'
import { createViduController, viduAdapter } from '../client/renderers/vidu.mjs'
import { createArtcPlayer } from '../client/renderers/artc-player.mjs'

const tick = () => new Promise(resolve => setImmediate(resolve))
const pcm = Buffer.from([0, 0, 0, 64, 0, 192, 0, 32]).toString('base64')
function fixture(options = {}) {
  const receipts = [], statuses = [], sent = [], failures = [], order = [], connections = []
  const player = {
    connect(rtc, callbacks) { connections.push({ rtc, callbacks }); return true },
    disconnect() { order.push('stop'); this.stopped = true },
    close() { this.closed = true },
  }
  const controller = createViduController({ player,
    sendGateway: e => receipts.push(e),
    sendRenderer: e => { sent.push(e); order.push(e.type); return true },
    onStatus: e => statuses.push(e), onError: e => failures.push(e.message), ...options })
  const audio = id => controller.handleGateway({ type: 'audio.delta', responseId: id, audio: pcm, sampleRate: 24000 })
  const done = id => controller.handleGateway({ type: 'audio.done', responseId: id })
  const message = value => controller.handleRenderer(JSON.stringify(value))
  const ready = (epoch = 0) => {
    if (epoch === 0) message({ type: 'session.ready' })
    message({ type: 'vidu.session', epoch, rtc: {} })
    connections.at(-1).callbacks.onReady()
  }
  return { controller, receipts, statuses, sent, failures, player, audio, done, message, order, connections, ready }
}

test('Vidu does not advertise or manufacture source-clock playback receipts', () => {
  const f = fixture(); f.audio('a'); f.done('a')
  f.message({ type: 'session.ready' })
  f.message({ type: 'vidu.session', epoch: 0, rtc: {} })
  f.connections[0].callbacks.onReady()
  f.controller.handleGateway({ type: 'playback.clear' })
  f.controller.close()
  assert.equal(viduAdapter.playbackReceipts, false)
  assert.deepEqual(f.receipts, [])
  assert.ok(!f.statuses.some(s => s.state === 'speaking'))
})

test('cancel after input ended stops locally first, then retires the whole live', () => {
  const f = fixture(); f.ready()
  f.audio('a'); f.done('a')
  f.order.length = 0
  f.controller.handleGateway({ type: 'playback.clear', reason: 'user_interruption' })
  assert.deepEqual(f.order, ['stop', 'session.cancel'])
  assert.equal(f.sent.at(-1).epoch, 0)
  f.controller.handleGateway({ type: 'playback.clear' })
  f.audio('a') // cancelled response cannot reopen a live
  assert.deepEqual(f.order, ['stop', 'session.cancel'])
  f.audio('b'); f.done('b')
  f.ready(1)
  assert.equal(f.sent.filter(e => e.type === 'session.open').at(-1).epoch, 1)
  assert.equal(f.sent.filter(e => e.type === 'audio.append').at(-1).epoch, 1)
  f.controller.close()
})

test('late old readiness, errors and callbacks cannot attach media to a new epoch', () => {
  const f = fixture(); f.message({ type: 'session.ready' }); f.audio('a')
  f.message({ type: 'vidu.session', epoch: 0, rtc: { name: 'old' } })
  f.controller.handleGateway({ type: 'response.interrupted', responseId: 'a' })
  f.audio('b')
  f.message({ type: 'vidu.session', epoch: 0, rtc: { name: 'stale' } })
  f.message({ type: 'renderer.error', epoch: 0, message: 'stale failure' })
  f.connections[0].callbacks.onError(Error('stale player'))
  f.connections[0].callbacks.onReady()
  assert.ok(!f.sent.some(e => e.type === 'audio.append'), 'stale readiness must not release pending audio')
  f.message({ type: 'vidu.session', epoch: 1, rtc: { name: 'new' } })
  assert.deepEqual(f.connections.map(c => c.rtc.name), ['old', 'new'])
  assert.deepEqual(f.failures, [])
  f.controller.handleGateway({ type: 'response.interrupted', responseId: 'a' })
  assert.equal(f.sent.filter(e => e.type === 'session.cancel').length, 1)
  f.controller.close()
})

test('queued cancelled input never allocates a stale live when bridge becomes ready', () => {
  const f = fixture(); f.audio('a'); f.done('a')
  f.controller.handleGateway({ type: 'playback.clear' })
  f.audio('b'); f.done('b')
  f.message({ type: 'session.ready' })
  assert.deepEqual(f.sent.map(e => e.type), ['session.open'], 'source PCM must wait for the native player')
  f.ready(1)
  assert.deepEqual(f.sent.map(e => e.type), ['session.open', 'turn.start', 'audio.append', 'audio.end'])
  assert.ok(f.sent.every(e => e.epoch === 1))
  assert.ok(f.sent.every(e => !e.responseId || e.responseId === 'b'))
  f.controller.close()
})

test('mute and stale model listening events do not cancel native output', () => {
  const f = fixture(); f.message({ type: 'session.ready' }); f.audio('a')
  f.controller.handleGateway({ type: 'turn.started', turnId: 'new' })
  f.controller.handleGateway({ type: 'input.mute' })
  f.controller.handleGateway({ type: 'voice.state', state: 'listening', origin: 'model', turnId: 'old' })
  assert.equal(f.player.stopped, undefined)
  f.controller.handleGateway({ type: 'voice.state', state: 'listening', origin: 'input', turnId: 'new' })
  assert.equal(f.player.stopped, true)
  f.controller.close()
})

test('renderer failure closes audio and reports failure once, never successful delivery', () => {
  const f = fixture(); f.message({ type: 'session.ready' }); f.audio('a')
  f.message({ type: 'renderer.error', epoch: 0, message: 'unavailable' })
  f.controller.rendererDisconnected('late disconnect')
  const count = f.sent.length
  f.audio('b')
  assert.equal(f.sent.length, count)
  assert.equal(f.player.closed, true)
  assert.deepEqual(f.failures, ['unavailable'])
  assert.deepEqual(f.receipts, [])
  f.controller.close()
})

test('bounded queues and invalid input fail closed without starting replacement output', () => {
  const f = fixture({ maxPendingBytes: 50 }); f.audio('a')
  assert.equal(f.failures.length, 1)
  assert.equal(f.player.closed, true)
  const bad = fixture()
  bad.controller.handleGateway({ type: 'audio.delta', responseId: 'a', sampleRate: 16000, audio: pcm })
  assert.equal(bad.failures.length, 1)
  assert.ok(!bad.sent.some(e => e.type === 'audio.append'))
  f.controller.close(); bad.controller.close()
})

test('a throwing transport fails once and close remains idempotent', () => {
  const f = fixture({ sendRenderer() { throw Error('socket closed') } })
  f.message({ type: 'session.ready' })
  f.audio('a')
  assert.equal(f.failures.length, 1)
  assert.doesNotThrow(() => { f.controller.close(); f.controller.close() })
})

function nativeFixture(t, { blocked = false, delayedTrack = false, hangingJoin = false,
  delayedJoin = false, delayedPlay = false } = {}) {
  const engines = [], errors = [], ready = [], timers = []
  let resolveTrack, resolveJoin, resolvePlay, rejectPlay
  const video = { srcObject: null, muted: true, paused: true, readyState: 2,
    pause() { this.paused = true }, async play() {
      if (blocked) throw Error('blocked')
      this.paused = false
      if (delayedPlay) await new Promise((resolve, reject) => { resolvePlay = resolve; rejectPlay = reject })
    } }
  const stream = tracks => ({ tracks: [...tracks], addTrack(t) { this.tracks.push(t) }, getTracks() { return this.tracks } })
  const sdk = { isSupported: async () => ({ support: true }), getInstance() {
    const handlers = {}, engine = { handlers, on(name, fn) { handlers[name] = fn }, setPlayoutVolume(v) { this.volume = v },
      getAudioTrack: () => delayedTrack ? new Promise(resolve => { resolveTrack = resolve }) : { kind: 'audio' }, getVideoTrack: async () => ({ kind: 'video' }),
      setChannelProfile() {}, publishLocalAudioStream() {}, publishLocalVideoStream() {}, enableLocalVideo() {},
      setDefaultSubscribeAllRemoteAudioStreams() {}, setDefaultSubscribeAllRemoteVideoStreams() {},
      async joinChannel() {
        if (hangingJoin) await new Promise(() => {})
        if (delayedJoin) await new Promise(resolve => { resolveJoin = resolve })
      }, async leaveChannel() {}, async destroy() { this.destroyed = true } }
    engines.push(engine); return engine
  } }
  const player = createArtcPlayer({ video, loadSdk: async () => sdk, makeStream: stream, now: () => 1000,
    setTimer(callback, delay) { const timer = { callback, delay, cleared: false }; timers.push(timer); return timer },
    clearTimer(timer) { if (timer) timer.cleared = true } })
  player.connect({ user_id: 'viewer', avatar_user_id: 'avatar', token: 'scoped', expires_at: 100 }, {
    onError: e => errors.push(e.message), onReady: () => ready.push(video.srcObject),
  })
  t.after(() => player.close())
  return { player, video, engines, errors, ready, timers, resolveTrack: () => resolveTrack?.({ kind: 'audio' }),
    resolveJoin: () => resolveJoin?.(), resolvePlay: () => resolvePlay?.(), rejectPlay: () => rejectPlay?.(Error('blocked')) }
}

test('RTC plays native audio/video together and disconnect stops output synchronously', async t => {
  const f = nativeFixture(t); await tick()
  await f.engines[0].handlers.audioSubscribeStateChanged('avatar', 0, 3)
  await f.engines[0].handlers.videoSubscribeStateChanged('avatar', 0, 3)
  await tick()
  assert.equal(f.engines[0].volume, 0)
  assert.equal(f.video.muted, false); assert.equal(f.video.paused, false)
  assert.deepEqual(f.video.srcObject.getTracks().map(t => t.kind), ['audio', 'video'])
  assert.equal(f.player.startTurn, undefined)
  const stopped = f.player.disconnect()
  assert.equal(f.video.muted, true); assert.equal(f.video.paused, true)
  assert.equal(f.video.srcObject, null)
  await stopped
  assert.equal(f.engines[0].destroyed, true)
  assert.equal(f.player.connect({ user_id: 'next', avatar_user_id: 'avatar', token: 'new', expires_at: 100 }), true)
  await tick()
  assert.equal(f.engines.length, 2)
  assert.deepEqual(f.errors, [])
})

test('late track and unresolved join cleanup cannot revive a cancelled channel', async t => {
  const f = nativeFixture(t, { delayedTrack: true }); await tick()
  const attaching = f.engines[0].handlers.audioSubscribeStateChanged('avatar', 0, 3)
  const closing = f.player.disconnect(); f.resolveTrack(); await attaching; await closing
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

test('RTC readiness waits for both actual tracks and successful native playback, then fires only once', async t => {
  const f = nativeFixture(t, { delayedPlay: true }); await tick()
  assert.equal(f.ready.length, 0) // joining a room is not media readiness
  await f.engines[0].handlers.audioSubscribeStateChanged('avatar', 0, 3)
  await tick()
  assert.equal(f.ready.length, 0)
  await f.engines[0].handlers.videoSubscribeStateChanged('avatar', 0, 3)
  await tick()
  assert.equal(f.ready.length, 0) // video.play is still pending
  f.resolvePlay(); await tick()
  assert.deepEqual(f.ready, [f.video.srcObject])
  assert.deepEqual(f.ready[0].getTracks().map(track => track.kind), ['audio', 'video'])
  await f.engines[0].handlers.audioSubscribeStateChanged('avatar', 0, 3)
  await f.engines[0].handlers.videoSubscribeStateChanged('avatar', 0, 3)
  assert.equal(f.ready.length, 1)
})

test('RTC readiness handles a video track arriving after native audio playback has begun', async t => {
  const f = nativeFixture(t); await tick()
  await f.engines[0].handlers.audioSubscribeStateChanged('avatar', 0, 3)
  await tick()
  assert.equal(f.video.paused, false)
  assert.equal(f.ready.length, 0)
  await f.engines[0].handlers.videoSubscribeStateChanged('avatar', 0, 3)
  assert.deepEqual(f.ready, [f.video.srcObject])
})

test('RTC readiness also waits for join completion if media callbacks arrive first', async t => {
  const f = nativeFixture(t, { delayedJoin: true }); await tick()
  await f.engines[0].handlers.audioSubscribeStateChanged('avatar', 0, 3)
  await f.engines[0].handlers.videoSubscribeStateChanged('avatar', 0, 3)
  await tick()
  assert.equal(f.video.paused, false)
  assert.equal(f.ready.length, 0)
  f.resolveJoin(); await tick()
  assert.deepEqual(f.ready, [f.video.srcObject])
})

test('a cancelled or failed pending play cannot report ready after cleanup', async t => {
  const cancelled = nativeFixture(t, { delayedPlay: true }); await tick()
  await cancelled.engines[0].handlers.audioSubscribeStateChanged('avatar', 0, 3)
  await cancelled.engines[0].handlers.videoSubscribeStateChanged('avatar', 0, 3)
  await tick()
  const stopped = cancelled.player.disconnect()
  cancelled.resolvePlay(); await tick(); await stopped
  assert.equal(cancelled.video.paused, true)
  assert.equal(cancelled.video.srcObject, null)
  assert.deepEqual(cancelled.ready, [])
  assert.deepEqual(cancelled.errors, [])
  const failed = nativeFixture(t, { delayedPlay: true }); await tick()
  await failed.engines[0].handlers.audioSubscribeStateChanged('avatar', 0, 3)
  await failed.engines[0].handlers.videoSubscribeStateChanged('avatar', 0, 3)
  await tick()
  failed.rejectPlay(); await tick()
  assert.deepEqual(failed.ready, [])
  assert.equal(failed.errors.length, 1)
  assert.equal(failed.video.muted, true)
  assert.equal(failed.video.srcObject, null)
})

test('RTC media readiness is bounded and its deadline is cleared on ready or disconnect', async t => {
  const stalled = nativeFixture(t); await tick()
  const deadline = stalled.timers.find(timer => timer.delay === 15000)
  assert.ok(deadline)
  deadline.callback(); await tick()
  assert.deepEqual(stalled.ready, [])
  assert.match(stalled.errors[0], /media readiness timeout/)
  assert.equal(deadline.cleared, true)
  assert.equal(stalled.video.muted, true)
  assert.equal(stalled.video.srcObject, null)
  await stalled.player.close()

  const playing = nativeFixture(t); await tick()
  const playingDeadline = playing.timers.find(timer => timer.delay === 15000)
  await playing.engines[0].handlers.audioSubscribeStateChanged('avatar', 0, 3)
  await playing.engines[0].handlers.videoSubscribeStateChanged('avatar', 0, 3)
  await tick()
  assert.equal(playing.ready.length, 1)
  assert.equal(playingDeadline.cleared, true)
  playingDeadline.callback() // a callback already queued before clear cannot fail a ready player
  assert.deepEqual(playing.errors, [])
  await playing.player.close()

  const cancelled = nativeFixture(t); await tick()
  const cancelledDeadline = cancelled.timers.find(timer => timer.delay === 15000)
  await cancelled.player.disconnect()
  assert.equal(cancelledDeadline.cleared, true)
  cancelledDeadline.callback()
  assert.deepEqual(cancelled.ready, [])
  assert.deepEqual(cancelled.errors, [])
})
