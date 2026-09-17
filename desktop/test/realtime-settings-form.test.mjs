import assert from 'node:assert/strict'
import test from 'node:test'
import {
  REALTIME_PROVIDERS,
  REALTIME_SETTING_FIELDS,
  realtimeSettingsFromProfileState,
  realtimeSettingsProfileState,
  realtimeSettingsValues,
} from '../../shared/realtime-provider-definitions.mjs'
import { realtimeSettingsFields } from '../src/realtime-settings-form.mjs'
import { normalizeSettings, parseSettings } from '../src/settings-config.mjs'

test('each provider has unique UI bindings and lossless structured drafts', () => {
  const keys = REALTIME_PROVIDERS.flatMap(provider => provider.settings.map(field => field.key))
  assert.equal(new Set(keys).size, keys.length)
  assert.deepEqual(REALTIME_SETTING_FIELDS, ['realtimeProvider', ...keys])
  for (const provider of REALTIME_PROVIDERS) {
    assert.ok(provider.settings.some(field => field.key === provider.requiredConfiguration.field))
    const draft = realtimeSettingsValues({ realtimeProvider: provider.key })
    for (const field of provider.settings) draft[field.key] = 'test-' + field.key
    assert.deepEqual(realtimeSettingsFromProfileState(realtimeSettingsProfileState(draft)), draft)
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

test('explicit empty runtime fields override fallback values', () => {
  const settings = parseSettings('DASHSCOPE_API_KEY=\nQWEN_AUDIO_REALTIME_BASE_URL=wss://voice.example/realtime', {
    DASHSCOPE_API_KEY: 'do-not-restore', QWEN_AUDIO_REALTIME_BASE_URL: 'wss://fallback.example',
  })
  assert.equal(settings.dashscopeApiKey, '')
  assert.equal(settings.realtimeBaseUrl, 'wss://voice.example/realtime')
})

test('provider profile state isolates drafts and round-trips the flat settings contract', () => {
  const settings = realtimeSettingsValues({
    realtimeProvider: 'stepfun',
    dashscopeApiKey: 'dashscope-secret',
    realtimeModel: 'qwen-audio-3.0-realtime-plus',
    audioRealtimeVoice: 'Cherry',
    omniRealtimeVoice: 'Serena',
    stepfunApiKey: 'stepfun-secret',
    stepfunRealtimeModel: 'stepaudio-3-realtime-preview',
    stepfunRealtimeVoice: 'qingchunshaonv',
  })
  const state = realtimeSettingsProfileState(settings)

  assert.equal(state.activeProvider, 'stepfun')
  assert.deepEqual(Object.keys(state.profiles.stepfun).sort(), [
    'credential', 'endpoint', 'model', 'voice',
  ])
  assert.equal(state.profiles.stepfun.credential, 'stepfun-secret')
  assert.equal(state.profiles.dashscope.credential, 'dashscope-secret')
  assert.equal(state.profiles.dashscope.audioVoice, 'Cherry')
  assert.equal(state.profiles.dashscope.omniVoice, 'Serena')
  assert.equal('dashscopeApiKey' in state.profiles.stepfun, false)
  assert.equal(Object.isFrozen(state), true)
  assert.equal(Object.isFrozen(state.profiles), true)
  assert.equal(Object.isFrozen(state.profiles.stepfun), true)
  assert.deepEqual(realtimeSettingsFromProfileState(state), settings)
})

test('profile state conversion ignores unknown providers and fields', () => {
  const values = realtimeSettingsFromProfileState({
    activeProvider: 'unknown-provider',
    profiles: {
      stepfun: { model: 'custom-stepfun-model', unrelated: 'ignored' },
      unknown: { secret: 'ignored' },
    },
  })

  assert.equal(values.realtimeProvider, realtimeSettingsValues().realtimeProvider)
  assert.equal(values.stepfunRealtimeModel, 'custom-stepfun-model')
  assert.equal('unrelated' in values, false)
  assert.equal('secret' in values, false)
})

test('switching the structured active provider preserves every other draft', () => {
  const initial = realtimeSettingsProfileState({
    realtimeProvider: 'dashscope', realtimeModel: 'qwen3.5-omni-plus-realtime',
    stepfunRealtimeModel: 'stepaudio-3-realtime-preview',
  })
  const selected = { ...initial, activeProvider: 'stepfun' }
  const values = realtimeSettingsFromProfileState(selected)
  assert.equal(values.realtimeProvider, 'stepfun')
  assert.equal(values.realtimeModel, 'qwen3.5-omni-plus-realtime')
  assert.equal(values.stepfunRealtimeModel, 'stepaudio-3-realtime-preview')
})
