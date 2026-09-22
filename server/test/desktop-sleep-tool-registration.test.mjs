// Drives client-owned tool discovery through a real Gateway WebSocket and a fake provider.
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createGatewaySessionHello } from '../../shared/protocol/gateway-client-protocol.mjs'
import { desktopClientTools } from '../../web/src/desktop/client-tools.js'
import { WebSocket, WebSocketServer } from 'ws'

const providerServer = createServer()
const providerWss = new WebSocketServer({ server: providerServer })
const sessionUpdates = []
providerWss.on('connection', socket => {
  socket.on('message', raw => {
    let event
    try {
      event = JSON.parse(raw.toString())
    } catch {
      return
    }
    if (event.type === 'session.update') sessionUpdates.push(event.session)
  })
  socket.send(JSON.stringify({ type: 'session.created', session: {} }))
  socket.send(JSON.stringify({ type: 'session.updated', session: {} }))
})

process.env.QWAUDIO_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'qwaudio-sleep-'))
process.env.QWEN_AUDIO_AGENT_AUTH_SECRET = 'test-secret-that-is-long-enough-1234567890'
process.env.DASHSCOPE_API_KEY = 'sk-fake'
await new Promise(resolve => providerServer.listen(0, '127.0.0.1', resolve))
process.env.QWEN_AUDIO_REALTIME_BASE_URL = (
  `ws://127.0.0.1:${providerServer.address().port}`
)

const { attachTestGateway } = await import('./fixtures/gateway-runtime.mjs')
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
  attachTestGateway(server, {
    identityManager: new IdentityManager({
      secret: process.env.QWEN_AUDIO_AGENT_AUTH_SECRET,
      mode: 'personal',
    }),
    memoryService: fakeMemoryStore(),
    notesStore: fakeNotesStore(),
    backendRuntime: null,
    backendAvailability: {
      snapshot: () => ({ configured: true, ok: false, known: true }),
    },
    respondAuthorization: async () => ({}),
    permissionPolicy: {
      resolveDecision: () => null,
      rememberDecision: () => {},
    },
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return server
}

function connectDesktopClient(server) {
  const port = server.address().port
  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/realtime?sessionId=main`)
  return new Promise((resolve, reject) => {
    socket.on('open', () => {
      socket.send(JSON.stringify(createGatewaySessionHello({
        clientType: 'desktop', clientInstanceId: 'repro-instance',
        capabilities: ['input.audio', 'client.tools', 'client.presence'],
        tools: desktopClientTools,
        connection: { input_enabled: false, output_enabled: true },
      })))
      resolve(socket)
    })
    socket.on('error', reject)
  })
}

test('desktop tool declaration registers enter_sleep in the realtime session', async t => {
  const server = await startGateway()
  t.after(() => {
    server.close()
    providerServer.close()
  })

  const socket = await connectDesktopClient(server)
  t.after(() => socket.close())

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('session.update 未送达')), 5000)
    const poll = () => {
      if (sessionUpdates.length) {
        clearTimeout(timer)
        resolve()
        return
      }
      setTimeout(poll, 20)
    }
    poll()
  })

  const session = sessionUpdates.at(-1)
  const names = (session.tools || []).map(tool => (
    tool.function?.name || tool.name
  ))
  assert.ok(
    names.includes('enter_sleep'),
    `desktop 会话工具缺少 enter_sleep：${names.join(', ')}`,
  )
})
