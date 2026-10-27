import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { startMockRendererServer, MOCK_PERSONAS } from '../providers/mock/mock-renderer-server.mjs'
import { ControlOp, RecordKind, encodeInputPcm, encodeControl, decodeRecord, decodeMediaEvent } from '../protocol/dhav.mjs'
import { tonePcm } from '../fixtures/generate.mjs'

const require = createRequire(import.meta.url)
const { WebSocket } = require('ws')

const TURN = { avatarSessionId: '', responseId: 'resp-1', generation: 0 }

function withTimeout(promise, ms, label) {
  return Promise.race([promise, new Promise((_resolve, reject) => setTimeout(() => reject(new Error(`timeout waiting for ${label}`)), ms))])
}

async function openClientSession(server, { personaId = 'mock-default', fault } = {}) {
  const response = await fetch(`${server.url}/v1/avatar/sessions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ personaId, protocolVersion: 1, inputFormat: { encoding: 'pcm_s16le', sampleRate: 24000, channels: 1 }, ...(fault ? { fault } : {}) }),
  })
  if (!response.ok) return { status: response.status, body: await response.json().catch(() => null) }
  const created = await response.json()
  const input = new WebSocket(created.input.url, { headers: { authorization: `Bearer ${created.input.token}` } })
  const media = new WebSocket(created.media.url, { headers: { authorization: `Bearer ${created.media.token}` } })
  const inputEvents = []
  const mediaRecords = []
  const waiters = new Set()
  const notify = () => { for (const check of [...waiters]) check() }
  input.addEventListener('message', ({ data }) => { inputEvents.push(typeof data === 'string' ? JSON.parse(data) : data); notify() })
  media.addEventListener('message', ({ data }) => { mediaRecords.push(typeof data === 'string' ? JSON.parse(data) : decodeRecord(data)); notify() })
  await Promise.all([input, media].map(ws => withTimeout(new Promise(resolve => ws.addEventListener('open', resolve)), 3000, 'ws open')))
  const turn = { ...TURN, avatarSessionId: created.avatarSessionId }
  return {
    created, turn, input, media, inputEvents, mediaRecords,
    waitFor(predicate, label, ms = 5000) {
      return withTimeout(new Promise(resolve => {
        const check = () => { if (predicate()) { waiters.delete(check); resolve() } }
        waiters.add(check)
        check()
      }), ms, label)
    },
    async close() { input.close(); media.close() },
  }
}

test('health endpoints report live and ready', async () => {
  const server = await startMockRendererServer()
  try {
    const live = await fetch(`${server.url}/health/live`).then(r => r.json())
    assert.equal(live.live, true)
    const ready = await fetch(`${server.url}/health/ready`).then(r => r.json())
    assert.equal(ready.ready, true)
  } finally { await server.close() }
})

test('session creation validates persona and protocol version', async () => {
  const server = await startMockRendererServer()
  try {
    const bad = await openClientSession(server, { personaId: 'not-allowed' })
    assert.equal(bad.status, 400)
    const response = await fetch(`${server.url}/v1/avatar/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ personaId: 'mock-default', protocolVersion: 2 }),
    })
    assert.equal(response.status, 400)
    const session = await openClientSession(server)
    assert.ok(session.created.avatarSessionId)
    assert.equal(session.created.video.width, MOCK_PERSONAS['mock-default'].video.width)
    await session.close()
  } finally { await server.close() }
})

test('session.ready fires only after both channels attach', async () => {
  const server = await startMockRendererServer()
  try {
    const session = await openClientSession(server)
    await session.waitFor(() => session.inputEvents.some(e => e.event === 'session.ready'), 'session.ready')
    await session.close()
  } finally { await server.close() }
})

test('start + PCM produces paired AV units with echoed audio and advancing pts', async () => {
  const server = await startMockRendererServer()
  try {
    const session = await openClientSession(server)
    await session.waitFor(() => session.inputEvents.some(e => e.event === 'session.ready'), 'session.ready')
    const tone = tonePcm({ frequency: 440, durationMs: 200 }) // 4800 samples = 5 frames
    session.input.send(encodeControl({ op: ControlOp.START, requestId: 'r1', turn: session.turn }))
    session.input.send(encodeInputPcm({ turn: session.turn, sequence: 0, sampleOffset: 0, samples: tone.samples, payload: tone.buffer }))
    await session.waitFor(() => session.mediaRecords.filter(r => r.kind === RecordKind.PAIRED_AV).length >= 3, 'paired units', 8000)
    const units = session.mediaRecords.filter(r => r.kind === RecordKind.PAIRED_AV)
    let pts = -1
    let sampleOffset = 0
    for (const unit of units) {
      assert.deepEqual(unit.header.turn, session.turn)
      assert.equal(unit.header.video.width, 256)
      assert.equal(unit.header.video.height, 256)
      assert.equal(unit.audio.length, unit.header.samples * 2)
      assert.equal(unit.video.length, 256 * 256 * 3 / 2)
      assert.ok(unit.header.ptsUs > pts, 'pts must advance')
      assert.equal(unit.header.sampleOffset, sampleOffset)
      pts = unit.header.ptsUs
      sampleOffset += unit.header.samples - unit.header.paddingSamples
    }
    // audio is the echoed input: concatenation of unit audio equals input prefix
    const echoed = Buffer.concat(units.map(u => u.audio.subarray(0, (u.header.samples - u.header.paddingSamples) * 2)))
    assert.ok(tone.buffer.subarray(0, echoed.length).equals(echoed))
    await session.waitFor(() => session.inputEvents.some(e => e.event === 'turn.first_media'), 'turn.first_media')
    await session.close()
  } finally { await server.close() }
})

test('finish flushes padded tail, sends media end and turn.completed', async () => {
  const server = await startMockRendererServer()
  try {
    const session = await openClientSession(server)
    await session.waitFor(() => session.inputEvents.some(e => e.event === 'session.ready'), 'session.ready')
    const tone = tonePcm({ durationMs: 50 }) // 1200 samples: 1 full frame + 240 tail
    session.input.send(encodeControl({ op: ControlOp.START, requestId: 'r1', turn: session.turn }))
    session.input.send(encodeInputPcm({ turn: session.turn, sequence: 0, sampleOffset: 0, samples: tone.samples, payload: tone.buffer }))
    session.input.send(encodeControl({ op: ControlOp.FINISH, requestId: 'r2', turn: session.turn, lastAudioSequence: 0, totalSamples: tone.samples }))
    await session.waitFor(() => session.mediaRecords.some(r => r.kind === RecordKind.MEDIA_END), 'media end', 8000)
    const end = session.mediaRecords.find(r => r.kind === RecordKind.MEDIA_END)
    assert.equal(end.header.reason, 'finished')
    const units = session.mediaRecords.filter(r => r.kind === RecordKind.PAIRED_AV)
    assert.equal(end.header.lastSequence, units.length - 1)
    const tail = units[units.length - 1]
    assert.equal(tail.header.paddingSamples, 960 - 240)
    const covered = units.reduce((sum, u) => sum + u.header.samples - u.header.paddingSamples, 0)
    assert.equal(covered, tone.samples)
    await session.waitFor(() => session.inputEvents.some(e => e.event === 'turn.completed'), 'turn.completed')
    const completed = session.inputEvents.find(e => e.event === 'turn.completed')
    assert.deepEqual(completed.turn, session.turn)
    await session.close()
  } finally { await server.close() }
})

test('cancel discards queued input and stops media', async () => {
  const server = await startMockRendererServer()
  try {
    const session = await openClientSession(server)
    await session.waitFor(() => session.inputEvents.some(e => e.event === 'session.ready'), 'session.ready')
    const tone = tonePcm({ durationMs: 400 })
    session.input.send(encodeControl({ op: ControlOp.START, requestId: 'r1', turn: session.turn }))
    session.input.send(encodeInputPcm({ turn: session.turn, sequence: 0, sampleOffset: 0, samples: tone.samples, payload: tone.buffer }))
    await session.waitFor(() => session.mediaRecords.some(r => r.kind === RecordKind.PAIRED_AV), 'first unit')
    session.input.send(encodeControl({ op: ControlOp.CANCEL, requestId: 'r2', turn: session.turn, reason: 'user_interruption' }))
    await session.waitFor(() => session.inputEvents.some(e => e.event === 'turn.cancelled'), 'turn.cancelled')
    const atCancel = session.mediaRecords.filter(r => r.kind === RecordKind.PAIRED_AV).length
    await new Promise(resolve => setTimeout(resolve, 200))
    assert.equal(session.mediaRecords.filter(r => r.kind === RecordKind.PAIRED_AV).length, atCancel, 'no units after cancel')
    assert.ok(!session.mediaRecords.some(r => r.kind === RecordKind.MEDIA_END))
    await session.close()
  } finally { await server.close() }
})

test('sequence gap fails the turn with protocol_error', async () => {
  const server = await startMockRendererServer()
  try {
    const session = await openClientSession(server)
    await session.waitFor(() => session.inputEvents.some(e => e.event === 'session.ready'), 'session.ready')
    const tone = tonePcm({ durationMs: 40 })
    session.input.send(encodeControl({ op: ControlOp.START, requestId: 'r1', turn: session.turn }))
    session.input.send(encodeInputPcm({ turn: session.turn, sequence: 0, sampleOffset: 0, samples: tone.samples, payload: tone.buffer }))
    session.input.send(encodeInputPcm({ turn: session.turn, sequence: 2, sampleOffset: tone.samples * 2, samples: tone.samples, payload: tone.buffer }))
    await session.waitFor(() => session.inputEvents.some(e => e.event === 'provider.error'), 'provider.error')
    const error = session.inputEvents.find(e => e.event === 'provider.error')
    assert.equal(error.code, 'protocol_error')
    await session.close()
  } finally { await server.close() }
})

test('duplicate sequence with identical content is ignored, different content fails', async () => {
  const server = await startMockRendererServer()
  try {
    const session = await openClientSession(server)
    await session.waitFor(() => session.inputEvents.some(e => e.event === 'session.ready'), 'session.ready')
    const tone = tonePcm({ durationMs: 40 })
    session.input.send(encodeControl({ op: ControlOp.START, requestId: 'r1', turn: session.turn }))
    session.input.send(encodeInputPcm({ turn: session.turn, sequence: 0, sampleOffset: 0, samples: tone.samples, payload: tone.buffer }))
    session.input.send(encodeInputPcm({ turn: session.turn, sequence: 0, sampleOffset: 0, samples: tone.samples, payload: tone.buffer }))
    session.input.send(encodeInputPcm({ turn: session.turn, sequence: 1, sampleOffset: tone.samples, samples: tone.samples, payload: tone.buffer }))
    await new Promise(resolve => setTimeout(resolve, 150))
    assert.ok(!session.inputEvents.some(e => e.event === 'provider.error'), 'identical duplicate must be ignored')
    const other = tonePcm({ frequency: 880, durationMs: 40 })
    session.input.send(encodeInputPcm({ turn: session.turn, sequence: 1, sampleOffset: tone.samples, samples: other.samples, payload: other.buffer }))
    await session.waitFor(() => session.inputEvents.some(e => e.event === 'provider.error'), 'provider.error')
    assert.equal(session.inputEvents.find(e => e.event === 'provider.error').code, 'protocol_error')
    await session.close()
  } finally { await server.close() }
})

test('single active session capacity, DELETE is idempotent and frees it', async () => {
  const server = await startMockRendererServer()
  try {
    const first = await openClientSession(server)
    const second = await openClientSession(server)
    assert.equal(second.status, 409)
    assert.equal(second.body.error, 'capacity_exhausted')
    const del = await fetch(`${server.url}/v1/avatar/sessions/${first.created.avatarSessionId}`, { method: 'DELETE' })
    assert.equal(del.status, 204)
    const again = await fetch(`${server.url}/v1/avatar/sessions/${first.created.avatarSessionId}`, { method: 'DELETE' })
    assert.equal(again.status, 204)
    await new Promise(resolve => setTimeout(resolve, 50))
    const third = await openClientSession(server)
    assert.ok(third.created)
    await third.close()
  } finally { await server.close() }
})

test('wrong channel token is refused', async () => {
  const server = await startMockRendererServer()
  try {
    const session = await openClientSession(server)
    const rogue = new WebSocket(session.created.media.url, { headers: { authorization: 'Bearer nope' } })
    const result = await Promise.race([
      new Promise(resolve => rogue.addEventListener('open', () => resolve('open'))),
      new Promise(resolve => rogue.addEventListener('error', () => resolve('refused'))),
      new Promise(resolve => rogue.addEventListener('close', () => resolve('refused'))),
    ])
    assert.equal(result, 'refused')
    await session.close()
  } finally { await server.close() }
})

test('fault first_media_timeout admits input but publishes nothing', async () => {
  const server = await startMockRendererServer({ fault: 'first_media_timeout', heartbeatIntervalMs: 100 })
  try {
    const session = await openClientSession(server)
    await session.waitFor(() => session.inputEvents.some(e => e.event === 'session.ready'), 'session.ready')
    const tone = tonePcm({ durationMs: 200 })
    session.input.send(encodeControl({ op: ControlOp.START, requestId: 'r1', turn: session.turn }))
    session.input.send(encodeInputPcm({ turn: session.turn, sequence: 0, sampleOffset: 0, samples: tone.samples, payload: tone.buffer }))
    await new Promise(resolve => setTimeout(resolve, 400))
    assert.ok(!session.mediaRecords.some(r => r.kind === RecordKind.PAIRED_AV))
    assert.ok(session.inputEvents.some(e => e.event === 'heartbeat'), 'session stays alive')
    await session.close()
  } finally { await server.close() }
})

test('fault media_stall publishes one unit then stops progress', async () => {
  const server = await startMockRendererServer({ fault: 'media_stall', heartbeatIntervalMs: 100 })
  try {
    const session = await openClientSession(server)
    await session.waitFor(() => session.inputEvents.some(e => e.event === 'session.ready'), 'session.ready')
    const tone = tonePcm({ durationMs: 400 })
    session.input.send(encodeControl({ op: ControlOp.START, requestId: 'r1', turn: session.turn }))
    session.input.send(encodeInputPcm({ turn: session.turn, sequence: 0, sampleOffset: 0, samples: tone.samples, payload: tone.buffer }))
    await session.waitFor(() => session.mediaRecords.some(r => r.kind === RecordKind.PAIRED_AV), 'first unit')
    await new Promise(resolve => setTimeout(resolve, 700))
    const units = session.mediaRecords.filter(r => r.kind === RecordKind.PAIRED_AV).length
    assert.equal(units, 1)
    assert.ok(!session.inputEvents.some(e => e.event === 'turn.progress'), 'progress stops with the stall')
    assert.ok(session.inputEvents.some(e => e.event === 'heartbeat'), 'heartbeat survives')
    await session.close()
  } finally { await server.close() }
})

test('media channel loss during a turn fails it instead of rendering into the void', async () => {
  const server = await startMockRendererServer()
  try {
    const session = await openClientSession(server)
    await session.waitFor(() => session.inputEvents.some(e => e.event === 'session.ready'), 'session.ready')
    const tone = tonePcm({ durationMs: 400 })
    session.input.send(encodeControl({ op: ControlOp.START, requestId: 'r1', turn: session.turn }))
    session.input.send(encodeInputPcm({ turn: session.turn, sequence: 0, sampleOffset: 0, samples: tone.samples, payload: tone.buffer }))
    await session.waitFor(() => session.mediaRecords.some(r => r.kind === RecordKind.PAIRED_AV), 'first unit')
    session.media.terminate()
    await session.waitFor(() => session.inputEvents.some(e => e.event === 'provider.error'), 'provider.error')
    const error = session.inputEvents.find(e => e.event === 'provider.error')
    assert.equal(error.code, 'unavailable')
    assert.equal(error.rebuild, true)
    await session.close()
  } finally { await server.close() }
})

test('media events decode through the shared envelope helper', async () => {
  const frame = decodeMediaEvent(JSON.stringify({ protocol: 'dhav', version: 1, event: 'heartbeat' }))
  assert.equal(frame.event, 'heartbeat')
})
