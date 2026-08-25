import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import { createGatewayApplication } from '../src/app/gateway-application.mjs'
import { config } from '../src/core/config.mjs'
import { createRealtimeProviderRegistry } from '../src/voice/providers/provider-registry.mjs'
import { openAiCompatibleProtocol } from '../src/voice/providers/openai-compatible-protocol.mjs'

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
  const application = createGatewayApplication({
    config: {
      ...config,
      port: 0,
      webSearchProvider: 'none',
      webSearchMcpUrl: '',
    },
    parentPort: null,
    autoStart: false,
    inputAssets,
    realtimeProviderRegistry,
    realtimeProvider: privateProvider.key,
  })
  assert.equal(application.server.listening, false)
  assert.equal(application.services.taskManager != null, true)
  assert.equal(application.services.backendRuntime != null, true)
  assert.equal(application.services.inputAssets, inputAssets)
  assert.equal(application.services.documentExtractor.describe().key, 'builtin-text')
  assert.equal(application.services.knowledgeStore.describe().key, 'local-files')
  assert.equal(application.services.knowledgeIndexer != null, true)

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
  assert.equal(
    health.realtimeProviders.some(provider => provider.key === privateProvider.key),
    false,
  )
  await application.close()
})
