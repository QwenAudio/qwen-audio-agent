import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BUILTIN_REALTIME_MODEL_CATALOGS,
  DASHSCOPE_AUDIO_30_REALTIME_MODEL,
  DASHSCOPE_AUDIO_31_REALTIME_MODEL,
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
  REALTIME_API_PROFILES,
  REALTIME_MODEL_BUILTINS,
  createRealtimeModelCatalogs,
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

function extension(models, provider = 'dashscope') {
  return { providers: { [provider]: { models } } }
}

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
  assert.deepEqual(createRealtimeModelCatalogs(), BUILTIN_REALTIME_MODEL_CATALOGS)
})

test('Audio 3.1 turn detection does not mutate the shared API preset or other models', () => {
  const profile = resolveDashScopeRealtimeModelProfile(DASHSCOPE_AUDIO_31_REALTIME_MODEL)
  assert.equal(profile.api, 'audio')
  assert.deepEqual(profile.sessionDefaults.turnDetection, { type: 'smart_turn_v2' })
  assert.notEqual(profile.sessionDefaults.turnDetection, REALTIME_API_PROFILES.dashscope.audio.turnDetection)
  assert.equal(Object.isFrozen(profile.sessionDefaults.turnDetection), true)
  assert.deepEqual(REALTIME_API_PROFILES.dashscope.audio.turnDetection, { type: 'smart_turn' })
  for (const id of [DASHSCOPE_AUDIO_30_REALTIME_MODEL, DASHSCOPE_AUDIO_FLASH_REALTIME_MODEL]) {
    assert.deepEqual(resolveDashScopeRealtimeModelProfile(id).sessionDefaults.turnDetection, { type: 'smart_turn' })
  }
})

test('registered models select reusable API presets and optional model-owned voices', () => {
  const catalogs = createRealtimeModelCatalogs(extension({
    'private/audio:2027': { api: 'audio', label: '新语音模型', voice: 'private-voice' },
    'private-visual': { api: 'omni', voice: null },
    'plain-id': { api: 'omni-v2' },
  }))
  const audio = resolveDashScopeRealtimeModelProfile('private/audio:2027', catalogs)
  assert.equal(audio.label, '新语音模型')
  assert.equal(audio.api, 'audio')
  assert.equal(audio.family, 'audio')
  assert.deepEqual(audio.sessionDefaults, { voice: 'private-voice', turnDetection: { type: 'smart_turn' } })
  assert.deepEqual(audio.modelCapabilities, audioCapabilities)
  assert.equal(audio.modelCapabilities, REALTIME_API_PROFILES.dashscope.audio.defaultModelCapabilities)
  assert.deepEqual(audio.transportCapabilities, audioTransport)
  const omni = resolveRealtimeModelProfile('private-visual', 'dashscope', catalogs)
  assert.equal(omni.sessionDefaults.voice, null)
  assert.equal(omni.family, 'omni')
  assert.deepEqual(omni.sessionConstraints, { unsupportedVoices: ['Cherry'] })
  const nested = resolveDashScopeRealtimeModelProfile('plain-id', catalogs)
  assert.equal(nested.label, 'plain-id')
  assert.equal(nested.api, 'omni-v2')
  assert.equal(nested.sessionDefaults.voice, null)
  assert.deepEqual(nested.modelCapabilities, visualCapabilities)
  assert.deepEqual(nested.transportCapabilities, visualTransport)
  assert.deepEqual(nested.sessionConstraints, { workspaceEndpoint: true })
  assert.deepEqual(listDashScopeRealtimeModelProfiles(catalogs).slice(-3).map(profile => profile.id), [
    'private/audio:2027', 'private-visual', 'plain-id',
  ])
  assert.equal(realtimeModelCatalog('dashscope', catalogs).defaultModel, DEFAULT_DASHSCOPE_REALTIME_MODEL)
})

test('other catalog providers expose only their implemented integration presets', () => {
  for (const provider of ['stepfun', 'gpt-live', 'google-live', 'doubao-seeduplex']) {
    const catalogs = createRealtimeModelCatalogs(extension({ 'my-new-model': { api: provider } }, provider))
    const added = resolveRealtimeModelProfile('my-new-model', provider, catalogs)
    const baseline = resolveRealtimeModelProfile(undefined, provider)
    assert.equal(added.api, provider)
    assert.equal(added.family, baseline.family)
    assert.deepEqual(added.modelCapabilities, baseline.modelCapabilities)
    assert.deepEqual(added.transportCapabilities, baseline.transportCapabilities)
    assert.deepEqual(added.sessionDefaults.turnDetection, baseline.sessionDefaults.turnDetection)
    assert.equal(added.sessionDefaults.voice, null)
    assert.equal(resolveDashScopeRealtimeModelProfile(added.id, catalogs).family, 'unknown')
  }
})

test('catalog snapshots and input records are isolated, immutable and deterministic', () => {
  const raw = extension({ 'my-model': { api: 'audio', voice: 'one' } })
  const first = createRealtimeModelCatalogs(raw)
  raw.providers.dashscope.models['my-model'].voice = 'two'
  raw.providers.dashscope.models['my-model'].api = 'omni'
  const second = createRealtimeModelCatalogs(raw)
  assert.equal(resolveDashScopeRealtimeModelProfile('my-model', first).sessionDefaults.voice, 'one')
  assert.equal(resolveDashScopeRealtimeModelProfile('my-model', second).sessionDefaults.voice, 'two')
  assert.equal(resolveDashScopeRealtimeModelProfile('my-model', second).api, 'omni')
  assert.equal(resolveDashScopeRealtimeModelProfile('my-model').family, 'unknown')
  assert.equal(resolveDashScopeRealtimeModelProfile('my-model', createRealtimeModelCatalogs()).family, 'unknown')
  assert.deepEqual(second, createRealtimeModelCatalogs(JSON.parse(JSON.stringify(raw))))
  for (const value of [first, second, BUILTIN_REALTIME_MODEL_CATALOGS, REALTIME_API_PROFILES, REALTIME_MODEL_BUILTINS]) {
    assertDeepFrozen(value)
  }
  assert.throws(() => first.dashscope.profiles.push({}), TypeError)
  assert.throws(() => { first.dashscope.profiles.at(-1).sessionDefaults.voice = 'changed' }, TypeError)
  assert.throws(() => { first.dashscope.profiles.at(-1).modelCapabilities.imageInput = true }, TypeError)
  assert.throws(() => { first.stepfun = second.dashscope }, TypeError)
  assert.throws(() => { REALTIME_API_PROFILES.dashscope.omni.sessionConstraints.unsupportedVoices.push('new') }, TypeError)
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

test('rejects overriding built-ins while allowing the same ID in different providers', () => {
  for (const [provider, builtin] of Object.entries(REALTIME_MODEL_BUILTINS)) {
    for (const [id, model] of Object.entries(builtin.models)) {
      assert.throws(() => createRealtimeModelCatalogs(extension({ [id]: { api: model.api } }, provider)),
        /cannot replace a built-in model/)
    }
  }
  const catalogs = createRealtimeModelCatalogs({
    providers: {
      dashscope: { models: { shared: { api: 'audio' } } },
      stepfun: { models: { shared: { api: 'stepfun' }, [DEFAULT_DASHSCOPE_REALTIME_MODEL]: { api: 'stepfun' } } },
    },
  })
  assert.equal(resolveRealtimeModelProfile('shared', 'dashscope', catalogs).api, 'audio')
  assert.equal(resolveRealtimeModelProfile('shared', 'stepfun', catalogs).api, 'stepfun')
  assert.equal(resolveRealtimeModelProfile(DEFAULT_DASHSCOPE_REALTIME_MODEL, 'stepfun', catalogs).api, 'stepfun')
})

test('rejects unknown providers, API names and unsupported configuration fields', () => {
  for (const provider of ['unknown', 'qwen', 'openai', 'speech-to-speech', 'minicpm-o']) {
    assert.throws(() => createRealtimeModelCatalogs(extension({ fresh: { api: 'audio' } }, provider)),
      /unsupported provider/)
  }
  for (const api of ['auto', 'new-api', 'stepfun', 'Audio']) {
    assert.throws(() => createRealtimeModelCatalogs(extension({ fresh: { api } })), /unsupported API/)
  }
  assert.throws(() => createRealtimeModelCatalogs(extension({ fresh: { api: 'audio' } }, 'stepfun')), /unsupported API/)
  assert.throws(() => createRealtimeModelCatalogs({ version: 1 }), /root.version.*unknown field/)
  assert.throws(() => createRealtimeModelCatalogs({ providers: { dashscope: { defaultModel: 'fresh', models: {} } } }),
    /defaultModel.*unknown field/)
  assert.throws(() => createRealtimeModelCatalogs({ providers: { dashscope: {} } }), /models.*required field/)
  assert.throws(() => createRealtimeModelCatalogs(extension({ fresh: {} })), /api.*required field/)
  for (const field of ['capabilities', 'modelCapabilities', 'transportCapabilities', 'family', 'sessionDefaults',
    'turnDetection', 'sampleRate', 'inputSampleRate', 'sessionConstraints', 'unsupportedVoices', 'id', 'protocol']) {
    assert.throws(() => createRealtimeModelCatalogs(extension({ fresh: { api: 'audio', [field]: {} } })),
      /unknown field/)
  }
})

test('rejects unsafe identifiers and invalid field values instead of coercing them', () => {
  for (const id of ['', ' ', ' before', 'after ', 'two words', 'model\n', 'model\r', 'model\t', 'a\u0000',
    'a\nb', 'a#comment', 'a=inject', 'a;command', '$(command)', '"quoted"', '<html>', '__proto__', 'constructor', 'prototype']) {
    assert.throws(() => createRealtimeModelCatalogs(extension({ [id]: { api: 'audio' } })), /model ID|unsafe configuration key/)
  }
  assert.doesNotThrow(() => createRealtimeModelCatalogs(extension({
    'tenant/models/model_v1.2:latest@preview+test': { api: 'audio' },
  })))
  for (const value of [null, undefined, true, 42, '', ' ', {}, []]) {
    assert.throws(() => createRealtimeModelCatalogs(extension({ fresh: { api: value } })), /api/)
  }
  for (const value of [null, undefined, true, 42, '', ' ', {}, []]) {
    assert.throws(() => createRealtimeModelCatalogs(extension({ fresh: { api: 'audio', label: value } })), /label/)
  }
  for (const value of [undefined, true, 42, '', ' ', {}, []]) {
    assert.throws(() => createRealtimeModelCatalogs(extension({ fresh: { api: 'audio', voice: value } })), /voice/)
  }
})

test('rejects non-records, dangerous keys and accessors at every configuration level', () => {
  for (const value of [null, [], 'string', 2, false, new Date(), new Map(), Object.create({ inherited: true })]) {
    for (const raw of [
      value, { providers: value }, { providers: { dashscope: value } },
      { providers: { dashscope: { models: value } } }, extension({ fresh: value }),
    ]) assert.throws(() => createRealtimeModelCatalogs(raw), /expected an object/)
  }
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    const dangerous = JSON.parse('{"' + key + '":{}}')
    for (const raw of [
      dangerous, { providers: dangerous }, { providers: { dashscope: dangerous } },
      { providers: { dashscope: { models: dangerous } } }, extension({ fresh: { api: 'audio', ...dangerous } }),
    ]) assert.throws(() => createRealtimeModelCatalogs(raw), /unsafe configuration key/)
  }
  let accessed = false
  const getter = Object.defineProperty({}, 'api', { enumerable: true, get() { accessed = true; return 'audio' } })
  assert.throws(() => createRealtimeModelCatalogs(extension({ fresh: getter })), /expected a JSON data field/)
  assert.equal(accessed, false)
  assert.throws(() => createRealtimeModelCatalogs({ [Symbol('providers')]: {} }), /unsafe configuration key/)
  assert.throws(() => createRealtimeModelCatalogs(Object.defineProperty({}, 'providers', { value: {} })),
    /expected a JSON data field/)
  assert.equal(Object.prototype.polluted, undefined)
})

test('accepts empty JSON records and safe null-prototype records without retaining their references', () => {
  assert.deepEqual(createRealtimeModelCatalogs({ providers: {} }), BUILTIN_REALTIME_MODEL_CATALOGS)
  assert.deepEqual(createRealtimeModelCatalogs({ providers: { dashscope: { models: {} } } }), BUILTIN_REALTIME_MODEL_CATALOGS)
  const model = Object.assign(Object.create(null), { api: 'audio' })
  const catalogs = createRealtimeModelCatalogs(extension(Object.assign(Object.create(null), { fresh: model })))
  model.api = 'omni'
  assert.equal(resolveDashScopeRealtimeModelProfile('fresh', catalogs).api, 'audio')
})
