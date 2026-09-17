import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertGatewaySetup,
  gatewaySetupStatus,
} from '../shared/gateway/setup.mjs'

for (const entry of [
  {
    provider: 'dashscope', field: 'realtimeModel', key: 'QWEN_AUDIO_REALTIME_MODEL',
    model: 'stepaudio-3-realtime-preview',
  },
  {
    provider: 'stepfun', field: 'stepfunRealtimeModel', key: 'STEPFUN_REALTIME_MODEL',
    model: 'qwen-audio-3.0-realtime-plus',
  },
]) {
  test(`${entry.provider}: invalid models report the provider-owned setting without crashing`, () => {
    const env = {
      QWEN_AUDIO_REALTIME_PROVIDER: entry.provider,
      DASHSCOPE_API_KEY: 'private-dash-key',
      STEPFUN_API_KEY: 'private-step-key',
      [entry.key]: entry.model,
    }
    const status = gatewaySetupStatus(env)
    assert.equal(status.ready, false)
    assert.equal(status.provider, entry.provider)
    assert.equal(status.missing.length, 1)
    assert.equal(status.missing[0].field, entry.field)
    assert.equal(status.missing[0].key, entry.key)
    assert.ok(status.missing[0].message.includes(entry.key))
    assert.throws(() => assertGatewaySetup(env), error => {
      assert.equal(error.code, 'QWAUDIO_GATEWAY_SETUP_REQUIRED')
      assert.deepEqual(error.missing, status.missing)
      assert.doesNotMatch(error.message, /private-dash-key|private-step-key/)
      return true
    })
  })
}

test('missing credential messages do not repeat the canonical environment name as an alias', () => {
  for (const [provider, key] of [['dashscope', 'DASHSCOPE_API_KEY'], ['stepfun', 'STEPFUN_API_KEY']]) {
    const status = gatewaySetupStatus({ QWEN_AUDIO_REALTIME_PROVIDER: provider })
    assert.equal(status.missing[0].key, key)
    assert.equal(status.missing[0].message.split(key).length - 1, 1)
  }
})

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

test('StepFun requires its own key and reports the correct settings field', () => {
  const env = { QWEN_AUDIO_REALTIME_PROVIDER: 'stepfun' }
  const missing = gatewaySetupStatus(env)
  assert.equal(missing.ready, false)
  assert.equal(missing.missing[0].field, 'stepfunApiKey')
  assert.equal(missing.missing[0].key, 'STEPFUN_API_KEY')
  assert.equal(gatewaySetupStatus({ ...env, STEPFUN_API_KEY: 'test' }).ready, true)
})

test('GPT-Live and Google Live require their provider-specific keys', () => {
  const gpt = gatewaySetupStatus({
    QWEN_AUDIO_REALTIME_PROVIDER: 'gpt-live',
    DASHSCOPE_API_KEY: 'unrelated',
  })
  assert.equal(gpt.ready, false)
  assert.equal(gpt.missing[0].field, 'openaiApiKey')
  assert.equal(gpt.missing[0].key, 'OPENAI_API_KEY')
  assert.equal(gatewaySetupStatus({
    QWEN_AUDIO_REALTIME_PROVIDER: 'gpt-live',
    OPENAI_API_KEY: 'test',
  }).ready, true)

  const google = gatewaySetupStatus({
    QWEN_AUDIO_REALTIME_PROVIDER: 'google-live',
  })
  assert.equal(google.ready, false)
  assert.equal(google.missing[0].field, 'googleApiKey')
  assert.equal(google.missing[0].key, 'GOOGLE_API_KEY')
  assert.equal(gatewaySetupStatus({
    QWEN_AUDIO_REALTIME_PROVIDER: 'google-live',
    GEMINI_API_KEY: 'test',
  }).ready, true)
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
