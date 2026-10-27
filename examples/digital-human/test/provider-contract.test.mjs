import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { startMockRendererServer } from '../providers/mock/mock-renderer-server.mjs'
import { createDhavProvider, DhavProviderError } from '../providers/dhav-provider.mjs'
import { RecordKind, decodeRecord } from '../protocol/dhav.mjs'
import { tonePcm, chunkPcm } from '../fixtures/generate.mjs'

const require = createRequire(import.meta.url)
const { WebSocket } = require('ws')

const PERSONA = Object.freeze({ personaId: 'mock-default', avatarAssetId: 'mock-pattern' })

function withTimeout(promise, ms, label) {
  return Promise.race([promise, new Promise((_resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${label}`)), ms)
    timer.unref?.()
  })])
}

// The input and media channels are independent sockets; cross-channel
// ordering is not guaranteed, so poll for media-channel records.
function waitForMedia(check, ms = 6000, label = 'media record') {
  return withTimeout(new Promise(resolve => {
    const timer = setInterval(() => { if (check()) { clearInterval(timer); resolve() } }, 20)
    timer.unref?.()
  }), ms, label)
}

// One harness per scenario: mock renderer + provider + a raw media-channel
// consumer standing in for the media worker.
async function setup({ fault = null, providerOptions = {}, persona = PERSONA } = {}) {
  const server = await startMockRendererServer({ fault, heartbeatIntervalMs: 100 })
  const provider = createDhavProvider({ rendererBaseUrl: server.url, firstMediaTimeoutMs: 1500, mediaStallTimeoutMs: 800, heartbeatTimeoutMs: 2000, ...providerOptions })
  const collected = []
  const waiters = new Set()
  const notify = () => { for (const check of [...waiters]) check() }
  let mediaSocket = null
  const mediaUnits = []

  const session = await provider.openSession({ persona, format: { encoding: 'pcm_s16le', sampleRate: 24000, channels: 1 }, signal: providerOptions.signal })
  mediaSocket = new WebSocket(session.mediaBinding.media.url, { headers: { authorization: `Bearer ${session.mediaBinding.media.token}` } })
  mediaSocket.binaryType = 'nodebuffer'
  mediaSocket.addEventListener('message', ({ data }) => {
    if (typeof data === 'string') return
    mediaUnits.push(decodeRecord(data))
  })
  await withTimeout(new Promise(resolve => mediaSocket.addEventListener('open', resolve)), 3000, 'media open')

  const pump = (async () => { for await (const event of session.events()) { collected.push(event); notify() } })()
  pump.catch(() => {})

  const api = {
    server, provider, session, collected, mediaUnits,
    waitForEvent(predicate, label, ms = 6000) {
      return withTimeout(new Promise(resolve => {
        const check = () => { if (predicate(collected)) { waiters.delete(check); resolve() } }
        waiters.add(check)
        check()
      }), ms, label)
    },
    async ready() {
      await api.waitForEvent(events => events.some(e => e.type === 'session.ready'), 'session.ready')
    },
    ref(generation = 0) {
      return { avatarSessionId: session.avatarSessionId, responseId: `resp-${generation}`, generation }
    },
    async appendTone(ref, { durationMs = 200, chunkSizes = [2400] } = {}) {
      const tone = tonePcm({ durationMs })
      let sampleOffset = 0
      let sequence = 0
      for (const chunk of chunkPcm(tone.buffer, chunkSizes.map(samples => samples))) {
        await session.appendAudio({ ...ref, sequence, sampleOffset, data: chunk })
        sampleOffset += chunk.length / 2
        sequence++
      }
      return { sequence: sequence - 1, totalSamples: sampleOffset }
    },
    async close() {
      await session.close()
      mediaSocket.close()
      await server.close()
    },
  }
  return api
}

test('capabilities are frozen and contract-shaped', async () => {
  const api = await setup()
  try {
    const capabilities = await api.provider.capabilities()
    assert.equal(capabilities.version, 1)
    assert.equal(capabilities.streamingAudio, true)
    assert.equal(capabilities.textInput, 'none')
    assert.equal(capabilities.interrupt, true)
    assert.equal(capabilities.idle, true)
    assert.deepEqual(capabilities.outputModes, ['paired_av'])
    assert.deepEqual(capabilities.inputAudioFormats[0], { encoding: 'pcm_s16le', sampleRate: 24000, channels: 1 })
  } finally { await api.close() }
})

test('mediaBinding carries only scoped media credentials', async () => {
  const api = await setup()
  try {
    const binding = api.session.mediaBinding
    assert.equal(binding.protocol, 'dhav')
    assert.equal(binding.protocolVersion, 1)
    assert.ok(binding.media.url.endsWith('/media'))
    assert.ok(binding.media.token)
    assert.equal(binding.input, undefined)
    assert.equal(binding.inputToken, undefined)
    assert.deepEqual(binding.video, { format: 'i420', width: 256, height: 256, fps: 25 })
  } finally { await api.close() }
})

test('full lifecycle: start -> append -> first_media -> finish -> completed', async () => {
  const api = await setup()
  try {
    await api.ready()
    const ref = api.ref(0)
    await api.session.startTurn(ref)
    const { sequence, totalSamples } = await api.appendTone(ref, { durationMs: 200, chunkSizes: [960, 1200, 2640] })
    await api.session.finishTurn({ ...ref, lastAudioSequence: sequence, totalSamples })
    await api.waitForEvent(events => events.some(e => e.type === 'turn.first_media' && e.turn.responseId === ref.responseId), 'turn.first_media')
    await api.waitForEvent(events => events.some(e => e.type === 'turn.completed'), 'turn.completed', 10000)
    await waitForMedia(() => api.mediaUnits.some(r => r.kind === RecordKind.MEDIA_END))
    const units = api.mediaUnits.filter(r => r.kind === RecordKind.PAIRED_AV)
    assert.ok(units.length >= 4, `expected full + padded frames, got ${units.length}`)
    assert.ok(api.mediaUnits.some(r => r.kind === RecordKind.MEDIA_END))
    const covered = units.reduce((sum, u) => sum + u.header.samples - u.header.paddingSamples, 0)
    assert.equal(covered, totalSamples)
    // event order: session.ready before first_media before completed
    const types = api.collected.map(e => e.type)
    assert.ok(types.indexOf('session.ready') < types.indexOf('turn.first_media'))
    assert.ok(types.indexOf('turn.first_media') < types.indexOf('turn.completed'))
    assert.ok(!api.collected.some(e => e.type === 'provider.error'), JSON.stringify(api.collected))
  } finally { await api.close() }
})

test('a second turn starts after the first completes on the same session', async () => {
  const api = await setup()
  try {
    await api.ready()
    const first = api.ref(0)
    await api.session.startTurn(first)
    const a = await api.appendTone(first, { durationMs: 120 })
    await api.session.finishTurn({ ...first, lastAudioSequence: a.sequence, totalSamples: a.totalSamples })
    await api.waitForEvent(events => events.some(e => e.type === 'turn.completed' && e.turn.responseId === first.responseId), 'turn.completed (1)', 10000)
    // Regression: turn.completed used to leave currentTurn set, so the next
    // startTurn threw 'previous turn still active' and turn 2 had no avatar.
    const second = { ...api.ref(0), responseId: 'resp-second' }
    await api.session.startTurn(second)
    const b = await api.appendTone(second, { durationMs: 120 })
    await api.session.finishTurn({ ...second, lastAudioSequence: b.sequence, totalSamples: b.totalSamples })
    await api.waitForEvent(events => events.some(e => e.type === 'turn.completed' && e.turn.responseId === second.responseId), 'turn.completed (2)', 10000)
    await waitForMedia(() => api.mediaUnits.filter(r => r.kind === RecordKind.MEDIA_END).length >= 2)
    assert.equal(api.collected.filter(e => e.type === 'turn.completed').length, 2)
    assert.ok(!api.collected.some(e => e.type === 'provider.error'), JSON.stringify(api.collected))
  } finally { await api.close() }
})

test('a new turn supersedes an active turn without a separate cancel (barge-in)', async () => {
  const api = await setup()
  try {
    await api.ready()
    const first = api.ref(0)
    await api.session.startTurn(first)
    await api.appendTone(first, { durationMs: 400 })
    // Barge in before turn 1 finishes: startTurn must NOT throw 'previous turn
    // still active'. It writes CANCEL(first) then START(second) back-to-back on
    // the single ordered control socket, so the renderer stops turn 1 first.
    const second = { ...api.ref(1), responseId: 'resp-second' }
    await api.session.startTurn(second)
    const b = await api.appendTone(second, { durationMs: 120 })
    await api.session.finishTurn({ ...second, lastAudioSequence: b.sequence, totalSamples: b.totalSamples })
    await api.waitForEvent(events => events.some(e => e.type === 'turn.cancelled' && e.turn.responseId === first.responseId), 'turn.cancelled (1)', 10000)
    await api.waitForEvent(events => events.some(e => e.type === 'turn.completed' && e.turn.responseId === second.responseId), 'turn.completed (2)', 10000)
    assert.ok(!api.collected.some(e => e.type === 'provider.error'), JSON.stringify(api.collected))
  } finally { await api.close() }
})

test('openSession rejects unknown persona and exhausted capacity', async () => {
  const api = await setup()
  try {
    await assert.rejects(
      api.provider.openSession({ persona: { personaId: 'someone-else' } }),
      error => error instanceof DhavProviderError && error.code === 'unavailable',
    )
    await assert.rejects(
      api.provider.openSession({ persona: PERSONA }),
      error => error instanceof DhavProviderError && error.code === 'capacity_exhausted',
    )
  } finally { await api.close() }
})

test('appendAudio guards: no turn, wrong TurnRef, sequence gap, sealed turn', async () => {
  const api = await setup()
  try {
    await api.ready()
    const ref = api.ref(0)
    const data = tonePcm({ durationMs: 40 }).buffer
    await assert.rejects(api.session.appendAudio({ ...ref, sequence: 0, sampleOffset: 0, data }), { code: 'protocol_error' })
    await api.session.startTurn(ref)
    await assert.rejects(api.session.appendAudio({ ...ref, responseId: 'other', sequence: 0, sampleOffset: 0, data }), { code: 'protocol_error' })
    await api.session.appendAudio({ ...ref, sequence: 0, sampleOffset: 0, data })
    await assert.rejects(api.session.appendAudio({ ...ref, sequence: 2, sampleOffset: 960, data }), { code: 'protocol_error' })
    await api.session.finishTurn({ ...ref, lastAudioSequence: 0, totalSamples: 960 })
    await assert.rejects(api.session.appendAudio({ ...ref, sequence: 1, sampleOffset: 960, data }), { code: 'protocol_error' })
  } finally { await api.close() }
})

test('finishTurn rejects mismatched totals and is idempotent', async () => {
  const api = await setup()
  try {
    await api.ready()
    const ref = api.ref(0)
    await api.session.startTurn(ref)
    await api.session.appendAudio({ ...ref, sequence: 0, sampleOffset: 0, data: tonePcm({ durationMs: 40 }).buffer })
    await assert.rejects(api.session.finishTurn({ ...ref, lastAudioSequence: 5, totalSamples: 99999 }), { code: 'protocol_error' })
    await api.session.finishTurn({ ...ref, lastAudioSequence: 0, totalSamples: 960 })
    await api.session.finishTurn({ ...ref, lastAudioSequence: 0, totalSamples: 960 }) // idempotent
    await api.session.finishTurn({ ...ref, lastAudioSequence: 0, totalSamples: 960 })
    await api.waitForEvent(events => events.some(e => e.type === 'turn.completed'), 'turn.completed')
  } finally { await api.close() }
})

test('empty audio response completes without a fake speaking segment', async () => {
  const api = await setup()
  try {
    await api.ready()
    const ref = api.ref(0)
    await api.session.startTurn(ref)
    await api.session.finishTurn({ ...ref, lastAudioSequence: -1, totalSamples: 0 })
    await api.waitForEvent(events => events.some(e => e.type === 'turn.completed'), 'turn.completed')
    await waitForMedia(() => api.mediaUnits.some(r => r.kind === RecordKind.MEDIA_END))
    assert.ok(!api.mediaUnits.some(r => r.kind === RecordKind.PAIRED_AV))
    const end = api.mediaUnits.find(r => r.kind === RecordKind.MEDIA_END)
    assert.equal(end.header.lastSequence, -1)
    assert.ok(!api.collected.some(e => e.type === 'turn.first_media'))
  } finally { await api.close() }
})

test('interruptTurn cancels, is idempotent, and blocks further audio', async () => {
  const api = await setup()
  try {
    await api.ready()
    const ref = api.ref(0)
    await api.session.startTurn(ref)
    await api.appendTone(ref, { durationMs: 400 })
    await api.session.interruptTurn({ ...ref, reason: 'user_interruption' })
    await api.session.interruptTurn({ ...ref, reason: 'user_interruption' })
    await api.waitForEvent(events => events.some(e => e.type === 'turn.cancelled'), 'turn.cancelled')
    const cancelled = api.collected.find(e => e.type === 'turn.cancelled')
    assert.equal(cancelled.reason, 'user_interruption')
    await assert.rejects(api.session.appendAudio({ ...ref, sequence: 99, sampleOffset: 0, data: Buffer.alloc(2) }), { code: 'protocol_error' })
    assert.ok(!api.collected.some(e => e.type === 'turn.completed'))
  } finally { await api.close() }
})

test('first_media_timeout surfaces as provider error and cancels the turn', async () => {
  const api = await setup({ fault: 'first_media_timeout', providerOptions: { firstMediaTimeoutMs: 300 } })
  try {
    await api.ready()
    const ref = api.ref(0)
    await api.session.startTurn(ref)
    await api.appendTone(ref, { durationMs: 100 })
    await api.waitForEvent(events => events.some(e => e.type === 'provider.error'), 'provider.error')
    const error = api.collected.find(e => e.type === 'provider.error')
    assert.equal(error.code, 'first_media_timeout')
    assert.equal(error.rebuild, true)
    assert.deepEqual(error.turn, ref)
    assert.ok(!api.mediaUnits.some(r => r.kind === RecordKind.PAIRED_AV))
  } finally { await api.close() }
})

test('media stall after first media surfaces as media_stalled', async () => {
  const api = await setup({ fault: 'media_stall', providerOptions: { mediaStallTimeoutMs: 400 } })
  try {
    await api.ready()
    const ref = api.ref(0)
    await api.session.startTurn(ref)
    await api.appendTone(ref, { durationMs: 400 })
    await api.waitForEvent(events => events.some(e => e.type === 'turn.first_media'), 'turn.first_media')
    await api.waitForEvent(events => events.some(e => e.type === 'provider.error'), 'provider.error', 8000)
    assert.equal(api.collected.find(e => e.type === 'provider.error').code, 'media_stalled')
  } finally { await api.close() }
})

test('mid-turn renderer failure is reported with its error class', async () => {
  const api = await setup({ fault: 'mid_turn_failure' })
  try {
    await api.ready()
    const ref = api.ref(0)
    await api.session.startTurn(ref)
    await api.appendTone(ref, { durationMs: 400 })
    await api.waitForEvent(events => events.some(e => e.type === 'provider.error'), 'provider.error', 8000)
    const error = api.collected.find(e => e.type === 'provider.error')
    assert.equal(error.code, 'invalid_media')
    assert.equal(error.rebuild, true)
  } finally { await api.close() }
})

test('input channel drop fails the session and ends the event stream', async () => {
  const api = await setup({ fault: 'channel_drop' })
  try {
    await api.ready()
    const ref = api.ref(0)
    await api.session.startTurn(ref)
    await api.appendTone(ref, { durationMs: 400 })
    await api.waitForEvent(events => events.some(e => e.type === 'provider.error' && e.code === 'unavailable'), 'session failure', 8000)
    await withTimeout((async () => { for await (const _ of api.session.events()); })(), 2000, 'iterator end')
    assert.equal(api.session.state, 'closed')
  } finally { await api.close() }
})

test('close is idempotent, frees renderer capacity, and stops late events', async () => {
  const api = await setup()
  try {
    await api.ready()
    await api.session.close()
    await api.session.close()
    assert.equal(api.session.state, 'closed')
    await assert.rejects(api.session.startTurn(api.ref(0)), { code: 'unavailable' })
    // renderer capacity released: a fresh session opens on the same server
    const next = await api.provider.openSession({ persona: PERSONA })
    assert.ok(next.avatarSessionId)
    await next.close()
  } finally { await api.close() }
})

test('abort signal closes the session', async () => {
  const controller = new AbortController()
  const api = await setup({ providerOptions: { signal: controller.signal } })
  try {
    await api.ready()
    controller.abort()
    await withTimeout(new Promise(resolve => {
      const timer = setInterval(() => { if (api.session.state === 'closed') { clearInterval(timer); resolve() } }, 20)
      timer.unref?.()
    }), 2000, 'session closed after abort')
  } finally { await api.close() }
})

test('renderer protocol violation fails the session with protocol_error', async () => {
  const api = await setup({ fault: 'protocol_error' })
  try {
    await api.ready()
    await api.session.startTurn(api.ref(0))
    await api.waitForEvent(events => events.some(e => e.type === 'provider.error'), 'provider.error')
    assert.equal(api.collected.find(e => e.type === 'provider.error').code, 'protocol_error')
  } finally { await api.close() }
})
