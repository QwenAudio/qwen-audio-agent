import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DASHSCOPE_REALTIME_MODEL_PROFILES,
  DEFAULT_DASHSCOPE_REALTIME_MODEL,
  resolveDashScopeRealtimeVoiceOverride,
  listDashScopeRealtimeModelProfiles,
  resolveDashScopeRealtimeModelProfile,
  resolveRealtimeFrontendConfiguration,
  resolveRealtimeModelProfile,
} from '../shared/realtime-provider-catalog.mjs'

const OMNI_FLASH_ID = 'qwen3.5-omni-flash-realtime'
const OMNI_PLUS_ID = 'qwen3.5-omni-plus-realtime'
const AUDIO_PLUS_ID = 'qwen-audio-3.0-realtime-plus'
const AUDIO_FLASH_ID = 'qwen-audio-3.0-realtime-flash'

test('resolves one provider-neutral active realtime profile', () => {
  const env = {
    QWEN_AUDIO_REALTIME_PROVIDER: 'stepfun',
    STEPFUN_API_KEY: 'step-test',
    STEPFUN_REALTIME_URL: 'wss://api.stepfun.com/v1/realtime',
    STEPFUN_REALTIME_MODEL: 'stepaudio-3-realtime-preview',
    STEPFUN_REALTIME_VOICE: 'step-voice',
  }
  const configuration = resolveRealtimeFrontendConfiguration(env)
  assert.equal(configuration.active.provider, 'stepfun')
  assert.equal(configuration.active.model, 'stepaudio-3-realtime-preview')
  assert.equal(configuration.active.voice, 'step-voice')
  assert.equal(configuration.active.endpoint, 'wss://api.stepfun.com/v1/realtime')
  assert.equal(configuration.active.credentialConfigured, true)
  assert.equal(Object.hasOwn(configuration.active, 'credential'), false)
  assert.equal(Object.isFrozen(configuration.active), true)
  assert.equal(configuration.credential, 'step-test')
  assert.notEqual(configuration.active.signature, resolveRealtimeFrontendConfiguration({
    ...env, STEPFUN_REALTIME_URL: 'wss://proxy.example/v1/realtime',
  }).active.signature)
  assert.equal(resolveRealtimeModelProfile(configuration.active.model, 'stepfun').modelCapabilities.functionCalling, true)
  assert.equal(resolveRealtimeModelProfile('stepaudio-future', 'stepfun').family, 'unknown')
})

test('GPT-Live and Google Live resolve independent credentials and models', () => {
  const gpt = resolveRealtimeFrontendConfiguration({
    QWEN_AUDIO_REALTIME_PROVIDER: 'openai',
    OPENAI_API_KEY: 'openai-test',
    GPT_LIVE_REALTIME_URL: 'wss://api.openai.com/v1/realtime?region=test',
  })
  assert.equal(gpt.active.provider, 'gpt-live')
  assert.equal(gpt.active.configured, true)
  assert.equal(gpt.active.model, 'gpt-realtime-2.1')
  assert.equal(gpt.active.endpoint, 'wss://api.openai.com/v1/realtime?region=test')
  assert.equal(resolveRealtimeModelProfile(gpt.active.model, 'gpt-live').family, 'gpt-live')

  const google = resolveRealtimeFrontendConfiguration({
    QWEN_AUDIO_REALTIME_PROVIDER: 'gemini-live',
    GEMINI_API_KEY: 'google-test',
    GEMINI_LIVE_REALTIME_MODEL: 'gemini-3.8-live',
  })
  assert.equal(google.active.provider, 'google-live')
  assert.equal(google.active.configured, true)
  assert.equal(google.credential, 'google-test')
  assert.equal(google.active.model, 'gemini-3.8-live')
  assert.equal(resolveRealtimeModelProfile(google.active.model, 'google-live').family, 'google-live')
})

const omniModelCapabilities = {
  textInput: true,
  audioInput: true,
  imageInput: true,
  videoInput: true,
  textOutput: true,
  audioOutput: true,
  functionCalling: true,
}

const omniTransportCapabilities = {
  textInput: true,
  audioInput: true,
  imageInput: false,
  imageBufferInput: true,
}

const omniSessionDefaults = {
  voice: 'Ethan',
  turnDetection: { type: 'semantic_vad' },
}

const legacySessionDefaults = {
  voice: 'longanqian',
  turnDetection: { type: 'smart_turn' },
}

test('lists the exact DashScope realtime model catalog in product order', () => {
  assert.deepEqual(listDashScopeRealtimeModelProfiles(), [
    {
      id: OMNI_FLASH_ID,
      label: 'Qwen3.5 Omni Flash Realtime',
      family: 'omni',
      sessionDefaults: omniSessionDefaults,
      modelCapabilities: omniModelCapabilities,
      transportCapabilities: omniTransportCapabilities,
    },
    {
      id: OMNI_PLUS_ID,
      label: 'Qwen3.5 Omni Plus Realtime',
      family: 'omni',
      sessionDefaults: omniSessionDefaults,
      modelCapabilities: omniModelCapabilities,
      transportCapabilities: omniTransportCapabilities,
    },
    {
      id: AUDIO_PLUS_ID,
      label: 'Qwen Audio 3.0 Realtime Plus',
      family: 'audio',
      sessionDefaults: legacySessionDefaults,
      modelCapabilities: {
        textInput: true,
        audioInput: true,
        imageInput: false,
        videoInput: false,
        textOutput: true,
        audioOutput: true,
        functionCalling: true,
      },
      transportCapabilities: {
        textInput: true,
        audioInput: true,
        imageInput: false,
        imageBufferInput: false,
      },
    },
    {
      id: AUDIO_FLASH_ID,
      label: 'Qwen Audio 3.0 Realtime Flash',
      family: 'audio',
      sessionDefaults: legacySessionDefaults,
      modelCapabilities: {
        textInput: true,
        audioInput: true,
        imageInput: false,
        videoInput: false,
        textOutput: true,
        audioOutput: true,
        functionCalling: true,
      },
      transportCapabilities: {
        textInput: true,
        audioInput: true,
        imageInput: false,
        imageBufferInput: false,
      },
    },
  ])
})

test('resolves Omni and Audio Flash and Plus profiles by exact model id', () => {
  for (const modelId of [
    OMNI_FLASH_ID,
    OMNI_PLUS_ID,
    AUDIO_PLUS_ID,
    AUDIO_FLASH_ID,
  ]) {
    assert.equal(resolveDashScopeRealtimeModelProfile(modelId).id, modelId)
  }
  assert.equal(
    resolveDashScopeRealtimeModelProfile(OMNI_PLUS_ID).modelCapabilities.videoInput,
    true,
  )
  assert.equal(
    resolveDashScopeRealtimeModelProfile(OMNI_PLUS_ID)
      .transportCapabilities.imageBufferInput,
    true,
  )
})

test('keeps the legacy model as the default', () => {
  assert.equal(DEFAULT_DASHSCOPE_REALTIME_MODEL, AUDIO_PLUS_ID)
  assert.equal(
    resolveDashScopeRealtimeModelProfile().id,
    DEFAULT_DASHSCOPE_REALTIME_MODEL,
  )
})

test('selects only the explicit voice override for the active model family', () => {
  const env = {
    QWEN_AUDIO_REALTIME_VOICE: 'custom-voice',
    QWEN_OMNI_REALTIME_VOICE: 'custom-voice',
  }

  assert.equal(resolveDashScopeRealtimeVoiceOverride(AUDIO_PLUS_ID, env), 'custom-voice')
  assert.equal(resolveDashScopeRealtimeVoiceOverride(AUDIO_FLASH_ID, env), 'custom-voice')
  assert.equal(resolveDashScopeRealtimeVoiceOverride(OMNI_PLUS_ID, env), 'custom-voice')
  assert.equal(resolveDashScopeRealtimeVoiceOverride(OMNI_FLASH_ID, env), 'custom-voice')
  assert.equal(resolveDashScopeRealtimeVoiceOverride(AUDIO_PLUS_ID, {}), '')
  assert.equal(resolveDashScopeRealtimeVoiceOverride(OMNI_PLUS_ID, {}), '')
  assert.equal(resolveDashScopeRealtimeVoiceOverride('future-model', env), '')
})

test('exposes immutable catalog profiles and nested capabilities', () => {
  assert.equal(Object.isFrozen(DASHSCOPE_REALTIME_MODEL_PROFILES), true)
  for (const profile of DASHSCOPE_REALTIME_MODEL_PROFILES) {
    assert.equal(Object.isFrozen(profile), true)
    assert.equal(Object.isFrozen(profile.sessionDefaults), true)
    assert.equal(Object.isFrozen(profile.sessionDefaults.turnDetection), true)
    assert.equal(Object.isFrozen(profile.modelCapabilities), true)
    assert.equal(Object.isFrozen(profile.transportCapabilities), true)
  }
  assert.throws(() => {
    listDashScopeRealtimeModelProfiles()[0].modelCapabilities.videoInput = false
  }, TypeError)
})

test('fails closed for unknown model ids without name-based capability inference', () => {
  const profile = resolveDashScopeRealtimeModelProfile(
    'qwen3.5-omni-plus-realtime-future',
  )

  assert.equal(profile.id, 'qwen3.5-omni-plus-realtime-future')
  assert.equal(profile.family, 'unknown')
  assert.deepEqual(profile.sessionDefaults, {
    voice: null,
    turnDetection: null,
  })
  assert.deepEqual(profile.modelCapabilities, {
    textInput: false,
    audioInput: false,
    imageInput: false,
    videoInput: false,
    textOutput: false,
    audioOutput: false,
    functionCalling: false,
  })
  assert.deepEqual(profile.transportCapabilities, {
    textInput: false,
    audioInput: false,
    imageInput: false,
    imageBufferInput: false,
  })
  assert.equal(Object.isFrozen(profile.modelCapabilities), true)
  assert.equal(Object.isFrozen(profile.transportCapabilities), true)
  assert.notEqual(
    profile.modelCapabilities,
    resolveDashScopeRealtimeModelProfile(AUDIO_PLUS_ID).modelCapabilities,
  )
  assert.notEqual(
    profile.transportCapabilities,
    resolveDashScopeRealtimeModelProfile(AUDIO_PLUS_ID).transportCapabilities,
  )
})
