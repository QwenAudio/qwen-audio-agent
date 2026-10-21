import assert from 'node:assert/strict'
import test from 'node:test'
import { config } from '../src/core/config.mjs'
import { resolveRealtimeFrontendConfiguration } from '../../shared/realtime-provider-catalog.mjs'
import { realtimeModelCatalog } from '../../shared/realtime-model-catalog.mjs'
import { REALTIME_PROVIDERS } from '../../shared/realtime-provider-definitions.mjs'
import { defaultRealtimeProviderRegistry, describeActiveRealtime } from '../src/voice/providers/registry.mjs'
import { providerRuntimeConfiguration } from '../src/voice/providers/runtime-configuration.mjs'

function applyFrontend(t, env) {
  const resolved = resolveRealtimeFrontendConfiguration(env)
  const values = {
    audioProvider: resolved.active.provider,
    realtimeModelCatalogs: resolved.modelCatalogs,
    realtimeModel: resolved.active.model,
    realtimeVoice: resolved.active.voice,
    realtimeEndpoint: resolved.active.endpoint,
    realtimeCredential: resolved.credential,
  }
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, config[key]]))
  Object.assign(config, values)
  t.after(() => Object.assign(config, previous))
  return defaultRealtimeProviderRegistry.resolve(resolved.active.provider)
}

for (const { key } of REALTIME_PROVIDERS) {
  test(`${key}: the same connection fields configure only the active adapter`, t => {
    const model = realtimeModelCatalog(key)?.defaultModel
    const provider = applyFrontend(t, {
      QWEN_AUDIO_REALTIME_PROVIDER: key,
      QWEN_AUDIO_REALTIME_MODEL: model || '',
      QWEN_AUDIO_REALTIME_API_KEY: 'frontend-test-secret',
      QWEN_AUDIO_REALTIME_URL: 'wss://realtime.invalid/native?marker=preserved',
      QWEN_AUDIO_REALTIME_VOICE: model ? 'custom-voice' : '',
      // Backend credentials must not replace explicit frontend credentials.
      DASHSCOPE_API_KEY: 'backend-only-dashscope',
      OPENAI_API_KEY: 'backend-only-openai',
    })
    assert.equal(provider.isConfigured(), true)
    assert.equal(provider.voice(), model ? 'custom-voice' : null)
    if (model) assert.equal(provider.model(), model)
    const url = new URL(provider.url())
    assert.equal(url.origin, 'wss://realtime.invalid')
    assert.equal(url.searchParams.get('marker'), 'preserved')
    if (key === 'google-live') {
      assert.equal(url.searchParams.get('key'), 'frontend-test-secret')
      assert.deepEqual(provider.headers(), {})
    } else if (key === 'doubao-seeduplex') {
      assert.deepEqual(provider.headers(), { 'X-Api-Key': 'frontend-test-secret' })
    } else {
      assert.deepEqual(provider.headers(), { Authorization: 'Bearer frontend-test-secret' })
    }
    const description = describeActiveRealtime()
    assert.deepEqual(description.providers.map(item => item.key), [key])
    assert.doesNotMatch(JSON.stringify(description), /frontend-test-secret|backend-only/)
    for (const other of REALTIME_PROVIDERS.filter(item => item.key !== key)) {
      const inactive = providerRuntimeConfiguration(other.key)
      assert.equal(inactive.credential, '')
      assert.equal(inactive.endpoint, '')
      assert.equal(defaultRealtimeProviderRegistry.resolve(other.key).isConfigured(), false)
    }
  })
}

for (const key of ['speech-to-speech', 'minicpm-o']) {
  test(`${key}: upstream owns model and voice and authentication remains optional`, t => {
    const provider = applyFrontend(t, {
      QWEN_AUDIO_REALTIME_PROVIDER: key,
      QWEN_AUDIO_REALTIME_MODEL: 'not-an-upstream-model-selection',
      QWEN_AUDIO_REALTIME_VOICE: 'not-an-upstream-voice-selection',
      QWEN_AUDIO_REALTIME_API_KEY: '',
    })
    assert.equal(provider.isConfigured(), true)
    assert.equal(provider.voice(), null)
    assert.deepEqual(provider.headers(), {})
    const session = provider.buildSession({ configured: false })
    assert.doesNotMatch(JSON.stringify(session), /not-an-upstream/)
    assert.ok(provider.url().startsWith('ws://127.0.0.1:'))
  })
}
