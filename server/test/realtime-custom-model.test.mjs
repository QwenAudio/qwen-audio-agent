import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import { WebSocketServer } from 'ws'
import { createRealtimeModelCatalogs } from '../../shared/realtime-model-catalog.mjs'
import { config } from '../src/core/config.mjs'
import { dashscopeProvider } from '../src/voice/providers/dashscope.mjs'
import { stepfunProvider } from '../src/voice/providers/stepfun.mjs'
import { gptLiveProvider } from '../src/voice/providers/gpt-live.mjs'
import { googleLiveProvider } from '../src/voice/providers/google-live.mjs'
import { doubaoSeeduplexProvider } from '../src/voice/providers/doubao-seeduplex.mjs'
import { describeActiveRealtime } from '../src/voice/providers/registry.mjs'
import { RealtimeConfigurationError } from '../src/voice/realtime-errors.mjs'
import { RealtimeFrontend } from '../src/voice/realtime-provider.mjs'

const PROVIDERS = [
  {
    provider: dashscopeProvider, api: 'audio',
    voice: session => session.voice,
  },
  {
    provider: stepfunProvider, api: 'stepfun',
    voice: session => session.voice,
  },
  {
    provider: gptLiveProvider, api: 'gpt-live',
    voice: session => session.audio.output.voice,
  },
  {
    provider: googleLiveProvider, api: 'google-live',
    voice: session => session.generationConfig.speechConfig?.voiceConfig.prebuiltVoiceConfig.voiceName,
  },
  {
    provider: doubaoSeeduplexProvider, api: 'doubao-seeduplex',
    voice: session => session.audio.output.voice,
  },
]

function configure(t, patch) {
  patch = { audioProvider: 'dashscope', ...patch }
  const previous = Object.fromEntries(Object.keys(patch).map(key => [key, config[key]]))
  Object.assign(config, patch)
  t.after(() => Object.assign(config, previous))
}

function catalogs(provider, api, voice) {
  return createRealtimeModelCatalogs({ providers: {
    [provider.key]: { models: {
      'private/realtime:v1': { api, label: 'Private realtime', voice },
    } },
  } })
}

function initialSession(provider, voice) {
  return provider.buildSession({ configured: false, sessionOptions: { voice } })
}

for (const spec of PROVIDERS) {
  const { provider } = spec
  test(`${provider.key} uses registered capabilities and voice defaults without changing its wire API`, async t => {
    configure(t, {
      audioProvider: provider.key,
      realtimeModelCatalogs: catalogs(provider, spec.api, 'registered-voice'),
      realtimeModel: 'private/realtime:v1',
      realtimeVoice: '',
      realtimeCredential: 'test-only-key',
      realtimeEndpoint: 'wss://realtime.invalid/ws',
    })
    const profile = provider.modelProfile()
    assert.equal(profile.id, 'private/realtime:v1')
    assert.equal(profile.api, spec.api)
    assert.equal(profile.modelCapabilities.functionCalling, true)
    assert.equal(provider.modelCatalog().at(-1), profile)
    const description = describeActiveRealtime(provider.key)
    assert.equal(description.modelProfile, profile)
    assert.equal(description.modelCapabilities, profile.modelCapabilities)
    assert.equal(description.transportCapabilities, profile.transportCapabilities)
    assert.equal(description.modelCatalog.at(-1), profile)
    assert.equal(description.voice, 'registered-voice')
    assert.ok(description.providers.find(item => item.key === provider.key)
      .realtimeModelIds.includes(profile.id))
    assert.equal(spec.voice(initialSession(provider)), 'registered-voice')
    config.realtimeVoice = ' config-voice '
    assert.equal(provider.voice(), 'config-voice')
    assert.equal(spec.voice(initialSession(provider)), 'config-voice')
    assert.equal(spec.voice(initialSession(provider, ' session-voice ')), 'session-voice')
    assert.equal(spec.voice(initialSession(provider, '  ')), 'config-voice')

    // Null and omitted registrations both mean upstream default, never JSON null.
    config.realtimeVoice = ''
    for (const voice of [null, undefined]) {
      config.realtimeModelCatalogs = voice === undefined
        ? createRealtimeModelCatalogs({ providers: {
          [provider.key]: { models: { 'private/realtime:v1': { api: spec.api } } },
        } })
        : catalogs(provider, spec.api, voice)
      assert.equal(provider.voice(), null)
      const session = initialSession(provider)
      assert.equal(spec.voice(session), undefined)
      assert.doesNotMatch(JSON.stringify(session), /"voice"\s*:\s*null/)
      assert.equal(spec.voice(initialSession(provider, 'session-voice')), 'session-voice')
    }

    // An unregistered saved ID remains displayable but cannot open a socket.
    config.realtimeModel = 'private/unregistered:v2'
    let urlCalls = 0
    const frontend = new RealtimeFrontend({ provider: {
      ...provider,
      url: () => { urlCalls += 1; throw new Error('must not reach transport') },
    } })
    assert.equal(frontend.modelProfile.family, 'unknown')
    await assert.rejects(frontend.connect(), error => {
      assert.ok(error instanceof RealtimeConfigurationError)
      assert.match(error.message, /private\/unregistered:v2.*frontend-models\.json/)
      return true
    })
    assert.equal(urlCalls, 0)
    assert.equal(frontend.ws, null)
  })

  test(`${provider.key} sends a registered model ID and voice to a local mock service`, async t => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await once(server, 'listening')
    t.after(async () => {
      for (const socket of server.clients) socket.terminate()
      await new Promise(resolve => server.close(resolve))
    })
    configure(t, {
      audioProvider: provider.key,
      realtimeModelCatalogs: catalogs(provider, spec.api, 'registered-voice'),
      realtimeModel: 'private/realtime:v1',
      realtimeVoice: '',
      realtimeCredential: 'test-only-key',
      realtimeEndpoint: `ws://127.0.0.1:${server.address().port}/ws`,
    })
    const received = []
    let connectedModel
    server.once('connection', (socket, request) => {
      connectedModel = new URL(request.url, 'http://localhost').searchParams.get('model')
      if (!['google-live', 'doubao-seeduplex'].includes(provider.key)) {
        socket.send(JSON.stringify({ type: 'session.created' }))
      }
      socket.on('message', raw => {
        const event = JSON.parse(raw)
        received.push(event)
        if (event.setup) socket.send(JSON.stringify({ setupComplete: {} }))
        else if (event.type === 'session.create') socket.send(JSON.stringify({ type: 'session.created' }))
        else if (event.type === 'session.update') socket.send(JSON.stringify({ type: 'session.updated' }))
      })
    })
    const frontend = new RealtimeFrontend({ provider: { ...provider, connectTimeoutMs: 1000 } })
    t.after(() => frontend.close())
    await frontend.connect()
    assert.equal(frontend.ready, true)
    const event = received[0]
    const session = event.setup || event.session
    if (provider.key === 'google-live') {
      assert.equal(session.model, 'models/private/realtime:v1')
      assert.deepEqual(session.generationConfig.responseModalities, ['AUDIO'])
    } else if (provider.key === 'doubao-seeduplex') {
      assert.equal(event.type, 'session.create')
      assert.equal(session.model, 'private/realtime:v1')
    } else {
      assert.equal(connectedModel, 'private/realtime:v1')
      assert.equal(event.type, 'session.update')
    }
    assert.equal(spec.voice(session), 'registered-voice')
    frontend.close()
  })
}

test('DashScope registered API, not model spelling, selects flat Audio, flat Omni or nested Omni v2', t => {
  const models = {
    'neutral-first': { api: 'audio', voice: 'audio-voice' },
    'neutral-second': { api: 'omni', voice: 'omni-voice' },
    'neutral-third': { api: 'omni-v2', voice: 'nested-voice' },
    'neutral-fourth': { api: 'omni-v2', voice: null },
  }
  configure(t, {
    realtimeModelCatalogs: createRealtimeModelCatalogs({ providers: { dashscope: { models } } }),
    realtimeModel: 'neutral-first', realtimeVoice: '',
    realtimeEndpoint: 'wss://workspace.example/ws',
  })
  for (const [model, registration] of Object.entries(models)) {
    config.realtimeModel = model
    const { api, voice } = registration
    const profile = dashscopeProvider.modelProfile()
    assert.equal(profile.api, api)
    assert.equal(profile.modelCapabilities.videoInput, api !== 'audio')
    assert.equal(profile.transportCapabilities.imageBufferInput, api !== 'audio')
    assert.equal(dashscopeProvider.capabilities.conversationItemIdEcho, api === 'audio')
    const session = initialSession(dashscopeProvider)
    assert.deepEqual(session.turn_detection, { type: api === 'audio' ? 'smart_turn' : 'semantic_vad' })
    if (api === 'omni-v2') {
      assert.deepEqual(session.audio.input.format, { type: 'pcm', sample_rate: 16000 })
      assert.deepEqual(session.audio.output.format, { type: 'pcm', sample_rate: 24000 })
      assert.equal(session.audio.output.voice, voice || undefined)
      assert.equal(Object.hasOwn(session, 'voice'), false)
      assert.equal(Object.hasOwn(session, 'input_audio_format'), false)
    } else {
      assert.equal(session.voice, voice)
      assert.equal(session.input_audio_format, 'pcm')
      assert.equal(session.output_audio_format, 'pcm')
      assert.equal(Object.hasOwn(session, 'audio'), false)
    }
    const refreshed = dashscopeProvider.buildSession({ configured: true })
    assert.equal(Object.hasOwn(refreshed, 'voice'), false)
    assert.equal(Object.hasOwn(refreshed, 'audio'), false)
    assert.equal(Object.hasOwn(refreshed, 'turn_detection'), false)
  }
})

test('DashScope applies API constraints to unfamiliar IDs and not to unrelated APIs', t => {
  configure(t, {
    realtimeModelCatalogs: createRealtimeModelCatalogs({ providers: { dashscope: { models: {
      'custom-flat': { api: 'omni', voice: null },
      'custom-nested': { api: 'omni-v2', voice: null },
      'qwen3.8-omni-private-audio': { api: 'audio', voice: null },
    } } } }),
    realtimeModel: 'custom-flat', realtimeVoice: 'Cherry',
    realtimeEndpoint: 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime',
  })
  assert.throws(() => dashscopeProvider.validateSessionOptions(), /音色 Cherry.*清空音色/)
  assert.doesNotThrow(() => dashscopeProvider.validateSessionOptions({ sessionOptions: { voice: 'custom-voice' } }))
  config.realtimeModel = 'custom-nested'
  assert.throws(() => dashscopeProvider.validateSessionOptions(), /custom-nested.*业务空间/)
  config.realtimeEndpoint = 'wss://workspace.example/ws'
  assert.doesNotThrow(() => dashscopeProvider.validateSessionOptions())
  assert.equal(initialSession(dashscopeProvider).audio.output.voice, 'Cherry')
  config.realtimeModel = 'qwen3.8-omni-private-audio'
  config.realtimeEndpoint = 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime'
  assert.doesNotThrow(() => dashscopeProvider.validateSessionOptions())
  assert.equal(initialSession(dashscopeProvider).voice, 'Cherry')
})
