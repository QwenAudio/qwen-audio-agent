import assert from 'node:assert/strict'
import test from 'node:test'
import { DigitalHumanOrchestrator } from '../presentation/orchestrator.mjs'
import {
  DIGITAL_HUMAN_MEDIA_CONTROL,
  DIGITAL_HUMAN_MEDIA_OPEN,
  DIGITAL_HUMAN_STATE,
} from '../presentation/orchestrator.mjs'
import { AudioRoute, DigitalHumanState, SelectorState } from '../presentation/contracts.mjs'
import {
  assertDigitalHumanOptions,
  createDigitalHumanRuntime,
} from '../presentation/index.mjs'

const FORMAT = { encoding: 'pcm_s16le', sampleRate: 24000, channels: 1 }
const CAPABILITIES = {
  version: 1,
  streamingAudio: true,
  inputAudioFormats: [FORMAT],
  textInput: 'none',
  interrupt: true,
  idle: true,
  outputModes: ['paired_av'],
}

function createFakeSession({ avatarSessionId = 'avs-1' } = {}) {
  const calls = []
  const queue = []
  let notify = null
  let closed = false
  let appendError = null
  const session = {
    avatarSessionId,
    mediaBinding: { adapterId: 'fake-av', protocol: 'fake', protocolVersion: 1, media: { url: 'ws://renderer.test/media', token: 'media-token' } },
    calls,
    get closed() { return closed },
    setAppendError(error) { appendError = error },
    async startTurn(ref) { calls.push({ op: 'startTurn', ref: { ...ref } }) },
    async appendAudio(input) {
      calls.push({ op: 'appendAudio', sequence: input.sequence, sampleOffset: input.sampleOffset, bytes: input.data.length, ref: { ...input } })
      if (appendError) throw appendError
    },
    async finishTurn(input) { calls.push({ op: 'finishTurn', lastAudioSequence: input.lastAudioSequence, totalSamples: input.totalSamples, ref: { ...input } }) },
    async interruptTurn(input) { calls.push({ op: 'interruptTurn', reason: input.reason, ref: { ...input } }) },
    async close() {
      calls.push({ op: 'close' })
      closed = true
      const n = notify
      notify = null
      n?.()
    },
    async *events() {
      for (;;) {
        if (queue.length) { yield queue.shift(); continue }
        if (closed) return
        await new Promise(resolve => { notify = resolve })
      }
    },
    pushEvent(event) {
      queue.push(event)
      const n = notify
      notify = null
      n?.()
    },
  }
  return session
}

function createFakeProvider({ capabilities = CAPABILITIES } = {}) {
  const sessions = []
  let openError = null
  return {
    sessions,
    setOpenError(error) { openError = error },
    async capabilities() { return capabilities },
    async openSession() {
      if (openError) throw openError
      const session = createFakeSession({ avatarSessionId: `avs-${sessions.length + 1}` })
      sessions.push(session)
      return session
    },
  }
}

function pcmDelta(samples) {
  return Buffer.alloc(samples * 2, 3).toString('base64')
}

async function setup({ orchestratorOptions = {}, providerOptions = {} } = {}) {
  const provider = createFakeProvider(providerOptions)
  const published = []
  const flushes = []
  const orchestrator = new DigitalHumanOrchestrator({
    provider,
    persona: Object.freeze({ personaId: 'p1', avatarAssetId: 'asset-1' }),
    format: FORMAT,
    publish: event => published.push(event),
    onFlushAudio: info => flushes.push(info),
    firstMediaTimeoutMs: 0, // disabled unless a test overrides it
    ...orchestratorOptions,
  })
  await orchestrator.start()
  const session = provider.sessions[0]
  session.pushEvent({ type: 'session.ready', avatarSessionId: session.avatarSessionId })
  await waitFor(() => orchestrator.ready)
  return { orchestrator, provider, session, published, flushes }
}

function waitFor(check, ms = 3000, label = 'condition') {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (check()) { clearInterval(timer); resolve() } else if (Date.now() - started > ms) {
        clearInterval(timer)
        reject(new Error(`timeout waiting for ${label}`))
      }
    }, 5)
    timer.unref?.()
  })
}

function states(published) {
  return published.filter(e => e.type === DIGITAL_HUMAN_STATE).map(e => e.state)
}

function controls(published) {
  return published.filter(e => e.type === DIGITAL_HUMAN_MEDIA_CONTROL)
}

test('start publishes media_open and waits for session.ready', async () => {
  const { orchestrator, published, session } = await setup()
  const open = published.find(e => e.type === DIGITAL_HUMAN_MEDIA_OPEN)
  assert.ok(open)
  assert.equal(open.binding.media.token, 'media-token')
  assert.equal(open.avatarSessionId, session.avatarSessionId)
  assert.ok(states(published).includes(DigitalHumanState.IDLE))
  await orchestrator.close()
})

test('happy path: divert, commit on published, three-layer completion', async () => {
  const { orchestrator, session, published } = await setup()
  orchestrator.responseStart({ responseId: 'resp-1', turnId: 'turn-1' })
  const d1 = orchestrator.routeAudio({ responseId: 'resp-1', delta: pcmDelta(240) })
  const d2 = orchestrator.routeAudio({ responseId: 'resp-1', delta: pcmDelta(240), sampleRate: 24000 })
  const d3 = orchestrator.routeAudio({ responseId: 'resp-1', delta: pcmDelta(480) })
  assert.deepEqual([d1.route, d2.route, d3.route], [AudioRoute.DIVERT, AudioRoute.DIVERT, AudioRoute.DIVERT])
  await orchestrator.settled('resp-1')

  const appends = session.calls.filter(c => c.op === 'appendAudio')
  assert.equal(appends.length, 3)
  assert.deepEqual(appends.map(c => c.sequence), [0, 1, 2])
  assert.deepEqual(appends.map(c => c.sampleOffset), [0, 240, 480])
  assert.deepEqual(appends.map(c => c.bytes), [480, 480, 960])
  const start = session.calls.find(c => c.op === 'startTurn')
  assert.deepEqual(start.ref, { avatarSessionId: 'avs-1', responseId: 'resp-1', generation: 0 })
  assert.ok(controls(published).some(c => c.op === 'begin' && c.turn.responseId === 'resp-1'))

  // Provider first_media is informational; commit waits for worker publication.
  session.pushEvent({ type: 'turn.first_media', turn: start.ref })
  await orchestrator.settled('resp-1')
  assert.equal(orchestrator.selectorState('resp-1'), SelectorState.BUFFERING)
  orchestrator.mediaPublished({ responseId: 'resp-1', generation: 0 })
  assert.equal(orchestrator.selectorState('resp-1'), SelectorState.COMMITTED_AVATAR)
  assert.ok(states(published).includes(DigitalHumanState.SPEAKING))

  orchestrator.responseFinish({ responseId: 'resp-1' })
  await orchestrator.settled('resp-1')
  const finish = session.calls.find(c => c.op === 'finishTurn')
  assert.equal(finish.lastAudioSequence, 2)
  assert.equal(finish.totalSamples, 960)

  // Layer 2: provider + worker drained.
  session.pushEvent({ type: 'turn.completed', turn: start.ref, lastSequence: 9 })
  await waitFor(() => orchestrator.completionSnapshot('resp-1')?.providerDone)
  orchestrator.mediaDrained({ responseId: 'resp-1', generation: 0 })
  assert.equal(orchestrator.selectorState('resp-1'), SelectorState.DRAINING)

  // Layer 3: only the client playback receipt reaches terminal.
  const snapshot = orchestrator.completionSnapshot('resp-1')
  assert.deepEqual(
    { modelDone: snapshot.modelDone, providerDone: snapshot.providerDone, mediaDrained: snapshot.mediaDrained, playbackEnded: snapshot.playbackEnded },
    { modelDone: true, providerDone: true, mediaDrained: true, playbackEnded: false },
  )
  orchestrator.playbackEnded({ responseId: 'resp-1' })
  assert.equal(orchestrator.completionSnapshot('resp-1'), null) // cleaned up
  await orchestrator.close()
})

test('provider.error before commit flushes buffered audio in order', async () => {
  const { orchestrator, session, flushes, published } = await setup()
  orchestrator.responseStart({ responseId: 'resp-1' })
  const a = pcmDelta(240)
  const b = pcmDelta(240)
  orchestrator.routeAudio({ responseId: 'resp-1', delta: a })
  orchestrator.routeAudio({ responseId: 'resp-1', delta: b })
  await orchestrator.settled('resp-1')
  session.pushEvent({ type: 'provider.error', turn: { avatarSessionId: 'avs-1', responseId: 'resp-1', generation: 0 }, code: 'unavailable', message: 'boom', rebuild: false })
  await waitFor(() => flushes.length === 1)
  assert.deepEqual(flushes[0], { responseId: 'resp-1', deltas: [a, b] })
  assert.equal(orchestrator.mode, 'audio_only')
  const audioOnly = published.filter(e => e.type === DIGITAL_HUMAN_STATE && e.state === DigitalHumanState.AUDIO_ONLY)
  assert.equal(audioOnly.length, 1)
  assert.equal(audioOnly[0].code, 'unavailable')
  await orchestrator.settled('resp-1')
  assert.ok(session.calls.some(c => c.op === 'interruptTurn' && c.reason === 'provider_failure'))
  // Later deltas of the same response pass straight to normal audio egress.
  assert.equal(orchestrator.routeAudio({ responseId: 'resp-1', delta: pcmDelta(240) }).route, AudioRoute.PASS)
  await orchestrator.close()
})

test('provider.error after avatar commit cancels without replay', async () => {
  const { orchestrator, session, flushes } = await setup()
  orchestrator.responseStart({ responseId: 'resp-1' })
  orchestrator.routeAudio({ responseId: 'resp-1', delta: pcmDelta(240) })
  await orchestrator.settled('resp-1')
  orchestrator.mediaPublished({ responseId: 'resp-1', generation: 0 })
  session.pushEvent({ type: 'provider.error', turn: { avatarSessionId: 'avs-1', responseId: 'resp-1', generation: 0 }, code: 'invalid_media', message: 'corrupt frame', rebuild: false })
  await waitFor(() => orchestrator.mode === 'audio_only')
  await orchestrator.settled('resp-1')
  assert.equal(flushes.length, 0, 'published audio must never be replayed from the start')
  assert.ok(session.calls.some(c => c.op === 'interruptTurn'))
  await orchestrator.close()
})

test('first media timeout falls back and interrupts the turn', async () => {
  const { orchestrator, session, flushes, published } = await setup({ orchestratorOptions: { firstMediaTimeoutMs: 40 } })
  orchestrator.responseStart({ responseId: 'resp-1' })
  const a = pcmDelta(240)
  orchestrator.routeAudio({ responseId: 'resp-1', delta: a })
  await orchestrator.settled('resp-1')
  await waitFor(() => flushes.length === 1, 3000, 'timeout flush')
  assert.deepEqual(flushes[0].deltas, [a])
  const audioOnly = published.find(e => e.type === DIGITAL_HUMAN_STATE && e.state === DigitalHumanState.AUDIO_ONLY)
  assert.equal(audioOnly.code, 'first_media_timeout')
  await orchestrator.settled('resp-1')
  assert.ok(session.calls.some(c => c.op === 'interruptTurn'))
  assert.equal(orchestrator.selectorState('resp-1'), SelectorState.COMMITTED_AUDIO)
  // The quarantine must not close the response's plain-audio egress: the flush
  // above replays under this same responseId, and a blocked response would make
  // the whole fallback reply silent (stranding the transcript it gates).
  const quarantine = controls(published).find(c => c.op === 'clear')
  assert.equal(quarantine.block, false)
  await orchestrator.close()
})

test('late avatar first frame after fallback is ignored', async () => {
  const { orchestrator, published } = await setup({ orchestratorOptions: { firstMediaTimeoutMs: 30 } })
  orchestrator.responseStart({ responseId: 'resp-1' })
  orchestrator.routeAudio({ responseId: 'resp-1', delta: pcmDelta(240) })
  await orchestrator.settled('resp-1')
  await waitFor(() => orchestrator.selectorState('resp-1') === SelectorState.COMMITTED_AUDIO, 3000, 'fallback')
  // The generation was already bumped and cleared; a late publication event
  // from the stale generation must not commit or emit speaking state.
  orchestrator.mediaPublished({ responseId: 'resp-1', generation: 0 })
  assert.equal(orchestrator.selectorState('resp-1'), SelectorState.COMMITTED_AUDIO)
  assert.equal(states(published).includes(DigitalHumanState.SPEAKING), false)
  await orchestrator.close()
})

test('cancel interrupts, clears media and bumps the generation', async () => {
  const { orchestrator, session, published } = await setup()
  orchestrator.responseStart({ responseId: 'resp-1' })
  orchestrator.routeAudio({ responseId: 'resp-1', delta: pcmDelta(240) })
  await orchestrator.settled('resp-1')
  orchestrator.responseCancel({ responseId: 'resp-1', reason: 'user_interruption' })
  await orchestrator.settled('resp-1')
  const interrupt = session.calls.find(c => c.op === 'interruptTurn')
  assert.equal(interrupt.reason, 'user_interruption')
  // A cancel keeps the egress closed, unlike a pre-commit fallback.
  assert.ok(controls(published).some(c => c.op === 'clear' && c.generation === 0 && c.block !== false))
  assert.equal(orchestrator.generation, 1)
  // Stale generation events are isolated.
  session.pushEvent({ type: 'turn.completed', turn: { avatarSessionId: 'avs-1', responseId: 'resp-1', generation: 0 } })
  orchestrator.mediaPublished({ responseId: 'resp-1', generation: 0 })
  await orchestrator.settled('resp-1')
  assert.equal(orchestrator.selectorState('resp-1'), null)
  // The next response uses the new generation.
  orchestrator.responseStart({ responseId: 'resp-2' })
  const start = session.calls.filter(c => c.op === 'startTurn').length
  orchestrator.routeAudio({ responseId: 'resp-2', delta: pcmDelta(240) })
  await orchestrator.settled('resp-2')
  const starts = session.calls.filter(c => c.op === 'startTurn')
  assert.equal(starts.length, start + 1)
  assert.equal(starts[starts.length - 1].ref.generation, 1)
  await orchestrator.close()
})

test('unknown cancel reasons are rejected', async () => {
  const { orchestrator } = await setup()
  orchestrator.responseStart({ responseId: 'resp-1' })
  assert.throws(() => orchestrator.responseCancel({ responseId: 'resp-1', reason: 'because' }), /cancel reason/)
  await orchestrator.close()
})

test('a new response supersedes the active one as user interruption', async () => {
  const { orchestrator, session } = await setup()
  orchestrator.responseStart({ responseId: 'resp-1' })
  orchestrator.routeAudio({ responseId: 'resp-1', delta: pcmDelta(240) })
  await orchestrator.settled('resp-1')
  orchestrator.responseStart({ responseId: 'resp-2' })
  await orchestrator.settled('resp-1')
  const interrupt = session.calls.find(c => c.op === 'interruptTurn')
  assert.equal(interrupt.reason, 'user_interruption')
  assert.equal(interrupt.ref.responseId, 'resp-1')
  assert.equal(orchestrator.generation, 1)
  await orchestrator.close()
})

test('sample rate mismatch degrades only that response to pass-through', async () => {
  const { orchestrator, session } = await setup()
  orchestrator.responseStart({ responseId: 'resp-1' })
  const decision = orchestrator.routeAudio({ responseId: 'resp-1', delta: pcmDelta(240), sampleRate: 16000 })
  assert.equal(decision.route, AudioRoute.PASS)
  assert.equal(orchestrator.routeAudio({ responseId: 'resp-1', delta: pcmDelta(240) }).route, AudioRoute.PASS)
  await orchestrator.settled('resp-1')
  assert.equal(session.calls.some(c => c.op === 'appendAudio'), false)
  assert.equal(orchestrator.mode, 'avatar', 'other responses may still use the avatar')
  await orchestrator.close()
})

test('a response without audio never starts a fake turn', async () => {
  const { orchestrator, session } = await setup()
  orchestrator.responseStart({ responseId: 'resp-1' })
  orchestrator.responseFinish({ responseId: 'resp-1' })
  await orchestrator.settled('resp-1')
  assert.equal(session.calls.some(c => c.op === 'startTurn'), false)
  assert.equal(session.calls.some(c => c.op === 'finishTurn'), false)
  orchestrator.playbackEnded({ responseId: 'resp-1' })
  await orchestrator.close()
})

test('failed response.done discards media instead of draining', async () => {
  const { orchestrator, session } = await setup()
  orchestrator.responseStart({ responseId: 'resp-1' })
  orchestrator.routeAudio({ responseId: 'resp-1', delta: pcmDelta(240) })
  await orchestrator.settled('resp-1')
  orchestrator.responseFinish({ responseId: 'resp-1', failed: true })
  await orchestrator.settled('resp-1')
  assert.ok(session.calls.some(c => c.op === 'interruptTurn'))
  assert.equal(session.calls.some(c => c.op === 'finishTurn'), false)
  await orchestrator.close()
})

test('appendAudio failure degrades the response, not the connection', async () => {
  const { orchestrator, session, flushes } = await setup()
  session.setAppendError(Object.assign(new Error('queue full'), { code: 'capacity_exhausted' }))
  orchestrator.responseStart({ responseId: 'resp-1' })
  orchestrator.routeAudio({ responseId: 'resp-1', delta: pcmDelta(240) })
  await waitFor(() => orchestrator.mode === 'audio_only', 3000, 'degraded mode')
  await orchestrator.settled('resp-1')
  // The turn never produced media, so nothing was published; the buffered
  // delta is not flushed by the chain-failure path (selector committed audio
  // only via degrade) — assert the response survives as pass-through.
  assert.equal(orchestrator.routeAudio({ responseId: 'resp-1', delta: pcmDelta(240) }).route, AudioRoute.PASS)
  assert.ok(flushes.length <= 1)
  await orchestrator.close()
})

test('rebuild creates a fresh session with a new avatarSessionId and generation', async () => {
  const { orchestrator, provider, session, published } = await setup()
  orchestrator.responseStart({ responseId: 'resp-1' })
  orchestrator.routeAudio({ responseId: 'resp-1', delta: pcmDelta(240) })
  await orchestrator.settled('resp-1')
  orchestrator.mediaPublished({ responseId: 'resp-1', generation: 0 })
  const generationBefore = orchestrator.generation
  session.pushEvent({ type: 'provider.error', turn: { avatarSessionId: 'avs-1', responseId: 'resp-1', generation: 0 }, code: 'media_stalled', message: 'stalled', rebuild: true })
  await waitFor(() => provider.sessions.length === 2, 3000, 'rebuilt session')
  const next = provider.sessions[1]
  next.pushEvent({ type: 'session.ready', avatarSessionId: next.avatarSessionId })
  await waitFor(() => orchestrator.ready && orchestrator.mode === 'avatar', 3000, 'ready again')
  assert.ok(orchestrator.generation > generationBefore)
  assert.equal(orchestrator.avatarSessionId, 'avs-2')
  assert.equal(published.filter(e => e.type === DIGITAL_HUMAN_MEDIA_OPEN).length, 2)
  assert.ok(session.closed)
  // The new turn carries the new avatar session id.
  orchestrator.responseStart({ responseId: 'resp-2' })
  orchestrator.routeAudio({ responseId: 'resp-2', delta: pcmDelta(240) })
  await orchestrator.settled('resp-2')
  const start = next.calls.find(c => c.op === 'startTurn')
  assert.equal(start.ref.avatarSessionId, 'avs-2')
  assert.ok(start.ref.generation >= orchestrator.generation - 1)
  await orchestrator.close()
})

test('close interrupts the active turn and closes the session', async () => {
  const { orchestrator, session } = await setup()
  orchestrator.responseStart({ responseId: 'resp-1' })
  orchestrator.routeAudio({ responseId: 'resp-1', delta: pcmDelta(240) })
  await orchestrator.settled('resp-1')
  await orchestrator.close('owner_replaced')
  const interrupt = session.calls.find(c => c.op === 'interruptTurn')
  assert.equal(interrupt.reason, 'owner_replaced')
  assert.ok(session.closed)
  await orchestrator.close() // idempotent
})

test('start surfaces provider open failures to the caller', async () => {
  const provider = createFakeProvider()
  provider.setOpenError(Object.assign(new Error('renderer down'), { code: 'unavailable' }))
  const orchestrator = new DigitalHumanOrchestrator({
    provider,
    persona: { personaId: 'p1', avatarAssetId: 'a' },
    format: FORMAT,
    publish: () => {},
  })
  await assert.rejects(() => orchestrator.start(), /renderer down/)
})

// -- composition root -------------------------------------------------------

function validOptions(overrides = {}) {
  return {
    provider: createFakeProvider(),
    personas: { 'mock-default': { avatarAssetId: 'asset-1' } },
    rendererAllowlist: ['http://127.0.0.1:18901'],
    mediaAdapter: { modulePath: '/tmp/framed-av-source.mjs' },
    ...overrides,
  }
}

test('assertDigitalHumanOptions accepts null and rejects malformed config', () => {
  assert.equal(assertDigitalHumanOptions(null), null)
  assert.equal(assertDigitalHumanOptions(undefined), null)
  assert.ok(assertDigitalHumanOptions(validOptions()))
  assert.throws(() => assertDigitalHumanOptions(validOptions({ provider: {} })), /capabilities/)
  assert.throws(() => assertDigitalHumanOptions(validOptions({ personas: {} })), /allowlist/)
  assert.throws(() => assertDigitalHumanOptions(validOptions({ personas: { 'Bad ID': { avatarAssetId: 'a' } } })), /persona id/)
  assert.throws(() => assertDigitalHumanOptions(validOptions({ personas: { p: { } } })), /avatarAssetId/)
  assert.throws(() => assertDigitalHumanOptions(validOptions({ rendererAllowlist: [] })), /rendererAllowlist/)
  assert.throws(() => assertDigitalHumanOptions(validOptions({ rendererAllowlist: ['127.0.0.1:18901'] })), /absolute/)
  assert.throws(() => assertDigitalHumanOptions(validOptions({ rendererAllowlist: ['file:///etc/passwd'] })), /http/)
  assert.throws(() => assertDigitalHumanOptions(validOptions({ mediaAdapter: { modulePath: 'relative/path.mjs' } })), /absolute/)
  assert.throws(() => assertDigitalHumanOptions(validOptions({ firstMediaTimeoutMs: -5 })), /firstMediaTimeoutMs/)
})

test('createDigitalHumanRuntime resolves the persona and negotiates the format', async () => {
  const options = validOptions()
  const runtime = await createDigitalHumanRuntime({ options, personaId: 'mock-default', publish: () => {} })
  assert.ok(runtime instanceof DigitalHumanOrchestrator)
  assert.equal(runtime.personaId, 'mock-default')
  assert.equal(runtime.capabilities.version, 1)
  await runtime.close()
  await assert.rejects(
    () => createDigitalHumanRuntime({ options, personaId: 'not-listed', publish: () => {} }),
    /not in the server allowlist/,
  )
})

test('createDigitalHumanRuntime returns null when the provider lacks the input format', async () => {
  const provider = createFakeProvider({
    capabilities: { ...CAPABILITIES, inputAudioFormats: [{ encoding: 'pcm_s16le', sampleRate: 16000, channels: 1 }] },
  })
  const runtime = await createDigitalHumanRuntime({ options: validOptions({ provider }), personaId: 'mock-default', publish: () => {} })
  assert.equal(runtime, null)
})

test('createDigitalHumanRuntime rejects unsupported capability versions', async () => {
  const provider = createFakeProvider({ capabilities: { ...CAPABILITIES, version: 2 } })
  await assert.rejects(
    () => createDigitalHumanRuntime({ options: validOptions({ provider }), personaId: 'mock-default', publish: () => {} }),
    /capability version 1/,
  )
})

// -- gateway-driven idle turn ------------------------------------------------

const idleBegan = published => controls(published).some(
  c => c.op === 'begin' && c.turn.responseId === 'dh-idle' && c.idle === true,
)

test('idle: a silence turn starts after session.ready and feeds the renderer', async () => {
  const { orchestrator, session, published } = await setup({ orchestratorOptions: { idle: true } })
  await waitFor(() => idleBegan(published), 1000, 'idle begin')
  const idleStart = session.calls.find(c => c.op === 'startTurn' && c.ref.responseId === 'dh-idle')
  assert.equal(idleStart.ref.generation, 0)
  // Silence is fed continuously at the renderer's 40 ms / 960-sample cadence.
  await waitFor(() => session.calls.filter(c => c.op === 'appendAudio' && c.ref.responseId === 'dh-idle').length >= 2, 1000, 'idle appends')
  const appends = session.calls.filter(c => c.op === 'appendAudio' && c.ref.responseId === 'dh-idle').slice(0, 2)
  assert.deepEqual(appends.map(c => c.sequence), [0, 1])
  assert.deepEqual(appends.map(c => c.sampleOffset), [0, 960])
  assert.deepEqual(appends.map(c => c.bytes), [1920, 1920])
  await orchestrator.close()
})

test('idle: a real reply supersedes the idle turn and isolates its generation', async () => {
  const { orchestrator, session, published } = await setup({ orchestratorOptions: { idle: true } })
  await waitFor(() => idleBegan(published), 1000, 'idle begin')
  const idleGen = session.calls.find(c => c.op === 'startTurn' && c.ref.responseId === 'dh-idle').ref.generation
  orchestrator.responseStart({ responseId: 'resp-1' })
  orchestrator.routeAudio({ responseId: 'resp-1', delta: pcmDelta(240) })
  await orchestrator.settled('resp-1')
  // The idle turn was interrupted and its generation cleared before the reply.
  assert.ok(session.calls.some(c => c.op === 'interruptTurn' && c.ref.responseId === 'dh-idle'))
  assert.ok(controls(published).some(c => c.op === 'clear' && c.generation === idleGen))
  // The reply runs at a fresh generation and is not flagged idle.
  const realStart = session.calls.find(c => c.op === 'startTurn' && c.ref.responseId === 'resp-1')
  assert.ok(realStart.ref.generation > idleGen)
  assert.ok(controls(published).some(c => c.op === 'begin' && c.turn.responseId === 'resp-1' && !c.idle))
  await orchestrator.close()
})

test('idle: restarts after a user interruption', async () => {
  const { orchestrator, session, published } = await setup({ orchestratorOptions: { idle: true } })
  await waitFor(() => idleBegan(published), 1000, 'idle begin')
  orchestrator.responseStart({ responseId: 'resp-1' })
  orchestrator.routeAudio({ responseId: 'resp-1', delta: pcmDelta(240) })
  await orchestrator.settled('resp-1')
  orchestrator.cancelActive('user_interruption')
  await waitFor(
    () => session.calls.filter(c => c.op === 'startTurn' && c.ref.responseId === 'dh-idle').length >= 2,
    1000, 'idle restart',
  )
  await orchestrator.close()
})

test('idle: a turn-level idle error stops idle without degrading the session', async () => {
  const { orchestrator, provider, session, published } = await setup({ orchestratorOptions: { idle: true } })
  await waitFor(() => idleBegan(published), 1000, 'idle begin')
  const idleRef = session.calls.find(c => c.op === 'startTurn' && c.ref.responseId === 'dh-idle').ref
  // Renderer produced no idle first media in time: a turn-level failure. The
  // fake session stays open (no `state: 'closed'`), so avatar mode is preserved.
  session.pushEvent({ type: 'provider.error', turn: idleRef, code: 'first_media_timeout', rebuild: true })
  await waitFor(() => session.calls.some(c => c.op === 'interruptTurn' && c.ref.responseId === 'dh-idle'), 1000, 'idle interrupt')
  assert.equal(orchestrator.mode, 'avatar')
  assert.ok(!states(published).includes(DigitalHumanState.AUDIO_ONLY))
  assert.equal(provider.sessions.length, 1) // no rebuild opened a second session
  await orchestrator.close()
})

test('idle: a feed failure restarts idle, boundedly, without degrading the session', async () => {
  const { orchestrator, session, published } = await setup({ orchestratorOptions: { idle: true } })
  const idleStarts = () => session.calls.filter(c => c.op === 'startTurn' && c.ref.responseId === 'dh-idle').length
  await waitFor(() => idleStarts() === 1, 3000, 'first idle turn')

  // The renderer-side idle turn vanished (a stall cancelled it), so every silence
  // block is now rejected with "no active turn". Idle must come back instead of
  // freezing the avatar on its last frame — but it must not hot-loop forever.
  session.setAppendError(Object.assign(new Error('no active turn'), { code: 'protocol_error' }))
  // 500ms + 1s + 2s of exponential backoff between the bounded restarts.
  await waitFor(() => idleStarts() === 4, 8000, 'bounded idle restarts')
  await new Promise(resolve => setTimeout(resolve, 200))
  assert.equal(idleStarts(), 4, 'idle restarts stop after MAX_IDLE_RESTARTS')
  assert.equal(orchestrator.mode, 'avatar')
  assert.ok(!states(published).includes(DigitalHumanState.AUDIO_ONLY))

  // A real reply proves the session healthy, so idle retries re-arm afterwards.
  session.setAppendError(null)
  orchestrator.responseStart({ responseId: 'resp-1' })
  orchestrator.routeAudio({ responseId: 'resp-1', delta: pcmDelta(240) })
  await orchestrator.settled('resp-1')
  orchestrator.playbackEnded({ responseId: 'resp-1' })
  await waitFor(() => idleStarts() > 4, 3000, 'idle re-armed after a healthy real turn')
  await orchestrator.close()
})
