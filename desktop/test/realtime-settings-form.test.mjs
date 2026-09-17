import assert from 'node:assert/strict'
import test from 'node:test'
import { REALTIME_PROVIDERS, REALTIME_SETTING_KEYS, realtimeSettingsValues } from '../../shared/realtime-provider-definitions.mjs'
import { realtimeSettingsFields } from '../src/realtime-settings-form.mjs'
import { normalizeSettings, parseSettings, updateSettingsContent } from '../src/settings-config.mjs'

test('every provider has unique, persisted fields and a declared configuration prerequisite', () => {
  const keys = REALTIME_PROVIDERS.flatMap(provider => provider.settings.map(field => field.key))
  const environment = Object.values(REALTIME_SETTING_KEYS)
  assert.equal(new Set(keys).size, keys.length)
  assert.equal(new Set(environment).size, environment.length)
  for (const provider of REALTIME_PROVIDERS) {
    assert.ok(provider.settings.some(field => field.key === provider.requiredConfiguration.field))
    const draft = { realtimeProvider: provider.key }
    for (const field of provider.settings) {
      assert.ok(['text', 'password', 'url', 'model'].includes(field.type))
      draft[field.key] = field.type === 'url' ? 'wss://voice.example/realtime' : `test-${field.key}`
    }
    const parsed = parseSettings(updateSettingsContent('', draft))
    for (const field of provider.settings) assert.equal(parsed[field.key], draft[field.key])
  }
})

test('model families select independent voice overrides without mutating drafts', () => {
  const provider = REALTIME_PROVIDERS.find(provider => provider.key === 'dashscope')
  const values = realtimeSettingsValues({ audioRealtimeVoice: 'my-audio', omniRealtimeVoice: 'my-omni' })
  const voice = () => realtimeSettingsFields(provider, values).filter(field => field.label === '音色')
  assert.equal(voice()[0].key, 'audioRealtimeVoice')
  assert.ok(voice()[0].placeholder)
  values.realtimeModel = 'qwen3.5-omni-plus-realtime'
  assert.equal(voice()[0].key, 'omniRealtimeVoice')
  assert.ok(voice()[0].placeholder)
  values.realtimeModel = 'future-model'
  assert.equal(voice()[0].disabled, true)
  assert.equal(voice()[0].key, undefined)
  assert.equal(values.audioRealtimeVoice, 'my-audio')
  assert.equal(values.omniRealtimeVoice, 'my-omni')
  assert.equal(realtimeSettingsValues().audioRealtimeVoice, '')
})

test('every provider presents the same four slots in the same order', () => {
  for (const provider of REALTIME_PROVIDERS) {
    const fields = realtimeSettingsFields(provider, realtimeSettingsValues())
    assert.deepEqual(fields.map(field => field.label), ['服务地址', 'API Key', '模型', '音色'])
    assert.deepEqual(fields.map(field => field.slot), ['endpoint', 'credential', 'model', 'voice'])
  }
})

test('service-owned model and voice rows stay visible but have no writable binding', () => {
  for (const provider of REALTIME_PROVIDERS.filter(provider => !provider.settings.some(field => field.type === 'model'))) {
    const fields = realtimeSettingsFields(provider, realtimeSettingsValues())
    for (const field of fields.filter(field => ['model', 'voice'].includes(field.slot))) {
      assert.equal(field.disabled, true)
      assert.equal(field.key, undefined)
    }
    assert.equal(fields[0].disabled, false)
    assert.equal(fields[1].disabled, false)
  }
})

test('a provider without a credential binding gets a disabled API Key row', () => {
  const provider = { key: 'no-auth', settings: [] }
  const fields = realtimeSettingsFields(provider, {})
  assert.equal(fields[1].label, 'API Key')
  assert.equal(fields[1].disabled, true)
  assert.equal(fields[1].key, undefined)
})

test('inactive invalid endpoints survive but cannot block the selected provider', () => {
  const settings = { realtimeProvider: 'stepfun', speechToSpeechRealtimeUrl: 'not-a-url' }
  assert.equal(normalizeSettings(settings).speechToSpeechRealtimeUrl, 'not-a-url')
  assert.throws(() => normalizeSettings({ ...settings, realtimeProvider: 'speech-to-speech' }), /Invalid URL/)
})

test('legacy aliases and workspace endpoint defaults remain compatible', () => {
  const settings = parseSettings('', { DASHSCOPE_WORKSPACE_ID: 'workspace123', QWEN_AUDIO_REALTIME_API_KEY: 'legacy-key' })
  assert.equal(settings.dashscopeApiKey, 'legacy-key')
  assert.equal(settings.realtimeBaseUrl, 'wss://workspace123.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime')
  const overridden = parseSettings('DASHSCOPE_API_KEY=\nQWEN_AUDIO_REALTIME_URL=wss://voice.example/realtime', {
    DASHSCOPE_API_KEY: 'do-not-restore', QWEN_AUDIO_REALTIME_BASE_URL: 'wss://fallback.example',
  })
  assert.equal(overridden.dashscopeApiKey, '')
  assert.equal(overridden.realtimeBaseUrl, 'wss://voice.example/realtime')
})
