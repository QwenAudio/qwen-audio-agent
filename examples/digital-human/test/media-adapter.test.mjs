import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import http from 'node:http'
import { startMockRendererServer } from '../providers/mock/mock-renderer-server.mjs'
import { createFramedAvSource, ADAPTER_ID } from '../media/framed-av-source.mjs'
import { ControlOp, RecordKind, encodePairedAv, encodeMediaEnd, encodeInputPcm, encodeControl } from '../protocol/dhav.mjs'
import { tonePcm, syntheticI420 } from '../fixtures/generate.mjs'

const require = createRequire(import.meta.url)
const { WebSocket, WebSocketServer } = require('ws')

function withTimeout(promise, ms, label) {
  return Promise.race([promise, new Promise((_resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${label}`)), ms)
    timer.unref?.()
  })])
}

function waitFor(check, ms = 6000, label = 'condition') {
  return withTimeout(new Promise(resolve => {
    const timer = setInterval(() => { if (check()) { clearInterval(timer); resolve() } }, 20)
    timer.unref?.()
  }), ms, label)
}

function bindingFor(url, token) {
  return { protocol: 'dhav', protocolVersion: 1, media: { url, token }, video: { format: 'i420', width: 256, height: 256, fps: 25 } }
}

// Drive one turn through the mock renderer's input channel.
async function driveTurn({ baseUrl, created, ref, durationMs = 200, finish = true, cancel = false }) {
  const input = new WebSocket(created.input.url, { headers: { authorization: `Bearer ${created.input.token}` } })
  await withTimeout(new Promise(resolve => input.addEventListener('open', resolve)), 3000, 'input open')
  input.send(encodeControl({ op: ControlOp.START, requestId: 'r1', turn: ref }))
  const tone = tonePcm({ durationMs })
  input.send(encodeInputPcm({ turn: ref, sequence: 0, sampleOffset: 0, samples: tone.samples, payload: tone.buffer }))
  if (finish) input.send(encodeControl({ op: ControlOp.FINISH, requestId: 'r2', turn: ref, lastAudioSequence: 0, totalSamples: tone.samples }))
  if (cancel) input.send(encodeControl({ op: ControlOp.CANCEL, requestId: 'r2', turn: ref, reason: 'user_interruption' }))
  return input
}

async function createMockSession(server) {
  const response = await fetch(`${server.url}/v1/avatar/sessions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ personaId: 'mock-default', protocolVersion: 1 }),
  })
  assert.equal(response.status, 201)
  return response.json()
}

test('adapter normalizes paired units and media end from the mock renderer', async () => {
  const server = await startMockRendererServer({ heartbeatIntervalMs: 100 })
  try {
    const created = await createMockSession(server)
    const units = []
    const events = []
    const errors = []
    const source = createFramedAvSource({
      binding: bindingFor(created.media.url, created.media.token),
      onUnit: unit => units.push(unit),
      onEvent: event => events.push(event),
      onError: error => errors.push(error),
    })
    assert.equal(source.adapterId, ADAPTER_ID)
    await withTimeout(source.ready, 3000, 'adapter ready')
    const ref = { avatarSessionId: created.avatarSessionId, responseId: 'resp-a', generation: 0 }
    const input = await driveTurn({ server, created, ref, durationMs: 200 })
    await waitFor(() => events.some(e => e.type === 'media_end'), 8000, 'media_end')
    assert.equal(errors.length, 0)
    assert.ok(units.length >= 4, `expected frames, got ${units.length}`)
    let previousPts = -1
    for (const unit of units) {
      assert.deepEqual(unit.turn, ref)
      assert.equal(unit.video.format, 'i420')
      assert.equal(unit.video.width, 256)
      assert.equal(unit.video.data.length, 256 * 256 * 3 / 2)
      assert.equal(unit.audio.length, unit.samples * 2)
      assert.ok(unit.ptsUs > previousPts)
      previousPts = unit.ptsUs
    }
    assert.equal(units.reduce((sum, u) => sum + u.sequence, 0), units.length * (units.length - 1) / 2)
    const end = events.find(e => e.type === 'media_end')
    assert.equal(end.reason, 'finished')
    assert.deepEqual(end.turn, ref)
    input.close()
    source.close()
    source.close() // idempotent
  } finally { await server.close() }
})

test('clear() quarantines the cancelled generation but admits the next one', async () => {
  const server = await startMockRendererServer({ heartbeatIntervalMs: 100 })
  try {
    const created = await createMockSession(server)
    const units = []
    const source = createFramedAvSource({ binding: bindingFor(created.media.url, created.media.token), onUnit: unit => units.push(unit) })
    await withTimeout(source.ready, 3000, 'adapter ready')
    const gen0 = { avatarSessionId: created.avatarSessionId, responseId: 'resp-a', generation: 0 }
    const input = await driveTurn({ server, created, ref: gen0, durationMs: 400, finish: false })
    await waitFor(() => units.length >= 1, 5000, 'first gen0 unit')
    input.send(encodeControl({ op: ControlOp.CANCEL, requestId: 'rc', turn: gen0, reason: 'user_interruption' }))
    await new Promise(resolve => setTimeout(resolve, 100))
    source.clear(0)
    const countAtClear = units.length
    await new Promise(resolve => setTimeout(resolve, 250))
    assert.equal(units.length, countAtClear, 'quarantined generation must not publish late units')
    const gen1 = { avatarSessionId: created.avatarSessionId, responseId: 'resp-b', generation: 1 }
    const input2 = await driveTurn({ server, created, ref: gen1, durationMs: 200 })
    await waitFor(() => units.filter(u => u.turn.generation === 1).length >= 4, 8000, 'gen1 units')
    input.close(); input2.close(); source.close()
  } finally { await server.close() }
})

// A bare scripted WS server for adversarial vectors the mock never produces.
async function startScriptedMediaServer(script) {
  const server = http.createServer()
  const wss = new WebSocketServer({ server })
  let socket
  const connected = new Promise(resolve => {
    wss.on('connection', ws => { socket = ws; resolve(ws) })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  script(connected)
  return {
    url: `ws://127.0.0.1:${port}/media`,
    async close() { socket?.terminate(); await new Promise(resolve => wss.close(resolve)); await new Promise(resolve => server.close(resolve)) },
  }
}

function pairedRecord({ ref, sequence, samples = 960 }) {
  return encodePairedAv({
    turn: ref, sequence, ptsUs: sequence * 40000, durationUs: 40000,
    sampleOffset: sequence * samples, samples,
    video: { format: 'i420', width: 64, height: 64, data: syntheticI420({ width: 64, height: 64, frameSequence: sequence }) },
    audio: Buffer.alloc(samples * 2),
  })
}

test('sequence gap reports an error, duplicates are ignored', async () => {
  const ref = { avatarSessionId: 'avs-x', responseId: 'resp-x', generation: 0 }
  const scripted = await startScriptedMediaServer(async connected => {
    const ws = await connected
    ws.send(pairedRecord({ ref, sequence: 0 }))
    ws.send(pairedRecord({ ref, sequence: 0 })) // duplicate, ignored
    ws.send(pairedRecord({ ref, sequence: 2 })) // gap, error
    ws.send(pairedRecord({ ref, sequence: 3 })) // after error caller closes
  })
  try {
    const units = []
    const errors = []
    const source = createFramedAvSource({ binding: bindingFor(scripted.url, 'tok'), onUnit: u => units.push(u), onError: e => errors.push(e) })
    await withTimeout(source.ready, 3000, 'ready')
    await waitFor(() => errors.length >= 1, 3000, 'gap error')
    assert.equal(units.length, 1)
    assert.match(errors[0].message, /sequence gap/)
    source.close()
  } finally { await scripted.close() }
})

test('malformed binary records surface as errors, not crashes', async () => {
  const scripted = await startScriptedMediaServer(async connected => {
    const ws = await connected
    ws.send(Buffer.from('not a dhav record at all!!'))
    const ref = { avatarSessionId: 'avs-y', responseId: 'resp-y', generation: 0 }
    ws.send(encodeMediaEnd({ turn: ref, lastSequence: -1, reason: 'finished' }))
  })
  try {
    const events = []
    const errors = []
    const source = createFramedAvSource({ binding: bindingFor(scripted.url, 'tok'), onEvent: e => events.push(e), onError: e => errors.push(e) })
    await withTimeout(source.ready, 3000, 'ready')
    await waitFor(() => events.some(e => e.type === 'media_end'), 3000, 'media_end')
    assert.equal(errors.length, 1)
    assert.ok(errors[0] instanceof Error)
    source.close()
  } finally { await scripted.close() }
})

test('binding validation rejects non-dhav and non-ws bindings', () => {
  assert.throws(() => createFramedAvSource({ binding: { protocol: 'other' }, onUnit: () => {} }), /dhav v1/)
  assert.throws(() => createFramedAvSource({ binding: { protocol: 'dhav', protocolVersion: 1, media: { url: 'http://x/media', token: 't' } }, onUnit: () => {} }), /ws\(s\)/)
})

test('renderer close propagates to onClose', async () => {
  const ref = { avatarSessionId: 'avs-z', responseId: 'resp-z', generation: 0 }
  const scripted = await startScriptedMediaServer(async connected => {
    const ws = await connected
    ws.send(pairedRecord({ ref, sequence: 0 }))
    setTimeout(() => ws.close(), 100)
  })
  try {
    let closeSeen = false
    const source = createFramedAvSource({ binding: bindingFor(scripted.url, 'tok'), onUnit: () => {}, onClose: () => { closeSeen = true } })
    await withTimeout(source.ready, 3000, 'ready')
    await waitFor(() => closeSeen, 3000, 'onClose')
    source.close()
  } finally { await scripted.close() }
})
