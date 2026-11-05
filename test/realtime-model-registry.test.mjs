import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BUILTIN_REALTIME_MODEL_CATALOGS,
  DASHSCOPE_AUDIO_30_REALTIME_MODEL,
  DASHSCOPE_AUDIO_31_REALTIME_MODEL,
  DASHSCOPE_AUDIO_31_FLASH_REALTIME_MODEL,
  DASHSCOPE_AUDIO_FLASH_REALTIME_MODEL,
  DASHSCOPE_OMNI_38_FLASH_REALTIME_MODEL,
  DASHSCOPE_OMNI_FLASH_REALTIME_MODEL,
  DASHSCOPE_OMNI_PLUS_REALTIME_MODEL,
  DASHSCOPE_REALTIME_MODEL_PROFILES,
  DEFAULT_DASHSCOPE_REALTIME_MODEL,
  DEFAULT_DASHSCOPE_REALTIME_VOICE,
  DEFAULT_DOUBAO_SEEDUPLEX_REALTIME_MODEL,
  DEFAULT_DOUBAO_SEEDUPLEX_REALTIME_VOICE,
  DEFAULT_GOOGLE_LIVE_REALTIME_MODEL,
  DEFAULT_GPT_LIVE_REALTIME_MODEL,
  DEFAULT_STEPFUN_REALTIME_MODEL,
  REALTIME_MODEL_BUILTINS,
  listDashScopeRealtimeModelProfiles,
  realtimeModelCatalog,
  resolveDashScopeRealtimeModelProfile,
  resolveRealtimeModelProfile,
} from '../shared/realtime-model-catalog.mjs'

const audioCapabilities = {
  textInput: true, audioInput: true, imageInput: false, videoInput: false,
  textOutput: true, audioOutput: true, functionCalling: true,
}
const visualCapabilities = { ...audioCapabilities, imageInput: true, videoInput: true }
const audioTransport = { textInput: true, audioInput: true, imageInput: false, imageBufferInput: false }
const visualTransport = { ...audioTransport, imageBufferInput: true }

function assertDeepFrozen(value) {
  if (!value || typeof value !== 'object') return
  assert.equal(Object.isFrozen(value), true)
  for (const child of Object.values(value)) assertDeepFrozen(child)
}

test('preserves every built-in ID, label, family, voice, capability and order', () => {
  const expected = [
    ['dashscope', 'QWEN_AUDIO_REALTIME_MODEL', DEFAULT_DASHSCOPE_REALTIME_MODEL, [
      [DASHSCOPE_OMNI_38_FLASH_REALTIME_MODEL, 'Qwen3.8 Omni Flash Realtime', 'omni-v2', 'omni', 'Tina', 'semantic_vad', true],
      [DASHSCOPE_OMNI_FLASH_REALTIME_MODEL, 'Qwen3.5 Omni Flash Realtime', 'omni', 'omni', 'Ethan', 'semantic_vad', true],
      [DASHSCOPE_OMNI_PLUS_REALTIME_MODEL, 'Qwen3.5 Omni Plus Realtime', 'omni', 'omni', 'Ethan', 'semantic_vad', true],
      [DASHSCOPE_AUDIO_31_REALTIME_MODEL, 'Qwen Audio 3.1 Realtime Plus', 'audio', 'audio', 'longanqian_v3.1', 'smart_turn_v2', false],
      [DASHSCOPE_AUDIO_31_FLASH_REALTIME_MODEL, 'Qwen Audio 3.1 Realtime Flash', 'audio', 'audio', 'longanqian_v3.1', 'smart_turn_v2', false],
      [DASHSCOPE_AUDIO_30_REALTIME_MODEL, 'Qwen Audio 3.0 Realtime Plus', 'audio', 'audio', 'longanqian', 'smart_turn', false],
      [DASHSCOPE_AUDIO_FLASH_REALTIME_MODEL, 'Qwen Audio 3.0 Realtime Flash', 'audio', 'audio', 'longanqian', 'smart_turn', false],
    ]],
    ['stepfun', 'QWEN_AUDIO_REALTIME_MODEL', DEFAULT_STEPFUN_REALTIME_MODEL, [
      [DEFAULT_STEPFUN_REALTIME_MODEL, 'StepAudio 3 Realtime Preview', 'stepfun', 'stepaudio', null, 'server_vad', false],
    ]],
    ['gpt-live', 'QWEN_AUDIO_REALTIME_MODEL', DEFAULT_GPT_LIVE_REALTIME_MODEL, [
      [DEFAULT_GPT_LIVE_REALTIME_MODEL, 'GPT Realtime 2.1', 'gpt-live', 'gpt-live', null, 'server_vad', false],
    ]],
    ['google-live', 'QWEN_AUDIO_REALTIME_MODEL', DEFAULT_GOOGLE_LIVE_REALTIME_MODEL, [
      [DEFAULT_GOOGLE_LIVE_REALTIME_MODEL, 'Gemini 3.8 Live', 'google-live', 'google-live', null, 'server_vad', true],
    ]],
    ['doubao-seeduplex', 'QWEN_AUDIO_REALTIME_MODEL', DEFAULT_DOUBAO_SEEDUPLEX_REALTIME_MODEL, [
      [DEFAULT_DOUBAO_SEEDUPLEX_REALTIME_MODEL, 'Doubao Seeduplex 3.0 Realtime', 'doubao-seeduplex', 'doubao-seeduplex', DEFAULT_DOUBAO_SEEDUPLEX_REALTIME_VOICE, 'server_vad', false],
    ]],
  ]
  assert.equal(DEFAULT_DASHSCOPE_REALTIME_MODEL, 'qwen-audio-3.1-realtime-plus')
  assert.equal(DEFAULT_DASHSCOPE_REALTIME_VOICE, 'longanqian_v3.1')
  assert.deepEqual(Object.keys(BUILTIN_REALTIME_MODEL_CATALOGS), expected.map(([provider]) => provider))
  for (const [provider, environment, defaultModel, models] of expected) {
    const catalog = realtimeModelCatalog(provider)
    assert.equal(catalog.environment, environment)
    assert.equal(catalog.defaultModel, defaultModel)
    assert.deepEqual(catalog.profiles.map(profile => profile.id), models.map(([id]) => id))
    for (const [id, label, api, family, voice, vad, visual] of models) {
      const profile = resolveRealtimeModelProfile(id, provider)
      assert.deepEqual(profile, {
        id, label, api, family,
        sessionDefaults: { voice, turnDetection: { type: vad } },
        modelCapabilities: visual ? visualCapabilities : audioCapabilities,
        transportCapabilities: visual ? visualTransport : audioTransport,
        sessionConstraints: api === 'omni' ? { unsupportedVoices: ['Cherry'] }
          : api === 'omni-v2' ? { workspaceEndpoint: true } : {},
      })
    }
  }
  assert.equal(listDashScopeRealtimeModelProfiles(), DASHSCOPE_REALTIME_MODEL_PROFILES)
  assert.equal(resolveDashScopeRealtimeModelProfile(), resolveRealtimeModelProfile(undefined))
  assert.equal(resolveDashScopeRealtimeModelProfile('   ').id, DEFAULT_DASHSCOPE_REALTIME_MODEL)
  assert.equal(resolveRealtimeModelProfile('   ').family, 'unknown')
})

test('Audio 3.1 turn detection does not mutate the shared API preset or other models', () => {
  const profile = resolveDashScopeRealtimeModelProfile(DASHSCOPE_AUDIO_31_REALTIME_MODEL)
  const preset = REALTIME_MODEL_BUILTINS.dashscope.apis.audio
  assert.equal(profile.api, 'audio')
  assert.deepEqual(profile.sessionDefaults.turnDetection, { type: 'smart_turn_v2' })
  assert.notEqual(profile.sessionDefaults.turnDetection, preset.turnDetection)
  assert.equal(Object.isFrozen(profile.sessionDefaults.turnDetection), true)
  assert.deepEqual(preset.turnDetection, { type: 'smart_turn' })
  for (const id of [DASHSCOPE_AUDIO_30_REALTIME_MODEL, DASHSCOPE_AUDIO_FLASH_REALTIME_MODEL]) {
    assert.deepEqual(resolveDashScopeRealtimeModelProfile(id).sessionDefaults.turnDetection, { type: 'smart_turn' })
  }
})

test('3.1 Flash and Plus share the fixed Audio API parameters', () => {
  const flash = resolveDashScopeRealtimeModelProfile(DASHSCOPE_AUDIO_31_FLASH_REALTIME_MODEL)
  const plus = resolveDashScopeRealtimeModelProfile(DASHSCOPE_AUDIO_31_REALTIME_MODEL)
  assert.deepEqual(flash, { ...plus, id: DASHSCOPE_AUDIO_31_FLASH_REALTIME_MODEL, label: 'Qwen Audio 3.1 Realtime Flash' })
})

test('provider declarations and catalogs are immutable and consistent', () => {
  for (const value of [BUILTIN_REALTIME_MODEL_CATALOGS, REALTIME_MODEL_BUILTINS]) {
    assertDeepFrozen(value)
  }
  for (const [provider, definition] of Object.entries(REALTIME_MODEL_BUILTINS)) {
    const catalog = realtimeModelCatalog(provider)
    assert.ok(Object.hasOwn(definition.models, definition.defaultModel))
    for (const [id, model] of Object.entries(definition.models)) {
      assert.ok(id.trim())
      assert.ok(model.label)
      const preset = definition.apis[model.api]
      assert.ok(preset, 'every model selects an implemented provider API')
      assert.ok(model.voice === null || typeof model.voice === 'string')
      const profile = resolveRealtimeModelProfile(id, provider)
      assert.ok(catalog.profiles.includes(profile))
      assert.equal(profile.modelCapabilities, preset.defaultModelCapabilities)
      assert.equal(profile.transportCapabilities, preset.transportCapabilities)
      assert.equal(profile.sessionConstraints, preset.sessionConstraints)
      assert.equal(profile.sessionDefaults.turnDetection.type, model.turnDetection || preset.turnDetection.type)
    }
  }
  const catalog = realtimeModelCatalog()
  assert.throws(() => catalog.profiles.push({}), TypeError)
  assert.throws(() => { catalog.profiles[0].sessionDefaults.voice = 'changed' }, TypeError)
  assert.throws(() => { catalog.profiles[0].modelCapabilities.imageInput = false }, TypeError)
  assert.throws(() => { REALTIME_MODEL_BUILTINS.dashscope.models[DASHSCOPE_AUDIO_31_FLASH_REALTIME_MODEL].turnDetection = 'smart_turn' }, TypeError)
  assert.throws(() => { REALTIME_MODEL_BUILTINS.dashscope.apis.omni.sessionConstraints.unsupportedVoices.push('new') }, TypeError)
})

test('unknown models remain display-only without name-based API inference', () => {
  for (const provider of ['dashscope', 'stepfun', 'gpt-live', 'google-live', 'doubao-seeduplex', 'no-provider']) {
    const profile = resolveRealtimeModelProfile('qwen3.8-omni-future', provider)
    assert.equal(profile.id, 'qwen3.8-omni-future')
    assert.equal(profile.label, profile.id)
    assert.equal(profile.api, null)
    assert.equal(profile.family, 'unknown')
    assert.equal(profile.sessionDefaults.voice, null)
    assert.equal(profile.sessionDefaults.turnDetection, null)
    assert.equal(Object.values(profile.modelCapabilities).every(value => value === false), true)
    assert.equal(Object.values(profile.transportCapabilities).every(value => value === false), true)
    assert.deepEqual(profile.sessionConstraints, {})
    assertDeepFrozen(profile)
  }
  for (const provider of ['speech-to-speech', 'minicpm-o', '__proto__', 'constructor', 'toString']) {
    assert.equal(realtimeModelCatalog(provider), null)
  }
})

test('shared catalog only aggregates provider-owned model declarations', async () => {
  const modules = [
    ['dashscope', 'dashscopeModels'],
    ['stepfun', 'stepfunModels'],
    ['gpt-live', 'gptLiveModels'],
    ['google-live', 'googleLiveModels'],
    ['doubao-seeduplex', 'doubaoSeeduplexModels'],
  ]
  for (const [provider, exportName] of modules) {
    const owned = await import('../shared/realtime-models/' + provider + '.mjs')
    assert.equal(REALTIME_MODEL_BUILTINS[provider], owned[exportName])
  }
  const publicApi = await import('../shared/realtime-model-catalog.mjs')
  assert.equal(Object.hasOwn(publicApi, 'createRealtimeModelCatalogs'), false)
})
