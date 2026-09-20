import assert from 'node:assert/strict'
import test from 'node:test'
import { createFrontendRuntime } from '../src/app/frontend-runtime.mjs'
import { ConversationSync } from '../src/conversation/conversation-sync.mjs'
import { GatewayClientEvent } from '../../shared/protocol/realtime-events.mjs'

const tick = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

function harness(t, overrides = {}) {
  const frontends = [], warnings = []
  const provider = { key: 'test', label: 'Test', inputSampleRate: 16000, outputSampleRate: 24000 }
  const runtime = createFrontendRuntime({
    config: { sleepTimeoutMs: 0, announcementQuietMs: 0, announcementBatchMs: 0 },
    logger: { info() {}, debug() {}, error() {}, warn: (...args) => warnings.push(args) },
    conversationSync: new ConversationSync(),
    defaultRealtimeProvider: 'test',
    realtimeProviderRegistry: { resolve: () => provider },
    realtimeFrontendFactory: () => {
      const frontend = {
        provider, ready: false, closeCount: 0,
        async connect() { this.ready = true },
        close() { this.ready = false; this.closeCount++ },
        updateAgentContext() {}, clearPendingImage() {}, cancel() {},
      }
      frontends.push(frontend)
      return frontend
    },
    ...overrides,
  })
  t.after(() => runtime.close())
  const session = id => {
    const s = runtime.createSession({
      ownerId: 'owner', sessionId: id, send() {}, onTaskEvent() {}, actionCapabilities: {},
      voiceAccess: { isActive: () => true, claim: () => ({ granted: true }), release() {}, changed() {} },
    })
    s.start()
    s.handleClientEvent({ type: GatewayClientEvent.CONNECT, inputEnabled: true, outputEnabled: true }, {
      descriptor: { type: 'test', instanceId: id }, capabilities: [],
    })
    return s
  }
  return { runtime, session, frontends, warnings }
}

test('application initializes tool sources once, while each connection has its own frontend', async t => {
  const discovery = deferred()
  let initialized = 0, sourceClosed = 0
  const h = harness(t, { frontendToolSources: [{
    initialize() { initialized++; return discovery.promise },
    tools: () => [], close() { sourceClosed++ },
  }] })
  await tick()
  assert.equal(initialized, 1, 'discovery starts before any client connects')
  const first = h.session('one'), second = h.session('two')
  await tick()
  assert.equal(h.frontends.length, 0, 'model context waits for shared discovery')
  discovery.resolve()
  await tick()
  assert.equal(initialized, 1)
  assert.equal(h.frontends.length, 2)
  assert.equal(first.status().state, 'connected')
  assert.equal(second.status().state, 'connected')
  first.close()
  assert.equal(h.frontends[0].ready, false)
  assert.equal(h.frontends[1].ready, true, 'closing one session does not close another')
  await h.runtime.close()
  assert.deepEqual(h.frontends.map(f => f.closeCount), [1, 1])
  assert.equal(sourceClosed, 0, 'tool-source lifecycle remains with its application owner')
  assert.throws(() => h.runtime.createSession({}), /closed/)
})

test('application shutdown drains asynchronous observers and prevents late model creation', async t => {
  const observation = deferred(), discovery = deferred()
  const closed = []
  const h = harness(t, {
    frontendToolSources: [{ initialize: () => discovery.promise, tools: () => [] }],
    sessionObservers: [{ onSessionClosed: ({ sessionId }) => {
      closed.push(sessionId)
      return observation.promise
    } }],
  })
  h.session('closing')
  let drained = false
  const shutdown = h.runtime.close().then(() => { drained = true })
  await tick()
  assert.deepEqual(closed, ['closing'])
  assert.equal(drained, false)
  discovery.resolve()
  await tick()
  assert.equal(h.frontends.length, 0)
  observation.resolve()
  await shutdown
  await h.runtime.close()
  assert.deepEqual(closed, ['closing'], 'shutdown is idempotent')
})

test('tool-source initialization failure is reported without preventing basic chat', async t => {
  const h = harness(t, { frontendToolSources: [{
    initialize() { throw new Error('tool unavailable') }, tools: () => [],
  }] })
  const session = h.session('chat')
  await tick()
  assert.equal(session.status().state, 'connected')
  assert.deepEqual(h.warnings, [['frontend_tools.initialization_failed', { error: 'tool unavailable' }]])
})

test('image input capability comes from the selected provider, unknown providers fail closed', t => {
  const h = harness(t, { defaultRealtimeProvider: 'vision', realtimeProviderRegistry: {
    resolve(name) {
      if (!['voice', 'vision'].includes(name)) throw new Error('unknown provider')
      return { modelProfile: () => ({ transportCapabilities: { imageBufferInput: name === 'vision' } }) }
    },
  } })
  assert.equal(h.runtime.supportsImageInput(), true)
  assert.equal(h.runtime.supportsImageInput(''), true)
  assert.equal(h.runtime.supportsImageInput('voice'), false)
  assert.equal(h.runtime.supportsImageInput('vision'), true)
  assert.equal(h.runtime.supportsImageInput('unknown'), false)
})
