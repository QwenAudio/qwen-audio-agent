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
    config: { ...config, port: 0 },
    parentPort: null,
    autoStart: false,
    inputAssets,
    realtimeProviderRegistry,
    realtimeProvider: privateProvider.key,
  })
  assert.equal(application.server.listening, false)
  assert.equal(application.services.taskManager != null, true)
  assert.equal(application.services.coordinator != null, true)
  assert.equal(application.services.inputAssets, inputAssets)

  application.start()
  if (!application.server.listening) {
    await once(application.server, 'listening')
  }
  assert.equal(application.server.listening, true)
  const address = application.server.address()
  const health = await fetch(`http://127.0.0.1:${address.port}/api/health`)
    .then(response => response.json())
  assert.equal(health.realtimeProvider, privateProvider.key)
  assert.equal(health.capabilities.includes('composer.dictation'), false)
  assert.equal(
    health.realtimeProviders.some(provider => provider.key === privateProvider.key),
    false,
  )
  await application.close()
})

test('advertises dictation only when its default-off feature flag is enabled', async () => {
  const application = createGatewayApplication({
    config: { ...config, port: 0, dictationEnabled: true },
    parentPort: null,
    autoStart: false,
  })
  application.start()
  if (!application.server.listening) await once(application.server, 'listening')
  const health = await fetch(
    `http://127.0.0.1:${application.server.address().port}/api/health`,
  ).then(response => response.json())
  assert.equal(health.protocolVersion, '2.1.0')
  assert.equal(health.capabilities.includes('composer.dictation'), true)
  assert.equal(health.capabilities.includes('composer.dictation-edit'), true)
  assert.equal(health.capabilities.includes('composer.dictation-send'), true)
  await application.close()
})
