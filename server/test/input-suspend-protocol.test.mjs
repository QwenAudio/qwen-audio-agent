// Verifies input preemption over the real WebSocket protocol: the Gateway
// must be able to command a client to stop capturing, not merely record that
// the client declared itself muted. The chain under test is
//   POST /api/input/suspend
//     -> InputArbitration
//     -> realtime-gateway broadcasts playback.clear + input.suspend
//     -> a late-joining client learns about the suspension on connect.

import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { WebSocket } from 'ws'

process.env.QWAUDIO_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'qwaudio-input-'))
process.env.QWEN_AUDIO_AGENT_AUTH_SECRET = 'test-secret-that-is-long-enough-1234567890'
process.env.DASHSCOPE_API_KEY = 'sk-fake'

const { attachRealtimeGateway } = await import('../src/voice/realtime-gateway.mjs')
const { InputArbitration } = await import('../src/voice/input-arbitration.mjs')
const { IdentityManager } = await import('../src/core/identity.mjs')

function fakeMemoryStore() {
  return {
    list: () => [],
    remember: async () => ({ id: 'mem_1' }),
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

async function startGateway() {
  const server = createServer()
  const inputArbitration = new InputArbitration()
  attachRealtimeGateway(server, {
    identityManager: new IdentityManager({
      secret: process.env.QWEN_AUDIO_AGENT_AUTH_SECRET,
      mode: 'personal',
    }),
    memoryService: fakeMemoryStore(),
    notesStore: fakeNotesStore(),
    backendRuntime: null,
    backendAvailability: {
      snapshot: () => ({ configured: false, ok: false, known: true }),
    },
    respondAuthorization: async () => ({}),
    permissionPolicy: {
      resolveDecision: () => null,
      rememberDecision: () => {},
    },
    inputArbitration,
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { server, inputArbitration }
}

function connectClient(server) {
  const { port } = server.address()
  const socket = new WebSocket(
    `ws://127.0.0.1:${port}/api/realtime?sessionId=main`,
  )
  const received = []
  socket.on('message', raw => {
    try {
      received.push(JSON.parse(raw.toString()))
    } catch {
      // Non-JSON frames are not part of this protocol.
    }
  })
  return new Promise((resolve, reject) => {
    socket.on('error', reject)
    socket.on('open', () => {
      socket.send(JSON.stringify({
        type: 'connect',
        timeZone: 'Asia/Shanghai',
        locale: 'zh-CN',
        voiceEnabled: true,
        inputEnabled: true,
        outputEnabled: true,
        clientType: 'web',
        clientLabel: 'test',
        clientInstanceId: 'client-1',
      }))
      resolve({ socket, received })
    })
  })
}

function waitFor(received, type, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const poll = () => {
      const event = received.find(item => item.type === type)
      if (event) return resolve(event)
      if (Date.now() > deadline) {
        return reject(new Error(
          `${type} was never received; saw ${
            [...new Set(received.map(item => item.type))].join(', ')
          }`,
        ))
      }
      setTimeout(poll, 10)
    }
    poll()
  })
}

test('the host can command a connected client to release the microphone', async t => {
  const { server, inputArbitration } = await startGateway()
  const { socket, received } = await connectClient(server)
  t.after(async () => {
    socket.close()
    inputArbitration.close()
    await new Promise(resolve => server.close(resolve))
  })

  inputArbitration.suspend({
    owner: 'host-app',
    reason: 'dictation',
    ttlMs: 60_000,
  })

  const suspend = await waitFor(received, 'input.suspend')
  assert.equal(suspend.owner, 'host-app')
  assert.equal(suspend.reason, 'dictation')
  assert.ok(suspend.expiresAt > Date.now())

  // Playback stops with capture so a host recording cannot pick up this
  // Gateway's own speech.
  const clear = await waitFor(received, 'playback.clear')
  assert.equal(clear.reason, 'input_suspended')

  received.length = 0
  inputArbitration.resume({ owner: 'host-app' })
  await waitFor(received, 'input.resume')
})

test('a client connecting mid-suspension is told before it opens a microphone', async t => {
  const { server, inputArbitration } = await startGateway()
  inputArbitration.suspend({ owner: 'host-app', ttlMs: 60_000 })
  const { socket, received } = await connectClient(server)
  t.after(async () => {
    socket.close()
    inputArbitration.close()
    await new Promise(resolve => server.close(resolve))
  })

  const suspend = await waitFor(received, 'input.suspend')
  assert.equal(suspend.owner, 'host-app')
})

test('an expired suspension resumes the client without a host request', async t => {
  const { server, inputArbitration } = await startGateway()
  const { socket, received } = await connectClient(server)
  t.after(async () => {
    socket.close()
    inputArbitration.close()
    await new Promise(resolve => server.close(resolve))
  })

  // A host that crashes after suspending must not silence the Gateway for good.
  inputArbitration.suspend({ owner: 'crashed-host', ttlMs: 120 })
  await waitFor(received, 'input.suspend')
  await waitFor(received, 'input.resume')
  assert.equal(inputArbitration.suspended, false)
})

test('repeated suspend and resume cycles do not leak holders', async t => {
  const { server, inputArbitration } = await startGateway()
  const { socket, received } = await connectClient(server)
  t.after(async () => {
    socket.close()
    inputArbitration.close()
    await new Promise(resolve => server.close(resolve))
  })

  for (let cycle = 0; cycle < 5; cycle += 1) {
    received.length = 0
    inputArbitration.suspend({ owner: 'host-app', ttlMs: 60_000 })
    await waitFor(received, 'input.suspend')
    received.length = 0
    inputArbitration.resume({ owner: 'host-app' })
    await waitFor(received, 'input.resume')
  }
  assert.deepEqual(inputArbitration.status().holders, [])
})
