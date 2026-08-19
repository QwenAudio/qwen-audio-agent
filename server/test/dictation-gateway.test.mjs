import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { WebSocket } from 'ws'
import { IdentityManager } from '../src/core/identity.mjs'
import { DictationSession } from '../src/dictation/dictation-session.mjs'
import { attachRealtimeGateway } from '../src/voice/realtime-gateway.mjs'

const AUTH_SECRET = 'dictation-test-secret-that-is-long-enough'

function fakeMemoryStore(calls = []) {
  return {
    list: () => [],
    remember: async value => { calls.push(['remember', value]); return {} },
    replace: async value => { calls.push(['replace', value]); return {} },
    forget: async value => { calls.push(['forget', value]); return {} },
  }
}

function fakeNotesStore() {
  return {
    lists: () => [],
    show: () => ({ name: '', items: [] }),
    add: async () => ({}),
    remove: async () => ({}),
    clear: async () => ({}),
    drop: async () => ({}),
  }
}

async function gateway({ enabled, createDictationSession }) {
  const server = createServer()
  const conversationCalls = []
  const memoryCalls = []
  const extractionCalls = []
  const realtime = attachRealtimeGateway(server, {
    identityManager: new IdentityManager({
      secret: AUTH_SECRET,
      mode: 'personal',
    }),
    memoryService: fakeMemoryStore(memoryCalls),
    memoryExtractor: { maybeRun: value => extractionCalls.push(value) },
    notesStore: fakeNotesStore(),
    coordinator: null,
    backendAvailability: {
      snapshot: () => ({ configured: false, ok: false, known: true }),
    },
    respondPermission: async () => ({}),
    permissionPolicy: {
      resolveDecision: () => null,
      rememberDecision: () => {},
    },
    conversation: {
      record: value => conversationCalls.push(value),
      recent: () => [],
    },
    dictationEnabled: enabled,
    createDictationSession,
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { conversationCalls, extractionCalls, memoryCalls, realtime, server }
}

async function client(server) {
  const socket = new WebSocket(
    `ws://127.0.0.1:${server.address().port}/api/realtime?sessionId=test-session`,
  )
  const received = []
  socket.on('message', raw => received.push(JSON.parse(raw.toString())))
  await new Promise((resolve, reject) => {
    socket.once('error', reject)
    socket.once('open', resolve)
  })
  socket.send(JSON.stringify({
    type: 'connect',
    textOnly: true,
    voiceEnabled: false,
    inputEnabled: false,
    outputEnabled: false,
    clientType: 'web',
  }))
  return { received, socket }
}

async function eventually(predicate, message) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(message)
}

test('disabled dictation does not construct ASR or touch existing session data', async t => {
  let created = 0
  const subject = await gateway({
    enabled: false,
    createDictationSession() {
      created += 1
      return { handle() {}, close() {} }
    },
  })
  const connection = await client(subject.server)
  t.after(async () => {
    connection.socket.close()
    await subject.realtime.close()
    await new Promise(resolve => subject.server.close(resolve))
  })
  connection.socket.send(JSON.stringify({
    type: 'dictation.start',
    sessionId: 'dictation-1',
    seq: 1,
  }))
  await eventually(
    () => connection.received.some(event => event.code === 'feature_disabled'),
    'feature-disabled response not received',
  )
  assert.equal(created, 0)
  assert.deepEqual(subject.conversationCalls, [])
  assert.deepEqual(subject.memoryCalls, [])
})

test('routes dictation events to one isolated session with zero uncommitted side effects', async t => {
  const handled = []
  let closed = 0
  let sendToClient
  const subject = await gateway({
    enabled: true,
    createDictationSession({ send }) {
      sendToClient = send
      return {
        async handle(event) { handled.push(event) },
        close() { closed += 1 },
      }
    },
  })
  const connection = await client(subject.server)
  t.after(async () => {
    if (connection.socket.readyState < WebSocket.CLOSING) connection.socket.close()
    await subject.realtime.close()
    await new Promise(resolve => subject.server.close(resolve))
  })
  connection.socket.send(JSON.stringify({
    type: 'dictation.start',
    sessionId: 'dictation-1',
    seq: 1,
  }))
  connection.socket.send(JSON.stringify({
    type: 'dictation.audio.append',
    sessionId: 'dictation-1',
    seq: 2,
    audio: 'private-audio',
  }))
  connection.socket.send(JSON.stringify({
    type: 'dictation.cancel',
    sessionId: 'dictation-1',
    seq: 3,
  }))
  await eventually(() => handled.length === 3, 'dictation events not routed')
  assert.deepEqual(handled.map(event => event.type), [
    'dictation.start',
    'dictation.cancel',
    'dictation.audio.append',
  ])
  assert.deepEqual(subject.conversationCalls, [])
  assert.deepEqual(subject.memoryCalls, [])

  sendToClient({ type: 'dictation.state', state: 'cancelled' })
  await eventually(
    () => connection.received.some(event => event.type === 'dictation.state'),
    'dictation state not sent to client',
  )
  connection.socket.close()
  await eventually(() => closed === 1, 'dictation session not closed')
  assert.deepEqual(subject.conversationCalls, [])
  assert.deepEqual(subject.memoryCalls, [])
})

test('a visible dictation failure makes zero conversation and memory calls', async t => {
  const subject = await gateway({
    enabled: true,
    createDictationSession({ send }) {
      return {
        state: 'idle',
        async handle(event) {
          if (event.type !== 'dictation.start') return false
          this.state = 'error'
          send({
            type: 'dictation.error',
            sessionId: event.sessionId,
            seq: 1,
            code: 'provider_error',
            message: 'provider unavailable',
          })
          send({
            type: 'dictation.state',
            sessionId: event.sessionId,
            seq: 2,
            state: 'error',
          })
          return false
        },
        close() {},
      }
    },
  })
  const connection = await client(subject.server)
  t.after(async () => {
    connection.socket.close()
    await subject.realtime.close()
    await new Promise(resolve => subject.server.close(resolve))
  })
  connection.socket.send(JSON.stringify({
    type: 'dictation.start',
    sessionId: 'dictation-failure',
    seq: 1,
  }))

  await eventually(
    () => connection.received.some(event => event.code === 'provider_error'),
    'provider failure not sent to client',
  )
  const socketClosed = new Promise(resolve => connection.socket.once('close', resolve))
  connection.socket.close()
  await socketClosed
  assert.deepEqual(subject.conversationCalls, [])
  assert.deepEqual(subject.memoryCalls, [])
})

test('cancel interrupts an in-flight rewrite before it can emit an operation', async t => {
  let callbacks
  let finishRewrite
  let session
  const sessions = []
  let rewriteStartedResolve
  const rewriteStarted = new Promise(resolve => { rewriteStartedResolve = resolve })
  let queuedAudioHandledResolve
  const queuedAudioHandled = new Promise(resolve => { queuedAudioHandledResolve = resolve })
  const subject = await gateway({
    enabled: true,
    createDictationSession({ send }) {
      const createdSession = new DictationSession({
        send,
        createTranscriber(options) {
          callbacks = options
          return {
            async start() {},
            pause() {},
            resume() {},
            close() {},
          }
        },
        rewriteText: () => new Promise(resolve => {
          finishRewrite = resolve
          rewriteStartedResolve()
        }),
      })
      createdSession.handledEvents = []
      const handle = createdSession.handle.bind(createdSession)
      createdSession.handle = event => {
        createdSession.handledEvents.push(event)
        if (event.type === 'dictation.audio.append') queuedAudioHandledResolve()
        return handle(event)
      }
      session = createdSession
      sessions.push(createdSession)
      return createdSession
    },
  })
  const connection = await client(subject.server)
  t.after(async () => {
    if (connection.socket.readyState < WebSocket.CLOSING) connection.socket.close()
    await subject.realtime.close()
    await new Promise(resolve => subject.server.close(resolve))
  })
  connection.socket.send(JSON.stringify({
    type: 'dictation.start',
    sessionId: 'dictation-rewrite',
    seq: 1,
  }))
  await eventually(() => session?.state === 'listening', 'dictation did not start')
  await callbacks.onFinal('改得更简洁')
  await eventually(
    () => connection.received.some(event => event.type === 'dictation.context.request'),
    'context request not sent',
  )
  const contextRequest = connection.received.find(
    event => event.type === 'dictation.context.request',
  )
  connection.socket.send(JSON.stringify({
    type: 'dictation.context',
    sessionId: 'dictation-rewrite',
    seq: 2,
    requestId: contextRequest.requestId,
    text: 'private draft',
    selectionStart: 13,
    selectionEnd: 13,
    revision: 1,
  }))
  await rewriteStarted

  connection.socket.send(JSON.stringify({
    type: 'dictation.audio.append',
    sessionId: 'dictation-rewrite',
    seq: 3,
    audio: 'late-old-audio',
  }))
  connection.socket.send(JSON.stringify({
    type: 'dictation.cancel',
    sessionId: 'dictation-rewrite',
    seq: 4,
  }))
  for (let attempt = 0; attempt < 20 && session.state !== 'cancelled'; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  const oldSession = session
  connection.socket.send(JSON.stringify({
    type: 'dictation.start',
    sessionId: 'dictation-restart',
    seq: 1,
  }))
  connection.socket.send(JSON.stringify({
    type: 'dictation.cancel',
    sessionId: 'dictation-restart',
    seq: 2,
  }))
  for (
    let attempt = 0;
    attempt < 20
      && (sessions.length < 2 || sessions.at(-1)?.state !== 'cancelled');
    attempt += 1
  ) await new Promise(resolve => setTimeout(resolve, 5))
  const sessionsBeforeRewriteFinished = sessions.length
  const restartStateBeforeRewriteFinished = sessions.at(-1).state
  finishRewrite('must not apply')
  await queuedAudioHandled
  await eventually(() => sessions.length === 2, 'fresh dictation was not created')

  assert.equal(oldSession.state, 'cancelled')
  assert.equal(sessionsBeforeRewriteFinished, 2)
  assert.equal(restartStateBeforeRewriteFinished, 'cancelled')
  assert.equal(sessions[1].state, 'cancelled')
  assert.equal(
    sessions[0].handledEvents.some(event => event.type === 'dictation.audio.append'),
    true,
  )
  assert.equal(
    sessions[1].handledEvents.some(event => event.sessionId === 'dictation-rewrite'),
    false,
  )
  assert.equal(
    connection.received.some(event => event.type === 'dictation.operation'),
    false,
  )
  assert.equal(connection.received.some(event => (
    event.type === 'dictation.error'
    && event.sessionId === 'dictation-restart'
  )), false)
  assert.deepEqual(subject.conversationCalls, [])
  assert.deepEqual(subject.memoryCalls, [])
})

test('a terminal dictation session can restart without reusing its live receipt state', async t => {
  const sessions = []
  const subject = await gateway({
    enabled: true,
    createDictationSession() {
      const session = {
        state: 'idle',
        closeCalls: 0,
        async handle(event) {
          if (event.type === 'dictation.stop') session.state = 'stopped'
        },
        close() { session.closeCalls += 1 },
      }
      sessions.push(session)
      return session
    },
  })
  const connection = await client(subject.server)
  t.after(async () => {
    connection.socket.close()
    await subject.realtime.close()
    await new Promise(resolve => subject.server.close(resolve))
  })
  for (const event of [
    { type: 'dictation.start', sessionId: 'dictation-1', seq: 1 },
    { type: 'dictation.stop', sessionId: 'dictation-1', seq: 2 },
    { type: 'dictation.start', sessionId: 'dictation-2', seq: 1 },
  ]) connection.socket.send(JSON.stringify(event))

  await eventually(() => sessions.length === 2, 'replacement session not created')
  assert.equal(sessions[0].closeCalls, 1)
  assert.equal(sessions[1].state, 'idle')
})
