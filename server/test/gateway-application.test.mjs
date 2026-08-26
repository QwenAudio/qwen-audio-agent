import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import { createGatewayApplication } from '../src/app/gateway-application.mjs'
import { config } from '../src/core/config.mjs'
import { createRealtimeProviderRegistry } from '../src/voice/providers/provider-registry.mjs'
import { openAiCompatibleProtocol } from '../src/voice/providers/openai-compatible-protocol.mjs'

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
    subscribe: () => () => {},
    close: async () => {},
    canRecoverDelegatedWork: () => false,
    recoverDelegatedWork: async () => null,
  }
}

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
  const application = createGatewayApplication({
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
  const application = createGatewayApplication({
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
  const application = createGatewayApplication({
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
    frontendMcp: null,
    frontendOpenApi: null,
  })

  assert.equal(application.services.knowledgeProvider, knowledgeProvider)
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
  const application = createGatewayApplication({
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
    },
  })
  await application.close()
  assert.equal(closed, true)
})

test('can disable memory without constructing the default provider', async () => {
  const application = createGatewayApplication({
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
