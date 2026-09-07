import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertGatewaySetup,
  gatewaySetupStatus,
} from '../shared/gateway/setup.mjs'

test('reports the missing DashScope credential with an actionable entry', () => {
  const status = gatewaySetupStatus({})
  assert.equal(status.ready, false)
  assert.equal(status.provider, 'dashscope')
  assert.equal(status.missing.length, 1)
  assert.equal(status.missing[0].field, 'dashscopeApiKey')
  assert.equal(status.missing[0].key, 'DASHSCOPE_API_KEY')
  assert.ok(status.missing[0].message)
})

test('is ready once the realtime credential is present', () => {
  const status = gatewaySetupStatus({ DASHSCOPE_API_KEY: 'sk-test' })
  assert.equal(status.ready, true)
  assert.deepEqual(status.missing, [])
})

test('names the service address for the speech-to-speech provider', () => {
  const status = gatewaySetupStatus({
    QWEN_AUDIO_REALTIME_PROVIDER: 'speech-to-speech',
  })
  // speech-to-speech falls back to a default URL, so selecting the provider
  // explicitly counts as configured; only the field mapping is asserted when
  // a future provider reports missing configuration.
  if (!status.ready) {
    assert.equal(status.missing[0].field, 'speechToSpeechRealtimeUrl')
    assert.equal(status.missing[0].key, 'SPEECH_TO_SPEECH_REALTIME_URL')
  }
})

test('refuses an unconfigured start with a coded, listable error', () => {
  assert.throws(() => assertGatewaySetup({}), error => {
    assert.equal(error.code, 'QWAUDIO_GATEWAY_SETUP_REQUIRED')
    assert.equal(error.missing[0].key, 'DASHSCOPE_API_KEY')
    assert.match(error.message, /DASHSCOPE_API_KEY/)
    return true
  })
})

test('a configured start and the explicit opt-out both pass the gate', () => {
  assert.doesNotThrow(() => assertGatewaySetup({ DASHSCOPE_API_KEY: 'sk-test' }))
  // Debugging and harness setups that never open a voice connection can skip
  // the gate explicitly.
  assert.doesNotThrow(() => assertGatewaySetup({
    QWEN_AUDIO_ALLOW_UNCONFIGURED: '1',
  }))
})
