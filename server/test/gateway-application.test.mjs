import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import WebSocket, { WebSocketServer } from 'ws'
import { createGatewayApplication } from '../src/app/gateway-application.mjs'
import { GATEWAY_CLIENT_REVOKED_CLOSE_CODE } from '../../shared/protocol/gateway-client-protocol.mjs'
import { GatewayClient } from '../../shared/gateway/client-sdk.mjs'
import { decodeGatewayDirectConnection } from '../../shared/gateway/remote-access.mjs'
import { config } from '../src/core/config.mjs'
import { createRealtimeProviderRegistry } from '../src/voice/providers/provider-registry.mjs'
import { openAiCompatibleProtocol } from '../src/voice/providers/openai-compatible-protocol.mjs'
import { ConversationSync } from '../src/conversation/conversation-sync.mjs'
import { SessionJournalRegistry } from '../src/session/session-journal-registry.mjs'
import { TaskManager } from '../src/task/task-manager.mjs'
import { TaskStore } from '../src/task/task-store.mjs'
import { FrontendMemoryRuntime } from '../src/memory/runtime.mjs'
import { MarkdownMemoryProvider } from '../src/memory/providers/markdown/provider.mjs'
import { MarkdownContextStore } from '../src/memory/providers/markdown/context-store.mjs'
import { buildMemoryContext } from '../src/memory/context.mjs'

function createTestGatewayApplication(options = {}) {
  // Application tests must never inherit the process-wide production task
  // state. Besides making tests order-dependent, that used to write fixture
  // work into ~/.config/qwaudio and later announce it to real voice clients.
  const runtimeDirectory = mkdtempSync(join(tmpdir(), 'qwaudio-app-runtime-'))
  const taskStore = options.taskStore || new TaskStore({
    filePath: join(runtimeDirectory, 'tasks.json'),
  })
  const sessionJournal = options.sessionJournal || new SessionJournalRegistry({
    directory: join(runtimeDirectory, 'sessions'),
  })
  const taskManager = options.taskManager || new TaskManager({
    store: taskStore,
    sessionJournal,
  })
  const application = createGatewayApplication({
    agent: disabledBackend(),
    publicEndpoint: null,
    conversationSync: options.conversationSync || new ConversationSync(),
    taskManager,
    taskStore,
    sessionJournal,
    ...options,
  })
  const close = application.close
  application.close = async () => {
    try {
      await close()
    } finally {
      rmSync(runtimeDirectory, { recursive: true, force: true })
    }
  }
  return application
}

function requestJson({ port, path, method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
    }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString()
        resolve({
          status: response.statusCode,
          headers: response.headers,
          body: text ? JSON.parse(text) : null,
        })
      })
    })
    request.once('error', reject)
    if (body !== undefined) request.write(JSON.stringify(body))
    request.end()
  })
}

function disabledBackend() {
  return {
    enabled: false,
    describe: () => ({
      configured: false,
      enabled: false,
      protocol: 'none',
      label: 'No backend',
      capabilities: {},
    }),
    start: async () => ({ ok: false, configured: false }),
    health: async () => ({ ok: false, configured: false }),
    submit: async () => { throw new Error('Backend is disabled') },
    status: async () => null,
    cancel: async () => ({ state: 'not_found' }),
    respondAuthorization: async () => ({ state: 'not_found' }),
    respondInput: async () => ({ state: 'not_found' }),
    subscribe: () => () => {},
    close: async () => {},
    canRecoverDelegatedWork: () => false,
    recoverDelegatedWork: async () => null,
  }
}

for (const shareClientAssets of [false, true]) {
  test(`Gateway serves only explicitly shared client skins (enabled=${shareClientAssets})`, async t => {
    const directory = mkdtempSync(join(tmpdir(), 'qwaudio-skin-ownership-'))
    const dataDirectory = join(directory, 'gateway/data')
    const clientSkins = join(directory, 'client/skins')
    for (const root of [join(dataDirectory, 'skins'), clientSkins]) {
      mkdirSync(join(root, 'probe'), { recursive: true })
      writeFileSync(join(root, 'probe/pet.json'), JSON.stringify({ clientOwned: root === clientSkins }))
    }
    const application = createTestGatewayApplication({
      config: {
        ...config, host: '127.0.0.1', port: 0, dataDirectory,
        webSkinsDirectory: shareClientAssets ? clientSkins : '',
        gatewayAccessToken: '', gatewayAccessKeys: '',
        gatewayDeviceStatePath: join(directory, 'devices.json'),
      },
      parentPort: null, autoStart: false, frontendMcp: null, frontendOpenApi: null,
    })
    t.after(async () => {
      await application.close()
      rmSync(directory, { recursive: true, force: true })
    })
    application.start()
    if (!application.server.listening) await once(application.server, 'listening')
    const { port } = application.server.address()
    const result = await requestJson({ port, path: '/skins/probe/pet.json' })
    assert.equal(result.status, shareClientAssets ? 200 : 404)
    if (shareClientAssets) assert.deepEqual(result.body, { clientOwned: true })
    const missing = await requestJson({ port, path: '/skins/missing/pet.json' })
    assert.equal(missing.status, 404)
  })
}

function customTaskAnnouncementRuntime() {
  const methods = names => Object.fromEntries(
    names.map(name => [name, () => {}]),
  )
  return {
    results: methods([
      'completed',
      'failed',
      'dismissActive',
      'confirmMany',
      'retryMany',
      'flush',
      'pause',
      'close',
    ]),
    progress: methods(['offer', 'remove', 'clear', 'flush', 'close']),
  }
}

test('protects remote HTTP access and completes one-time device pairing', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'qwa-app-access-'))
  const accessToken = 'application-remote-access-token-over-24-characters'
  const publicEndpointCalls = []
  const publicEndpoint = {
    status: () => ({
      mode: 'tailnet',
      state: 'ready',
      endpoint: { url: 'https://voice.example.ts.net', secure: true },
      error: null,
    }),
    start: async url => publicEndpointCalls.push(['start', url]),
    close: async () => publicEndpointCalls.push(['close']),
  }
  const application = createTestGatewayApplication({
    config: {
      ...config,
      host: '0.0.0.0',
      port: 0,
      webSearchProvider: 'none',
      webSearchMcpUrl: '',
      gatewayAccessToken: accessToken,
      gatewayAccessKeys: '',
      gatewayDeviceStatePath: join(directory, 'gateway-devices.json'),
    },
    parentPort: null,
    autoStart: false,
    agent: disabledBackend(),
    frontendMcp: null,
    frontendOpenApi: null,
    publicEndpoint,
  })
  t.after(async () => {
    await application.close()
    rmSync(directory, { recursive: true, force: true })
  })
  application.start()
  if (!application.server.listening) await once(application.server, 'listening')
  const { port } = application.server.address()

  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(publicEndpointCalls[0], ['start', `http://127.0.0.1:${port}`])

  const denied = await requestJson({
    port,
    path: '/api/health',
    headers: { Host: 'gateway.example.test' },
  })
  assert.equal(denied.status, 401)

  const authenticated = await requestJson({
    port,
    path: '/api/health',
    headers: {
      Host: 'gateway.example.test',
      Authorization: `Bearer ${accessToken}`,
    },
  })
  assert.equal(authenticated.status, 200)
  assert.match(authenticated.headers['set-cookie'][0], /HttpOnly/)
  const remoteIssueDenied = await requestJson({
    port,
    path: '/api/access/devices',
    method: 'POST',
    headers: {
      Host: 'gateway.example.test',
      Authorization: `Bearer ${accessToken}`,
    },
    body: { device: { label: 'must-not-exist' } },
  })
  assert.equal(remoteIssueDenied.status, 403)
  const issued = await requestJson({
    port,
    path: '/api/access/devices',
    method: 'POST',
    headers: { Host: `127.0.0.1:${port}` },
    // The CLI issues a generic native-client credential; the Capacitor shell
    // still uses its fixed qwaudio.local origin with that connection code.
    body: { device: { id: 'direct-phone', type: 'client', label: 'Direct Phone' } },
  })
  assert.equal(issued.status, 201)
  assert.match(issued.body.device.id, /^device_/)
  assert.equal('access_token' in issued.body, false)
  const direct = decodeGatewayDirectConnection(issued.body.connection_code)
  assert.equal(direct.websocket_url, 'wss://voice.example.ts.net/api/realtime')
  assert.match(issued.body.connection_code, /^https:\/\/voice\.example\.ts\.net\/c#d\./)
  assert.equal('browser_url' in issued.body, false)
  assert.equal('native_connection_code' in issued.body, false)
  const storedDevices = readFileSync(join(directory, 'gateway-devices.json'), 'utf8')
  assert.equal(storedDevices.includes(direct.access_token), false)
  const directAuthenticated = await requestJson({
    port,
    path: '/api/health',
    headers: {
      Host: 'gateway.example.test',
      Authorization: `Bearer ${direct.access_token}`,
    },
  })
  assert.equal(directAuthenticated.status, 200)
  for (const Origin of ['null', '', 'not-an-origin', 'data:text/plain,test', 'https://untrusted.example']) {
    const deniedSession = await requestJson({
      port,
      path: '/api/access/session',
      method: 'POST',
      headers: { Host: 'voice.example.ts.net', Origin },
      body: { token: direct.access_token },
    })
    assert.equal(deniedSession.status, 403)
    assert.equal(deniedSession.headers['set-cookie'], undefined)
  }
  const browserSession = await requestJson({
    port,
    path: '/api/access/session',
    method: 'POST',
    headers: {
      Host: 'voice.example.ts.net',
      Origin: 'https://voice.example.ts.net',
      'X-Forwarded-Proto': 'https',
    },
    body: { token: direct.access_token },
  })
  assert.equal(browserSession.status, 204)
  assert.match(browserSession.headers['set-cookie'][0], /HttpOnly/)
  assert.match(browserSession.headers['set-cookie'][0], /Secure/)
  assert.doesNotMatch(browserSession.headers['set-cookie'][0], new RegExp(direct.access_token))
  const browserAuthenticated = await requestJson({
    port,
    path: '/api/health',
    headers: {
      Host: 'voice.example.ts.net',
      Origin: 'https://voice.example.ts.net',
      Cookie: browserSession.headers['set-cookie'][0].split(';')[0],
    },
  })
  assert.equal(browserAuthenticated.status, 200)
  const directSocket = new WebSocket(
    `ws://127.0.0.1:${port}/api/realtime?sessionId=direct-device`,
    {
      headers: {
        Host: 'gateway.example.test',
        Authorization: `Bearer ${direct.access_token}`,
        Origin: 'https://qwaudio.local',
      },
    },
  )
  await once(directSocket, 'open')
  const directClosed = once(directSocket, 'close')
  const directRevoked = await requestJson({
    port,
    path: `/api/access/devices/${issued.body.device.id}`,
    method: 'DELETE',
    headers: { Host: `127.0.0.1:${port}` },
  })
  assert.equal(directRevoked.status, 204)
  assert.equal((await directClosed)[0], GATEWAY_CLIENT_REVOKED_CLOSE_CODE)
  const directDeniedAfterRevocation = await requestJson({
    port,
    path: '/api/health',
    headers: {
      Host: 'gateway.example.test',
      Authorization: `Bearer ${direct.access_token}`,
    },
  })
  assert.equal(directDeniedAfterRevocation.status, 401)
  for (const Origin of ['null', '', 'not-an-origin', 'data:text/plain,test', 'file:///tmp/test']) {
    const deniedOrigin = await requestJson({
      port,
      path: '/api/health',
      headers: { Host: 'gateway.example.test', Authorization: `Bearer ${accessToken}`, Origin },
    })
    assert.equal(deniedOrigin.status, 403)
    assert.deepEqual(deniedOrigin.body, { error: 'origin not allowed' })
  }
  const ticket = await requestJson({
    port,
    path: '/api/access/pairing-tickets',
    method: 'POST',
    headers: { Host: `127.0.0.1:${port}` },
    body: {},
  })
  assert.equal(ticket.status, 201)
  assert.equal(ticket.body.gatewayUrl, 'https://voice.example.ts.net')
  for (const Origin of ['null', '', 'not-an-origin', 'data:text/plain,test']) {
    const deniedPairing = await requestJson({
      port,
      path: '/api/access/pair',
      method: 'POST',
      headers: { Host: 'gateway.example.test', Origin },
      body: { code: ticket.body.code, device: { id: 'untrusted-browser', type: 'web' } },
    })
    assert.equal(deniedPairing.status, 403)
  }
  // Rejected origins must not consume the one-time ticket.
  const paired = await requestJson({
    port,
    path: '/api/access/pair',
    method: 'POST',
    headers: { Host: 'gateway.example.test' },
    body: {
      code: ticket.body.code,
      device: { id: 'phone-one', type: 'mobile', label: 'Phone' },
    },
  })
  assert.equal(paired.status, 200)
  assert.equal(paired.body.device.id, 'phone-one')
  assert.equal(typeof paired.body.access_token, 'string')
  const replay = await requestJson({
    port,
    path: '/api/access/pair',
    method: 'POST',
    headers: { Host: 'gateway.example.test' },
    body: { code: ticket.body.code },
  })
  assert.equal(replay.status, 401)

  const remoteSocket = new WebSocket(
    `ws://127.0.0.1:${port}/api/realtime?sessionId=paired-device`,
    {
      headers: {
        Host: 'gateway.example.test',
        Authorization: `Bearer ${paired.body.access_token}`,
        Origin: 'https://qwaudio.local',
      },
    },
  )
  await once(remoteSocket, 'open')
  const remoteClosed = once(remoteSocket, 'close')
  const revoked = await requestJson({
    port,
    path: '/api/access/devices/phone-one',
    method: 'DELETE',
    headers: { Host: `127.0.0.1:${port}` },
  })
  assert.equal(revoked.status, 204)
  const [closeCode] = await remoteClosed
  assert.equal(closeCode, GATEWAY_CLIENT_REVOKED_CLOSE_CODE)

  const deniedAfterRevocation = await requestJson({
    port,
    path: '/api/health',
    headers: {
      Host: 'gateway.example.test',
      Authorization: `Bearer ${paired.body.access_token}`,
    },
  })
  assert.equal(deniedAfterRevocation.status, 401)
  assert.equal(publicEndpointCalls.some(call => call[0] === 'close'), false)
})

test('requires a declared public endpoint before issuing any connection code', async t => {
  const application = createTestGatewayApplication({
    config: {
      ...config,
      port: 0,
      webSearchProvider: 'none',
      webSearchMcpUrl: '',
    },
    parentPort: null,
    autoStart: false,
    frontendMcp: null,
    frontendOpenApi: null,
    publicEndpoint: {
      status: () => ({ mode: 'none', state: 'disabled', endpoint: null }),
      start: async () => {},
      close: async () => {},
    },
  })
  t.after(() => application.close())
  application.start()
  if (!application.server.listening) await once(application.server, 'listening')
  const { port } = application.server.address()
  const response = await requestJson({
    port,
    path: '/api/access/pairing-tickets',
    method: 'POST',
    headers: { Host: `127.0.0.1:${port}` },
    body: {},
  })
  assert.equal(response.status, 409)
  assert.equal(response.body.code, 'gateway_public_url_required')
  const direct = await requestJson({
    port,
    path: '/api/access/devices',
    method: 'POST',
    headers: { Host: `127.0.0.1:${port}` },
    body: { device: { label: 'No endpoint' } },
  })
  assert.equal(direct.status, 409)
  assert.equal(direct.body.code, 'gateway_connection_endpoint_required')

  const overridden = await requestJson({
    port,
    path: '/api/access/devices',
    method: 'POST',
    headers: { Host: `127.0.0.1:${port}` },
    body: {
      endpoint: 'https://voice.example.com',
      device: { label: 'Proxy endpoint' },
    },
  })
  assert.equal(overridden.status, 201)
  assert.equal(
    decodeGatewayDirectConnection(overridden.body.connection_code).websocket_url,
    'wss://voice.example.com/api/realtime',
  )

  const unsafe = await requestJson({
    port,
    path: '/api/access/devices',
    method: 'POST',
    headers: { Host: `127.0.0.1:${port}` },
    body: { endpoint: 'http://voice.example.com' },
  })
  assert.equal(unsafe.status, 400)
  assert.equal(unsafe.body.code, 'gateway_connection_endpoint_unsafe')
})

test('passes the Task announcement factory through the application composition root', async () => {
  const calls = []
  let finishTask
  const application = createTestGatewayApplication({
    config: {
      ...config,
      port: 0,
      webSearchProvider: 'none',
      webSearchMcpUrl: '',
    },
    parentPort: null,
    autoStart: false,
    agent: disabledBackend(),
    frontendMcp: null,
    frontendOpenApi: null,
    taskAnnouncementFactory: options => {
      calls.push(options)
      return customTaskAnnouncementRuntime()
    },
  })
  const task = application.services.taskManager.create({
    objective: '验证实例级任务依赖',
    ownerId: 'user_personal',
    sessionId: 'announcement-factory',
    notificationPolicy: 'silent',
    runner: () => new Promise(resolve => { finishTask = resolve }),
  })
  await new Promise(resolve => setImmediate(resolve))
  application.start()
  if (!application.server.listening) await once(application.server, 'listening')
  const { port } = application.server.address()
  const socket = new WebSocket(
    `ws://127.0.0.1:${port}/api/realtime?sessionId=announcement-factory`,
  )
  try {
    await once(socket, 'open')
    assert.equal(calls.length, 1)
    assert.equal(typeof calls[0].resultOptions.getFrontend, 'function')
    assert.equal(typeof calls[0].progressOptions.isTaskActive, 'function')
    assert.equal(calls[0].progressOptions.isTaskActive(task.id), true)
  } finally {
    finishTask?.({ content: '完成' })
    await application.services.taskManager.wait(task.id)
    socket.close()
    await application.close()
  }
})

test('constructs an injectable Gateway without binding a port on import', async () => {
  const inputAssets = { kind: 'test-input-assets' }
  const privateProvider = {
    key: 'private-realtime',
    label: 'Private Realtime',
    visibility: 'gateway-only',
    inputSampleRate: 16000,
    outputSampleRate: 24000,
    protocol: openAiCompatibleProtocol,
    model: () => 'private-model',
    voice: () => null,
    isConfigured: () => true,
    url: () => 'wss://private.example/realtime',
    headers: () => ({}),
    classifyError: () => 'other',
    buildSession: () => ({}),
    buildSpeakResponse: () => ({}),
    buildResultInjection: () => ({}),
    buildPermissionInjection: () => ({}),
  }
  const realtimeProviderRegistry = createRealtimeProviderRegistry({
    providers: [privateProvider],
  })
  const frontendProfile = {
    configured: true,
    name: 'test-profile',
    description: 'Test frontend composition',
  }
  let mcpClosed = false
  let openApiClosed = false
  const frontendMcp = {
    describe: () => ({ key: 'mcp', label: 'Test MCP' }),
    initialize: async () => [],
    tools: () => [],
    execute: async () => ({}),
    health: () => ({
      ok: true,
      initialized: true,
      tools: 0,
      servers: [],
    }),
    close: async () => { mcpClosed = true },
  }
  const frontendOpenApi = {
    describe: () => ({ key: 'openapi', label: 'Test OpenAPI' }),
    initialize: async () => [],
    tools: () => [],
    execute: async () => ({}),
    health: () => ({
      ok: true,
      initialized: true,
      tools: 0,
      apis: [],
    }),
    close: async () => { openApiClosed = true },
  }
  const application = createTestGatewayApplication({
    config: {
      ...config,
      port: 0,
      webSearchProvider: 'none',
      webSearchMcpUrl: '',
      frontendProfile,
    },
    parentPort: null,
    autoStart: false,
    agent: disabledBackend(),
    inputAssets,
    realtimeProviderRegistry,
    realtimeProvider: privateProvider.key,
    frontendMcp,
    frontendOpenApi,
  })
  assert.equal(application.server.listening, false)
  assert.equal(application.services.taskManager != null, true)
  assert.equal(application.services.backendRuntime != null, true)
  assert.equal(application.services.inputAssets, inputAssets)
  assert.equal(application.services.knowledgeProvider, null)
  assert.equal(application.services.frontendKnowledge, null)
  assert.equal(application.services.frontendMcp, frontendMcp)
  assert.equal(application.services.frontendOpenApi, frontendOpenApi)

  application.start()
  if (!application.server.listening) {
    await once(application.server, 'listening')
  }
  assert.equal(application.server.listening, true)
  const address = application.server.address()
  const health = await fetch(`http://127.0.0.1:${address.port}/api/health`)
    .then(response => response.json())
  assert.equal(health.realtimeProvider, privateProvider.key)
  assert.deepEqual(health.frontendRetrieval.capabilities, ['url-fetch'])
  assert.equal(health.frontendRetrieval.searchProvider, null)
  assert.deepEqual(health.frontendKnowledge, {
    configured: false,
    capabilities: [],
    provider: null,
  })
  assert.deepEqual(health.frontendProfile, frontendProfile)
  assert.deepEqual(health.frontendMcp, {
    ok: true,
    initialized: true,
    tools: 0,
    servers: [],
  })
  assert.deepEqual(health.frontendOpenApi, {
    ok: true,
    initialized: true,
    tools: 0,
    apis: [],
  })
  assert.equal(
    health.realtimeProviders.some(provider => provider.key === privateProvider.key),
    false,
  )
  await application.close()
  assert.equal(mcpClosed, true)
  assert.equal(openApiClosed, true)
})

test('serves the bounded conversation projection without exposing journal records', async () => {
  const calls = []
  let closed = false
  const conversationHistory = {
    start: () => 0,
    messages: async context => {
      calls.push(context)
      return [{
        id: 'message-1',
        role: 'user',
        content: 'restored',
        source: 'voice-user',
      }]
    },
    close: () => { closed = true },
  }
  const application = createTestGatewayApplication({
    config: {
      ...config,
      port: 0,
      webSearchProvider: 'none',
      webSearchMcpUrl: '',
    },
    parentPort: null,
    autoStart: false,
    agent: disabledBackend(),
    conversationHistory,
    frontendMcp: null,
    frontendOpenApi: null,
  })
  application.start()
  if (!application.server.listening) await once(application.server, 'listening')
  const { port } = application.server.address()
  const response = await fetch(
    `http://127.0.0.1:${port}/api/conversations/desktop-session/messages`,
  )
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    messages: [{
      id: 'message-1',
      role: 'user',
      content: 'restored',
      source: 'voice-user',
    }],
  })
  assert.deepEqual(calls, [{
    ownerId: config.personalOwnerId,
    sessionId: 'desktop-session',
  }])
  await application.close()
  assert.equal(closed, true)
})

test('enables knowledge only when an external provider is injected', async () => {
  let closed = false
  const knowledgeProvider = {
    describe: () => ({
      protocolVersion: 1,
      key: 'external-rag',
      label: 'External RAG',
      capabilities: { filters: true },
    }),
    retrieve: async () => ({ results: [] }),
    close: async () => { closed = true },
  }
  const application = createTestGatewayApplication({
    config: {
      ...config,
      port: 0,
      webSearchProvider: 'none',
      webSearchMcpUrl: '',
    },
    parentPort: null,
    autoStart: false,
    agent: disabledBackend(),
    knowledgeProvider,
    knowledgeRuntimeOptions: { timeoutMs: 45_000 },
    frontendMcp: null,
    frontendOpenApi: null,
  })

  assert.equal(application.services.knowledgeProvider, knowledgeProvider)
  assert.equal(application.services.knowledgeLibrary, null)
  assert.equal(application.services.frontendKnowledge.timeoutMs, 45_000)
  assert.deepEqual(application.services.frontendKnowledge.describe(), {
    configured: true,
    capabilities: ['knowledge'],
    provider: {
      protocolVersion: 1,
      key: 'external-rag',
      label: 'External RAG',
      capabilities: { filters: true },
    },
  })
  await application.close()
  assert.equal(closed, true)
})

test('replaces Markdown memory through the public provider boundary', async () => {
  let closed = false
  const memoryProvider = {
    describe: () => ({
      protocolVersion: 1,
      key: 'external-memory',
      label: 'External Memory',
      capabilities: {
        semanticQuery: false,
        sessionObservation: false,
        audioStreamObservation: false,
      },
    }),
    list: ownerId => [{
      id: `memory_${ownerId}`,
      scope: 'memory',
      content: '- External fact',
      format: 'markdown',
      revision: 'revision-one',
    }],
    apply: async () => ({ changed: 0, documents: [] }),
    health: () => ({ ok: true, external: true }),
    close: async () => { closed = true },
  }
  const application = createTestGatewayApplication({
    config: {
      ...config,
      port: 0,
      webSearchProvider: 'none',
      webSearchMcpUrl: '',
    },
    parentPort: null,
    autoStart: false,
    agent: disabledBackend(),
    memoryProvider,
    frontendMcp: null,
    frontendOpenApi: null,
  })

  assert.equal(application.services.memoryProvider, memoryProvider)
  assert.equal(application.services.frontendMemoryService, memoryProvider)
  assert.deepEqual(application.services.frontendMemory.describe(), {
    configured: true,
    provider: {
      protocolVersion: 1,
      key: 'external-memory',
      label: 'External Memory',
      capabilities: {
        semanticQuery: false,
        sessionObservation: false,
        audioStreamObservation: false,
      },
    },
  })
  assert.match(
    application.services.frontendMemory.list('owner')[0].content,
    /External fact/,
  )
  assert.deepEqual(application.services.frontendMemory.health(), {
    ok: true,
    external: true,
    configured: true,
    provider: {
      protocolVersion: 1,
      key: 'external-memory',
      label: 'External Memory',
      capabilities: {
        semanticQuery: false,
        sessionObservation: false,
        audioStreamObservation: false,
      },
    },
  })
  await application.close()
  assert.equal(closed, true)
})

test('shutdown drains memory session observation and flush before closing its provider', async t => {
  const observed = Promise.withResolvers()
  const release = Promise.withResolvers()
  const calls = []
  const conversationSync = new ConversationSync()
  const application = createTestGatewayApplication({
    config: {
      ...config, port: 0, host: '127.0.0.1',
      memoryAutoEnabled: false, preferenceLearningEnabled: false,
      webSearchProvider: 'none',
    },
    autoStart: false, parentPort: null,
    frontendMcp: null, frontendOpenApi: null,
    conversationSync,
    frontendMemory: {
      list: () => [],
      ownsSessionObservation: () => true,
      observe: async () => { calls.push('observe'); observed.resolve(); await release.promise },
      flush: () => calls.push('flush'),
      close: () => calls.push('close'),
    },
  })
  let socket
  t.after(async () => {
    release.resolve()
    socket?.terminate()
    await application.close()
  })
  application.start()
  await once(application.server, 'listening')
  socket = new WebSocket(`ws://127.0.0.1:${application.server.address().port}/api/realtime?sessionId=drain-memory`)
  await once(socket, 'open')
  conversationSync.record({
    ownerId: config.personalOwnerId,
    sessionId: 'drain-memory',
    id: 'fresh-user-before-shutdown',
    role: 'user',
    source: 'voice-user',
    content: 'A fresh user message before shutdown.',
  })
  const closing = application.close()
  await observed.promise
  assert.deepEqual(calls, ['observe'])
  release.resolve()
  await closing
  assert.deepEqual(calls, ['observe', 'flush', 'close'])
})

test('lets a v2 provider exclusively own automatic memory learning', async () => {
  const memoryProvider = {
    describe: () => ({
      protocolVersion: 2,
      key: 'managed-memory',
      label: 'Managed Memory',
      capabilities: { semanticQuery: true, sessionObservation: true },
    }),
    list: () => [],
    apply: async () => ({ changed: 0, documents: [] }),
    query: async () => ({ memories: [], context: '' }),
    observe: async () => ({ observed: true }),
  }
  const application = createGatewayApplication({
    config: {
      ...config,
      port: 0,
      preferenceLearningEnabled: true,
      webSearchProvider: 'none',
      webSearchMcpUrl: '',
    },
    parentPort: null,
    autoStart: false,
    agent: disabledBackend(),
    memoryProvider,
    frontendMcp: null,
    frontendOpenApi: null,
  })
  assert.equal(application.services.frontendMemory.ownsSessionObservation(), true)
  assert.equal(application.services.preferenceCandidates, null)
  assert.equal(application.services.preferencePromoter, null)
  assert.equal(application.services.profileObserver, null)
  await application.close()
})

test('selects the VoiceMem connector from Gateway configuration', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'qwaudio-gateway-voicemem-'))
  const sidecarPath = join(directory, 'sidecar.py')
  writeFileSync(sidecarPath, '')
  const application = createGatewayApplication({
    config: {
      ...config,
      port: 0,
      memoryProvider: 'voicemem',
      voiceMemStateDirectory: join(directory, 'voicemem'),
      voiceMemPython: '',
      voiceMemSidecarPath: sidecarPath,
      webSearchProvider: 'none',
      webSearchMcpUrl: '',
    },
    parentPort: null,
    autoStart: false,
    agent: disabledBackend(),
    frontendMcp: null,
    frontendOpenApi: null,
  })

  assert.equal(
    application.services.memoryProvider.describe().key,
    'voicemem',
  )
  assert.equal(application.services.frontendMemory.ownsSessionObservation(), true)
  assert.equal(application.services.preferenceCandidates, null)
  await application.close()
})

test('can disable memory without constructing the default provider', async () => {
  const application = createTestGatewayApplication({
    config: {
      ...config,
      port: 0,
      webSearchProvider: 'none',
      webSearchMcpUrl: '',
    },
    parentPort: null,
    autoStart: false,
    agent: disabledBackend(),
    memoryProvider: null,
    frontendMcp: null,
    frontendOpenApi: null,
  })

  assert.equal(application.services.memoryProvider, null)
  assert.equal(application.services.frontendMemory, null)
  assert.equal(application.services.frontendMemoryService, null)
  await application.close()
})

test('serves and edits frontend memory through the generic client control plane', async () => {
  const calls = []
  const documents = [{
    id: 'memory_document',
    scope: 'memory',
    content: '# MEMORY\n\n- 用户喜欢茶',
    format: 'markdown',
    revision: 'revision-one',
    editable: true,
  }]
  const frontendMemory = {
    list: ownerId => {
      calls.push({ kind: 'list', ownerId })
      return documents
    },
    apply: async (ownerId, changes, context) => {
      calls.push({ kind: 'apply', ownerId, changes, context })
      if (changes[0]?.expectedRevision === 'stale') {
        throw Object.assign(new Error('memory document changed'), {
          code: 'stale_document',
        })
      }
      return { changed: 1, documents: [] }
    },
    health: () => ({ ok: true, configured: true, provider: { key: 'test' } }),
    close: async () => {},
  }
  const application = createTestGatewayApplication({
    config: {
      ...config,
      port: 0,
      memoryAutoEnabled: false,
      webSearchProvider: 'none',
      webSearchMcpUrl: '',
    },
    parentPort: null,
    autoStart: false,
    agent: disabledBackend(),
    frontendMemory,
    frontendMcp: null,
    frontendOpenApi: null,
  })
  application.start()
  if (!application.server.listening) await once(application.server, 'listening')
  const { port } = application.server.address()
  const origin = `http://127.0.0.1:${port}`
  try {
    const listed = await fetch(`${origin}/api/memory`)
    assert.equal(listed.status, 200)
    assert.deepEqual(await listed.json(), { documents })

    const invalid = await fetch(`${origin}/api/memory`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ changes: [] }),
    })
    assert.equal(invalid.status, 400)

    const stale = await fetch(`${origin}/api/memory`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        changes: [{
          document: 'memory',
          expectedRevision: 'stale',
          edits: [{ old_text: '- 用户喜欢茶', new_text: '' }],
        }],
      }),
    })
    assert.equal(stale.status, 409)
    assert.deepEqual(await stale.json(), {
      error: 'memory document changed',
      code: 'stale_document',
    })

    const changes = [{
      document: 'memory',
      expectedRevision: 'revision-one',
      edits: [{ old_text: '- 用户喜欢茶', new_text: '' }],
    }]
    const edited = await fetch(`${origin}/api/memory`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ changes }),
    })
    assert.equal(edited.status, 200)
    assert.deepEqual(await edited.json(), { changed: 1, documents: [] })
    assert.deepEqual(calls.at(-1), {
      kind: 'apply',
      ownerId: config.personalOwnerId,
      changes,
      context: { source: 'gateway-memory-api' },
    })
  } finally {
    await application.close()
  }
})

test('API memory edits refresh only the owning live Realtime session without reconnecting', { timeout: 10_000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'qwaudio-live-memory-'))
  const ownerId = 'live-memory-owner'
  const sessionId = 'live-memory-session'
  const preference = '- 用户找餐厅时优先推荐川菜'
  const userStore = new MarkdownContextStore({
    filePath: join(directory, 'USER.md'), scope: 'user', personalOwnerId: ownerId,
  })
  userStore.persist(ownerId, `# USER\n\n${preference}\n`)
  const frontendMemory = new FrontendMemoryRuntime({
    provider: new MarkdownMemoryProvider({ userStore }),
  })
  let subscriptions = 0
  const subscribe = frontendMemory.subscribe.bind(frontendMemory)
  t.mock.method(frontendMemory, 'subscribe', listener => {
    subscriptions += 1
    const unsubscribe = subscribe(listener)
    let active = true
    return () => {
      if (active) subscriptions -= 1
      active = false
      unsubscribe()
    }
  })

  const upstream = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  const upstreamEvents = new EventEmitter()
  const updates = []
  const upstreamConnections = []
  let socket
  let memoryPanel
  let application
  t.after(async () => {
    socket?.terminate()
    memoryPanel?.stop()
    await application?.close()
    for (const client of upstream.clients) client.terminate()
    await new Promise(resolve => upstream.close(resolve))
    rmSync(directory, { recursive: true, force: true })
  })
  await once(upstream, 'listening', { signal: t.signal })
  upstream.on('connection', client => {
    upstreamConnections.push(client)
    client.on('message', raw => {
      const message = JSON.parse(raw.toString())
      if (message.type !== 'session.update') return
      updates.push({ client, message })
      client.send(JSON.stringify({ type: 'session.updated' }))
      upstreamEvents.emit('session.update', message)
    })
    client.send(JSON.stringify({ type: 'session.created' }))
  })
  const provider = {
    key: 'memory-test', label: 'Memory Test', visibility: 'gateway-only',
    inputSampleRate: 16000, outputSampleRate: 24000,
    protocol: openAiCompatibleProtocol,
    model: () => 'memory-fixture', voice: () => null,
    isConfigured: () => true,
    url: () => `ws://127.0.0.1:${upstream.address().port}/realtime`,
    headers: () => ({}), classifyError: () => 'other',
    buildSession: ({ agentContext }) => ({ instructions: buildMemoryContext(agentContext) }),
    buildSpeakResponse: () => ({}), buildResultInjection: () => ({}),
    buildPermissionInjection: () => ({}),
  }
  application = createTestGatewayApplication({
    config: {
      ...config, host: '127.0.0.1', port: 0, personalOwnerId: ownerId,
      dataDirectory: directory, stateDirectory: join(directory, 'state'),
      gatewayDeviceStatePath: join(directory, 'devices.json'),
      gatewayAccessToken: '', gatewayAccessKeys: '',
      memoryAutoEnabled: false, preferenceLearningEnabled: false,
      sessionDigestEnabled: false, domainLibraryEnabled: false,
      reminderSchedulerEnabled: false, sleepTimeoutMs: 0,
      webSearchProvider: 'none', webSearchMcpUrl: '',
    },
    parentPort: null, autoStart: false,
    frontendMemory, frontendMcp: null, frontendOpenApi: null,
    realtimeProviderRegistry: createRealtimeProviderRegistry({ providers: [provider] }),
    realtimeProvider: provider.key,
  })
  application.start()
  if (!application.server.listening) await once(application.server, 'listening', { signal: t.signal })
  const { port } = application.server.address()
  socket = new WebSocket(`ws://127.0.0.1:${port}/api/realtime?sessionId=${sessionId}`)
  const clientEvents = new EventEmitter()
  const memoryNotifications = []
  socket.on('message', raw => {
    const event = JSON.parse(raw.toString())
    if (event.type === 'memory.changed') memoryNotifications.push(event)
    clientEvents.emit(event.type, event)
  })
  await once(socket, 'open', { signal: t.signal })
  const ready = once(clientEvents, 'voice.ready', { signal: t.signal })
  socket.send(JSON.stringify({ type: 'connect', inputEnabled: true, outputEnabled: true }))
  await ready
  assert.equal(subscriptions, 1)
  assert.equal(updates.length, 1)
  assert.match(updates[0].message.session.instructions, /优先推荐川菜/u)

  const listed = await requestJson({ port, path: '/api/memory' })
  const userDocument = listed.body.documents.find(document => document.scope === 'user')
  const refreshed = once(upstreamEvents, 'session.update', { signal: t.signal })
  const memoryDeleted = once(clientEvents, 'memory.changed', { signal: t.signal })
  const removed = await requestJson({
    port, path: '/api/memory', method: 'PATCH',
    body: { changes: [{
      document: 'user', expectedRevision: userDocument.revision,
      edits: [{ old_text: preference, new_text: '' }],
    }] },
  })
  assert.equal(removed.status, 200)
  assert.equal(removed.body.changed, 1)
  assert.deepEqual((await memoryDeleted)[0], { type: 'memory.changed' })
  const [updated] = await refreshed
  assert.doesNotMatch(updated.session.instructions, /优先推荐川菜/u)
  assert.match(updated.session.instructions, /<user_preferences revision=/u)
  assert.equal(updates.length, 2)
  assert.equal(updates[1].client, upstreamConnections[0])
  assert.equal(upstreamConnections.length, 1)

  // A pong is an ordered transport barrier, avoiding arbitrary sleeps when
  // checking that these changes did not produce a session.update frame.
  const flushUpstream = async () => {
    const pong = once(upstreamConnections[0], 'pong', { signal: t.signal })
    upstreamConnections[0].ping()
    await pong
    const clientPong = once(socket, 'pong', { signal: t.signal })
    socket.ping()
    await clientPong
  }
  await frontendMemory.apply('another-owner', [{
    document: 'user', append: '- 另一个用户喜欢粤菜',
  }], { source: 'gateway-memory-api' })
  await flushUpstream()
  assert.equal(updates.length, 2, 'another owner must not refresh this session')
  assert.equal(memoryNotifications.length, 1, 'another owner must not invalidate this client')

  const noOp = await requestJson({
    port, path: '/api/memory', method: 'PATCH',
    body: { changes: [{ document: 'user', edits: [{ old_text: '# USER', new_text: '# USER' }] }] },
  })
  assert.equal(noOp.status, 200)
  assert.equal(noOp.body.changed, 0)
  await flushUpstream()
  assert.equal(updates.length, 2, 'a no-op must not refresh the session')
  assert.equal(memoryNotifications.length, 1, 'a no-op must not invalidate the client')

  const stale = await requestJson({
    port, path: '/api/memory', method: 'PATCH',
    body: { changes: [{ document: 'user', expectedRevision: userDocument.revision, append: preference }] },
  })
  assert.equal(stale.status, 409)
  await flushUpstream()
  assert.equal(memoryNotifications.length, 1, 'a rejected write must not invalidate the client')

  const memoryRestored = once(clientEvents, 'memory.changed', { signal: t.signal })
  const restored = await frontendMemory.apply(ownerId, [{
    document: 'user', append: preference,
  }], { source: 'realtime-tool', sessionId })
  assert.equal(restored.changed, 1)
  await memoryRestored
  await flushUpstream()
  assert.equal(updates.length, 2, 'same-session tool writes must remain cache-only')
  assert.equal(memoryNotifications.length, 2, 'cache-only tool writes must still invalidate the client')

  const nextRefresh = once(upstreamEvents, 'session.update', { signal: t.signal })
  const editedAgain = await requestJson({
    port, path: '/api/memory', method: 'PATCH',
    body: { changes: [{ document: 'user', append: '- 用户希望回答简短' }] },
  })
  assert.equal(editedAgain.status, 200)
  const [latest] = await nextRefresh
  assert.match(latest.session.instructions, /优先推荐川菜/u)
  assert.match(latest.session.instructions, /回答简短/u)
  assert.equal(upstreamConnections.length, 1, 'memory refresh must not restart the provider connection')
  assert.equal(socket.readyState, WebSocket.OPEN)

  await flushUpstream()
  assert.equal(memoryNotifications.length, 3)
  const automaticWrite = once(clientEvents, 'memory.changed', { signal: t.signal })
  await frontendMemory.apply(ownerId, [{
    document: 'user', append: '- 用户通常周末外出就餐',
  }], { source: 'automatic-extraction' })
  await automaticWrite
  const latestMemory = await requestJson({ port, path: '/api/memory' })
  assert.match(latestMemory.body.documents[0].content, /周末外出就餐/u)
  assert.equal(memoryNotifications.length, 4, 'automatic extraction must invalidate without a tool.call event')
  assert.ok(memoryNotifications.every(event => Object.keys(event).join(',') === 'type'),
    'invalidation notifications must not contain private memory content or owner identifiers')
  const disconnected = once(socket, 'close', { signal: t.signal })
  socket.close()
  await disconnected

  // Reconnect as a muted client through the real GCP/SDK path. The Gateway
  // leases only one Client per owner, so close the legacy connection first.
  const panelEvents = new EventEmitter()
  memoryPanel = new GatewayClient({
    url: `ws://127.0.0.1:${port}/api/realtime?sessionId=memory-panel-session`,
    createSocket: url => new WebSocket(url),
    clientType: 'web', clientInstanceId: 'memory-panel', reconnect: false,
    configure: () => ({ inputEnabled: false, outputEnabled: false, textOnly: false }),
    onStatus: status => panelEvents.emit(status.state),
    onEvent: event => panelEvents.emit(event.type, event),
  })
  const panelReady = once(panelEvents, 'ready', { signal: t.signal })
  memoryPanel.start()
  await panelReady
  assert.equal(subscriptions, 1)
  const panelChanged = once(panelEvents, 'memory.changed', { signal: t.signal })
  await frontendMemory.apply(ownerId, [{
    document: 'user', append: '- 用户喜欢步行可达的餐厅',
  }], { source: 'automatic-extraction' })
  const [notification] = await panelChanged
  assert.equal(notification.type, 'memory.changed')
  assert.ok(notification.event_id)
  assert.deepEqual(Object.keys(notification).sort(), ['event_id', 'type'])
  assert.equal(upstreamConnections.length, 1, 'a muted memory panel must not start a model session')
  memoryPanel.stop()
  await application.close()
  assert.equal(subscriptions, 0, 'closing the session must release its memory subscription')
})

// 接线契约：新增的记忆模块默认关闭，显式开启时才装配。
// config 是模块级单例（import 时已读完 env），所以这里注入伪 config
// 而不是改 process.env —— 后者在同一进程内无效。
test('leaves the new memory modules unwired unless explicitly enabled', async () => {
  const app = createTestGatewayApplication({
    config: { ...config, reminderSchedulerEnabled: false },
    autoStart: false,
  })
  try {
    assert.equal(app.services.preferenceCandidates, null)
    assert.equal(app.services.preferencePromoter, null)
    assert.equal(app.services.sessionDigests, null)
    assert.equal(app.services.sessionSummariser, null)
    assert.equal(app.services.domainLibrary, null)
    assert.equal(app.services.domainSummariser, null)
  } finally {
    await app.close()
  }
})

// 资料库是独立开关，而且资料本体必须落在后端读得到的目录里。
test('wires the domain library on its own switch and imports a local file', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'qwaudio-domain-wire-'))
  const source = join(directory, '手册.md')
  writeFileSync(source, '# 信用卡业务手册\n\n## 年费规则\n普卡首年免年费。\n')
  const documents = join(directory, 'workspace', 'domain')
  const app = createTestGatewayApplication({
    config: {
      ...config,
      reminderSchedulerEnabled: false,
      domainLibraryEnabled: true,
      domainDocumentDirectory: documents,
      domainIndexPath: join(directory, 'domain-index.json'),
    },
    autoStart: false,
  })
  try {
    const { domainLibrary } = app.services
    assert.ok(domainLibrary)
    assert.equal(app.services.knowledgeProvider.documentConverter, null)
    // 会话摘要没开，两者互不牵连
    assert.equal(app.services.sessionDigests, null)

    const entry = domainLibrary.import({ ownerId: 'user_personal', sourcePath: source })
    // 落盘位置就是交给后端的地址
    assert.equal(entry.path, join(documents, '手册.md'))
    assert.match(readFileSync(entry.path, 'utf8'), /年费规则/)
    assert.equal(domainLibrary.list('user_personal').length, 1)
  } finally {
    await app.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

// PDF / Word 走后台转换，而这条路径此前没有任何测试执行过 —— 它曾经调用一个
// 早已不存在的 coordinator 变量，运行时必抛 ReferenceError，而全套测试照样全绿。
// 所以这条测试要真的把 runner 跑起来，不能只断言接线。
test('converts a PDF through the BackendPort and ingests what the backend wrote', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'qwaudio-domain-convert-'))
  const source = join(directory, 'manual.pdf')
  writeFileSync(source, '%PDF-1.7 pretend this is a PDF')
  const documents = join(directory, 'workspace', 'domain')
  const submitted = []
  const application = createTestGatewayApplication({
    config: {
      ...config,
      port: 0,
      webSearchProvider: 'none',
      webSearchMcpUrl: '',
      reminderSchedulerEnabled: false,
      domainLibraryEnabled: true,
      domainDocumentDirectory: documents,
      domainIndexPath: join(directory, 'domain-index.json'),
    },
    parentPort: null,
    autoStart: false,
    agent: disabledBackend(),
    frontendMcp: null,
    frontendOpenApi: null,
    // 最小 BackendPort 替身：把「提取文字」做成真的写文件 —— 收录那一步是以
    // 文件系统为准、不看后端的回话，所以只回一句话的替身过不了这条测试。
    backendRuntime: {
      runIsolated: async (input, options) => {
        submitted.push({ input, options })
        const target = input.instruction.match(/原样写入「(.+?)」/)[1]
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, '# Manual\n\n## Warranty\nOne year.\n')
        return { content: 'done' }
      },
      cancel: async taskId => ({ taskId, state: 'cancelled' }),
    },
  })
  try {
    application.start()
    if (!application.server.listening) await once(application.server, 'listening')
    const { port } = application.server.address()

    const accepted = await fetch(`http://127.0.0.1:${port}/api/domain/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: source }),
    }).then(response => response.json())
    assert.ok(accepted.task_id, `导入应当派出后台任务，实际返回 ${JSON.stringify(accepted)}`)

    await application.services.taskManager.wait(accepted.task_id)

    // 关键断言：请求真的经过了 BackendPort，而不是某个具体后台实现
    assert.equal(submitted.length, 1)
    const [{ input, options }] = submitted
    assert.match(input.instruction, /原样写入/, '目标路径要在隔离指令里')
    assert.ok(options.ownerId, 'ownerId 必须透传')
    assert.ok(options.taskId, 'taskId 必须透传，取消与状态查询都靠它')
    assert.ok(options.signal, 'signal 必须透传，否则取消传不到后端')
    assert.equal(typeof options.onEvent, 'function', 'onEvent 必须透传，否则没有进度')

    // 资料库面板轮询一个静默的入库作业；它不会进入自动播报队列。
    const conversion = application.services.taskManager.get(accepted.task_id)
    assert.equal(conversion.kind, 'knowledge_ingestion')
    assert.equal(conversion.notificationPolicy, 'silent')
    assert.equal(conversion.notificationStatus, 'none')

    // 后端写下的文件被收录了
    const [entry] = application.services.domainLibrary.list(options.ownerId)
    assert.equal(entry.path, join(documents, 'manual.md'))
    assert.match(readFileSync(entry.path, 'utf8'), /Warranty/)
  } finally {
    await application.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('keeps knowledge documents and index in shared data, independent of the workspace', () => {
  assert.equal(config.domainDocumentDirectory, join(config.dataDirectory, 'knowledge/documents'))
  assert.equal(config.domainIndexPath, join(config.dataDirectory, 'knowledge/index.json'))
})

// 会话摘要是独立开关：它不依赖偏好自更新，也不该被后者带起来。
test('wires session digests and the summariser on their own switch', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'qwaudio-digest-wire-'))
  const app = createTestGatewayApplication({
    config: {
      ...config,
      reminderSchedulerEnabled: false,
      memoryAutoEnabled: true,
      memoryApiKey: 'test-key',
      sessionDigestEnabled: true,
      sessionDigestPath: join(directory, 'session-digests.json'),
      memoryAuditPath: join(directory, 'audit.jsonl'),
    },
    autoStart: false,
  })
  try {
    const { sessionDigests, sessionSummariser } = app.services
    assert.ok(sessionDigests)
    assert.ok(sessionSummariser)
    assert.equal(sessionSummariser.enabled(), true)
    // 偏好自更新没开，两者互不牵连
    assert.equal(app.services.preferenceCandidates, null)

    // 端到端：记一场会话 → 能按话题查回来
    sessionDigests.record({
      ownerId: 'user_personal',
      sessionId: 's_a',
      topics: ['LOCOMO'],
      gist: '跑了一轮压缩评测',
      turns: 9,
    })
    const found = sessionDigests.search({ ownerId: 'user_personal', keyword: 'LOCOMO' })
    assert.equal(found.length, 1)
    assert.equal(found[0].gist, '跑了一轮压缩评测')
    // 必须落盘，否则重启即清零、「前几天聊的」永远答不上
    assert.match(
      readFileSync(join(directory, 'session-digests.json'), 'utf8'),
      /LOCOMO/,
    )
  } finally {
    await app.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('wires rolling summary and preference learning when enabled', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'qwaudio-wire-'))
  const app = createTestGatewayApplication({
    config: {
      ...config,
      reminderSchedulerEnabled: false,
      memoryAutoEnabled: true,
      memoryApiKey: 'test-key',
      preferenceLearningEnabled: true,
      preferenceCandidatePath: join(directory, 'candidates.json'),
      userModelPath: join(directory, 'USER.md'),
      frontendMemoryPath: join(directory, 'MEMORY.md'),
      memoryAuditPath: join(directory, 'audit.jsonl'),
    },
    autoStart: false,
  })
  try {
    const {
      preferenceCandidates,
      preferencePromoter,
      profileObserver,
      frontendMemoryService,
    } = app.services
    assert.ok(preferenceCandidates)
    assert.equal(preferenceCandidates.health().persistenceEnabled, true)
    assert.ok(preferencePromoter)
    assert.equal(preferencePromoter.enabled(), true)
    // 观察器是槽位池的生产者；没有它整条链没有输入，晋升永远是 0
    assert.ok(profileObserver)
    assert.equal(profileObserver.enabled(), true)

    // 端到端：确认 2 次且跨 2 会话 → 晋升器写入 USER.md 的观察推断段
    for (const sessionId of ['s0', 's1']) {
      preferenceCandidates.observe({
        ownerId: 'user_personal',
        sessionId,
        field: 'occupation',
        value: '中学语文老师',
      })
    }
    assert.equal(preferenceCandidates.promotable('user_personal').length, 1)
    const promoted = await preferencePromoter.run({ ownerId: 'user_personal' })
    assert.deepEqual(promoted.map(item => item.label), ['职业：中学语文老师'])

    const [document] = frontendMemoryService.list('user_personal', { scope: 'user' })
    assert.match(document.content, /## 观察推断/)
    assert.match(document.content, /- 职业：中学语文老师/)
    // 观察区必须排在原有内容之后 —— 晋升只追加，不改写既有段落。
    // 这里的初始文档是空模板 '# USER'，所以断言它仍在最前。
    assert.match(document.content, /^# USER/)
    assert.equal(
      document.content.indexOf('# USER') < document.content.indexOf('## 观察推断'),
      true,
    )
  } finally {
    await app.close()
  }
})
