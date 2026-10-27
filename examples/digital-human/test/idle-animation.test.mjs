import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WebSocket } from 'ws'
import { startExampleServer } from '../server/server.mjs'
import { startMockRendererServer } from '../providers/mock/mock-renderer-server.mjs'
import { decodeRecord, encodePairedAv, RecordKind } from '../protocol/dhav.mjs'
import { tonePcm } from '../fixtures/generate.mjs'
import { createBrowserAvatarPlayer } from '../client/browser-avatar-player.mjs'
import { createDhavRenderer } from '../client/renderers/dhav.mjs'

const IDLE_RESPONSE_ID = 'dh-idle'
const IDLE_GENERATION_BASE = 0x40000000
const VIDEO = { format: 'i420', width: 2, height: 2, data: Uint8Array.of(100, 100, 100, 100, 128, 128) }

async function until(predicate, label = 'condition') {
  const deadline = Date.now() + 8000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

async function setup({ fault = null, providerOptions } = {}) {
  const logs = []
  const mock = await startMockRendererServer({
    heartbeatIntervalMs: 100, fault, log: (name, fields) => logs.push({ name, ...fields }),
  })
  const server = await startExampleServer({ port: 0, rendererUrl: mock.url, providerOptions })
  const socket = new WebSocket(server.origin.replace('http', 'ws') + '/avatar', { origin: server.origin })
  const messages = []
  socket.on('message', (data, binary) => messages.push(binary ? decodeRecord(data) : JSON.parse(data.toString())))
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
  await until(() => messages.some(m => m.type === 'session.ready'), 'session.ready')
  const idleUnits = () => messages.filter(m => m.kind === RecordKind.PAIRED_AV && m.header.idle)
  const idleStarts = () => logs.filter(l => l.name === 'turn.started' && l.responseId === IDLE_RESPONSE_ID).length
  return {
    socket, messages, idleUnits, idleStarts,
    send: message => socket.send(JSON.stringify(message)),
    async close() { socket.close(); await server.close(); await mock.close() },
  }
}

test('avatar keeps animating between replies on a reserved idle generation', async t => {
  const ctx = await setup()
  t.after(() => ctx.close())
  await until(() => ctx.idleUnits().length >= 2, 'idle frames')
  for (const unit of ctx.idleUnits()) {
    assert.equal(unit.header.turn.responseId, IDLE_RESPONSE_ID)
    assert.ok(unit.header.turn.generation >= IDLE_GENERATION_BASE)
  }
  assert.deepEqual(ctx.messages.filter(m => m.type === 'renderer.error'), [])
  assert.equal(ctx.socket.readyState, WebSocket.OPEN)
})

test('a reply supersedes idle animation, which resumes once the reply is delivered', async t => {
  const ctx = await setup()
  t.after(() => ctx.close())
  await until(() => ctx.idleUnits().length >= 1, 'idle frames')
  const firstIdleGeneration = ctx.idleUnits()[0].header.turn.generation
  const turn = { responseId: 'reply', generation: 0 }
  ctx.send({ type: 'turn.start', ...turn })
  ctx.send({ type: 'audio.append', ...turn, sampleRate: 24000, audio: tonePcm({ durationMs: 200 }).buffer.toString('base64') })
  ctx.send({ type: 'audio.end', ...turn })
  await until(() => ctx.messages.some(m => m.kind === RecordKind.MEDIA_END && m.header.turn.responseId === turn.responseId), 'media end')
  const replyUnits = ctx.messages.filter(m => m.kind === RecordKind.PAIRED_AV && m.header.turn.responseId === turn.responseId)
  assert.ok(replyUnits.length >= 3)
  assert.ok(replyUnits.every(unit => unit.header.idle === false), 'reply frames must not be stamped idle')
  // No second idle turn ran while the reply owned the renderer.
  assert.ok(ctx.idleUnits().every(unit => unit.header.turn.generation === firstIdleGeneration))
  await until(() => ctx.idleUnits().some(unit => unit.header.turn.generation > firstIdleGeneration), 'idle resumes')
})

test('a renderer that never produces idle media is retried boundedly without failing the bridge', async t => {
  const ctx = await setup({ fault: 'first_media_timeout', providerOptions: { firstMediaTimeoutMs: 80 } })
  t.after(() => ctx.close())
  await until(() => ctx.idleStarts() === 4, 'idle restart budget exhausted')
  await new Promise(resolve => setTimeout(resolve, 400))
  assert.equal(ctx.idleStarts(), 4)
  assert.deepEqual(ctx.messages.filter(m => m.type === 'renderer.error'), [])
  assert.equal(ctx.socket.readyState, WebSocket.OPEN)
})

test('idle records are painted without an active turn and never sent back as receipts', () => {
  const calls = []
  const player = {
    begin(key) { calls.push(['begin', key]) }, append(key) { calls.push(['append', key]) },
    end(key) { calls.push(['end', key]) }, clear(key) { calls.push(['clear', key]) },
    paintIdle(video) { calls.push(['idle', video.width]); return true },
  }
  const sent = []
  const adapter = createDhavRenderer({ player, sendRenderer: event => { sent.push(event); return true } })
  adapter.handleMessage({ type: 'session.ready', avatarSessionId: 'session' })
  const wireTurn = { avatarSessionId: 'session', responseId: IDLE_RESPONSE_ID, generation: IDLE_GENERATION_BASE + 1 }
  adapter.handleMessage(encodePairedAv({
    turn: wireTurn, sequence: 0, ptsUs: 0, durationUs: 40000, sampleOffset: 0, samples: 2, idle: true,
    video: { ...VIDEO, data: Buffer.from(VIDEO.data) }, audio: Buffer.from([0, 0, 0, 0]),
  }))
  assert.deepEqual(calls, [['idle', 2]])
  assert.deepEqual(sent, [])
})

function playerSetup() {
  const context = {
    state: 'running', currentTime: 0, destination: {},
    createBuffer: (channels, length, rate) => ({ duration: length / rate, getChannelData: () => new Float32Array(length) }),
    createBufferSource: () => ({ connect() {}, disconnect() {}, start() {}, stop() {}, onended: null }),
  }
  const painted = []
  const canvas = {
    width: 0, height: 0,
    getContext: () => ({
      createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      putImageData: image => painted.push(image),
    }),
  }
  const replyFrames = []
  const idleFrames = []
  const player = createBrowserAvatarPlayer({
    audioContext: context, canvas,
    onFrame: frame => replyFrames.push(frame), onIdleFrame: frame => idleFrames.push(frame),
  })
  return { player, painted, replyFrames, idleFrames }
}

test('paintIdle animates only while no reply owns the canvas and earns no receipt', () => {
  const { player, painted, replyFrames, idleFrames } = playerSetup()
  assert.equal(player.paintIdle(VIDEO), true)
  assert.equal(idleFrames.length, 1)
  assert.equal(replyFrames.length, 0)
  assert.equal(painted.length, 1)
  assert.equal(player.paintIdle(null), false)

  const events = []
  player.begin('a', { onStarted: () => events.push('start'), onDrained: () => events.push('drain') })
  assert.equal(player.paintIdle(VIDEO), false, 'a live reply owns the canvas')
  assert.equal(idleFrames.length, 1)

  player.append('a', { audio: Uint8Array.of(1, 0), sampleRate: 24000, video: VIDEO })
  player.end('a')
  player.clear('a')
  assert.equal(player.paintIdle(VIDEO), true)
  assert.equal(idleFrames.length, 2)
  assert.deepEqual(events, [], 'idle never acknowledges playback')
})
