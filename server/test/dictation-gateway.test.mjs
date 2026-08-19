import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { WebSocket } from 'ws'
import { IdentityManager } from '../src/core/identity.mjs'
import { attachRealtimeGateway } from '../src/voice/realtime-gateway.mjs'

const AUTH_SECRET = 'dictation-test-secret-that-is-long-enough'

function fakeMemoryStore() {
  return {
    list: () => [],
    remember: async () => ({}),
    replace: async () => ({}),
    forget: async () => ({}),
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
  const realtime = attachRealtimeGateway(server, {
    identityManager: new IdentityManager({
      secret: AUTH_SECRET,
      mode: 'personal',
    }),
    memoryService: fakeMemoryStore(),
    memoryExtractor: { maybeRun: value => memoryCalls.push(value) },
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
  return { conversationCalls, memoryCalls, realtime, server }
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
    'dictation.audio.append',
    'dictation.cancel',
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
          if (event.type === 'dictation.cancel') session.state = 'cancelled'
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
    { type: 'dictation.cancel', sessionId: 'dictation-1', seq: 2 },
    { type: 'dictation.start', sessionId: 'dictation-2', seq: 1 },
  ]) connection.socket.send(JSON.stringify(event))

  await eventually(() => sessions.length === 2, 'replacement session not created')
  assert.equal(sessions[0].closeCalls, 1)
  assert.equal(sessions[1].state, 'idle')
})
