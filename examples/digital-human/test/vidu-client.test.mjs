import test from 'node:test'
import assert from 'node:assert/strict'
import { AvatarPlaybackController } from '../client/avatar-playback.mjs'
import { createViduRenderer } from '../client/renderers/vidu.mjs'
import { createArtcPlayer } from '../client/renderers/artc-player.mjs'

const tick = () => new Promise(resolve => setImmediate(resolve))
const pcm = Buffer.alloc(4800).toString('base64')
function controllerFixture() {
  const sent = [], receipts = [], order = [], sessions = []
  const player = {
    start(turn, rtc, callbacks) { sessions.push({ turn, rtc, callbacks }); return true },
    stop() { order.push('local-stop') }, close() {},
  }
  const renderer = createViduRenderer({ player, sendRenderer: event => { sent.push(event); order.push(event.type); return true } })
  const controller = new AvatarPlaybackController({ renderer, sendGateway: event => receipts.push(event),
    setTimer: () => 1, clearTimer() {} })
  const audio = id => controller.handleGateway({ type: 'audio.delta', responseId: id, sampleRate: 24000, audio: pcm })
  const session = () => {
    const turn = sent.filter(m => m.type === 'turn.start').at(-1)
    controller.handleRenderer(JSON.stringify({ type: 'vidu.session', ...turn, type: 'vidu.session', rtc: { token: 'scoped' } }))
    return sessions.at(-1)
  }
  return { sent, receipts, order, sessions, controller, audio, session }
}

test('Vidu never derives receipts from ready, subscription, input end or elapsed source duration', t => {
  const f = controllerFixture(); t.after(() => f.controller.close())
  f.controller.handleRenderer(JSON.stringify({ type: 'session.ready' }))
  f.audio('r1')
  const session = f.session()
  f.controller.handleGateway({ type: 'audio.done', responseId: 'r1' })
  f.controller.handleRenderer(JSON.stringify({ type: 'vidu.input_ended', ...session.turn, type: 'vidu.input_ended' }))
  assert.deepEqual(f.receipts, [])
  session.callbacks.onStarted()
  assert.deepEqual(f.receipts.map(m => m.type), ['playback.started'])
  assert.equal(session.callbacks.onDrained, undefined)
  assert.ok(!f.receipts.some(m => m.type === 'playback.ended'))
})

test('Vidu cancellation stops local media before remote control and fences old callbacks over multiple turns', t => {
  const f = controllerFixture(); t.after(() => f.controller.close())
  for (let i = 0; i < 3; i++) {
    f.audio(`r${i}`)
    const old = f.session()
    old.callbacks.onStarted()
    f.order.length = 0
    f.controller.handleGateway({ type: 'playback.clear', reason: 'user_interruption' })
    assert.deepEqual(f.order.slice(0, 2), ['local-stop', 'turn.cancel'])
    const count = f.receipts.length
    old.callbacks.onStarted()
    old.callbacks.onError(new Error('late callback'))
    f.controller.handleRenderer(JSON.stringify({ ...old.turn, type: 'vidu.session', rtc: {} }))
    assert.equal(f.receipts.length, count)
  }
  assert.equal(f.receipts.filter(m => m.type === 'playback.cancelled').length, 3)
  assert.equal(f.receipts.filter(m => m.type === 'playback.ended').length, 0)
})

test('microphone mute does not cancel Vidu output; renderer disconnect cancels without PCM replay', t => {
  const f = controllerFixture(); t.after(() => f.controller.close())
  f.audio('r'); const session = f.session()
  f.controller.handleGateway({ type: 'input.mute' })
  assert.equal(f.order.includes('local-stop'), false)
  session.callbacks.onStarted()
  f.controller.rendererDisconnected()
  assert.equal(f.receipts.at(-1).type, 'playback.cancelled')
  assert.ok(!f.receipts.some(m => m.type === 'playback.ended'))
})

function artcFixture({ blocked = false, expired = false, delayedTrack = false, hangingJoin = false, destroyDelay } = {}) {
  const engines = [], jobs = [], observations = [], nodes = []
  let level = 0, resolveTrack
  const node = () => {
    const value = { gain: { value: 1 }, connected: false,
      connect(next) { this.connected = true; return next }, disconnect() { this.connected = false },
      fftSize: 8, getFloatTimeDomainData(data) { data.fill(level) } }
    nodes.push(value); return value
  }
  const context = { state: 'running', destination: {}, createMediaStreamSource: node, createGain: node, createAnalyser: node }
  const video = { muted: false, srcObject: null, pause() { this.paused = true }, play: () => blocked ? Promise.reject(new Error('blocked')) : Promise.resolve() }
  const trackPromise = delayedTrack ? new Promise(resolve => { resolveTrack = resolve }) : Promise.resolve({ kind: 'audio' })
  const sdk = { isSupported: async () => ({ support: true }), getInstance() {
    const handlers = {}
    const engine = {
      handlers, on(event, fn) { handlers[event] = fn }, setPlayoutVolume(value) { this.volume = value },
      setChannelProfile() {}, publishLocalAudioStream(value) { assert.equal(value, false) },
      publishLocalVideoStream(value) { assert.equal(value, false) }, enableLocalVideo() {},
      setDefaultSubscribeAllRemoteAudioStreams() {}, setDefaultSubscribeAllRemoteVideoStreams() {},
      setRemoteViewConfig() {}, getAudioTrack: () => trackPromise,
      async joinChannel() { this.joined = true; if (hangingJoin) await new Promise(() => {}) },
      async leaveChannel() { this.left = true }, async destroy() { await destroyDelay; this.destroyed = true },
    }
    engines.push(engine); return engine
  } }
  const player = createArtcPlayer({ audioContext: context, video, loadSdk: async () => sdk,
    makeStream: track => ({ track }), now: () => 1000,
    setTimer(fn, delay) { const job = { fn, delay }; jobs.push(job); return job }, clearTimer(job) { if (job) job.cancelled = true } })
  const start = id => player.start({ responseId: id, generation: engines.length + 1 }, {
    token: 'short-lived', user_id: 'viewer', avatar_user_id: 'avatar', expires_at: expired ? 0 : 100,
  }, { onStarted: () => observations.push('started'), onError: error => observations.push(error.message) })
  return { player, start, engines, nodes, jobs, observations, context, video,
    level: value => { level = value }, resolveTrack: () => resolveTrack?.({ kind: 'audio' }) }
}

test('ARTC start is observed on the real audible graph; delayed start is flushed before local cancellation', async () => {
  const f = artcFixture(); f.start('r'); await tick()
  const engine = f.engines[0]
  assert.equal(engine.volume, 0) // SDK automatic audio must never double-play
  await engine.handlers.audioSubscribeStateChanged('avatar', 0, 3)
  assert.deepEqual(f.observations, []) // silent/idle remote audio is not a start
  f.level(0.2)
  f.player.stop() // JS poll can be late; synchronously inspect before muting
  assert.deepEqual(f.observations, ['started'])
  assert.equal(f.nodes.find(n => n.gain.value === 0)?.gain.value, 0)
  assert.ok(f.nodes.every(n => !n.connected))
  await f.player.close()
  assert.equal(engine.destroyed, true)
})

test('ARTC autoplay rejection reports failure, never a successful drain', async () => {
  const f = artcFixture({ blocked: true }); f.start('r'); await tick()
  f.engines[0].handlers.videoSubscribeStateChanged('avatar', 0, 3)
  await tick()
  assert.deepEqual(f.observations, ['ARTC autoplay blocked'])
  assert.equal(f.engines[0].volume, 0)
  await f.player.close()
})

test('ARTC expired credentials and suspension cannot create playback receipts', async () => {
  const expired = artcFixture({ expired: true }); expired.start('r'); await tick()
  assert.deepEqual(expired.observations, ['ARTC credentials expired'])
  assert.equal(expired.engines.length, 0)
  await expired.player.close()
  const f = artcFixture(); f.start('r'); await tick()
  f.context.state = 'suspended'
  await f.engines[0].handlers.audioSubscribeStateChanged('avatar', 0, 3)
  assert.deepEqual(f.observations, ['ARTC audio playback suspended'])
  await f.player.close()
})

test('cancelled ARTC track promises and old session events cannot reconnect audible media', async () => {
  const f = artcFixture({ delayedTrack: true }); f.start('old'); await tick()
  const old = f.engines[0]
  const attaching = old.handlers.audioSubscribeStateChanged('avatar', 0, 3)
  f.player.stop()
  f.start('new')
  f.resolveTrack(); await attaching; await tick()
  assert.equal(f.nodes.length, 0)
  old.handlers.videoSubscribeStateChanged('avatar', 0, 3)
  old.handlers.authInfoExpired()
  assert.deepEqual(f.observations, [])
  assert.equal(old.destroyed, true)
  assert.equal(f.engines.length, 2)
  await f.player.close()
  assert.ok(f.engines.every(e => e.destroyed))
})

test('cancelling an unresolved RTC join releases resources without waiting for vendor completion', async () => {
  const f = artcFixture({ hangingJoin: true }); f.start('r'); await tick()
  assert.equal(f.engines[0].joined, true)
  await f.player.close()
  assert.equal(f.engines[0].destroyed, true)
  assert.deepEqual(f.observations, [])
})

test('a new controller waits for destruction of the SDK singleton owned by the previous player', async () => {
  let release
  const delay = new Promise(resolve => { release = resolve })
  const old = artcFixture({ destroyDelay: delay }); old.start('old'); await tick()
  const closing = old.player.close()
  const next = artcFixture(); next.start('new'); await tick()
  assert.equal(next.engines.length, 0)
  release(); await closing; await tick()
  assert.equal(old.engines[0].destroyed, true)
  assert.equal(next.engines.length, 1)
  await next.player.close()
})
