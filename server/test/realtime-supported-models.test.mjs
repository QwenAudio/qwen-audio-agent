import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { parseEnv } from 'node:util'
import { WebSocketServer } from 'ws'
import {
  BUILTIN_REALTIME_MODEL_CATALOGS,
  DASHSCOPE_AUDIO_31_FLASH_REALTIME_MODEL,
  resolveRealtimeModelProfile,
} from '../../shared/realtime-model-catalog.mjs'
import { resolveRealtimeFrontendConfiguration } from '../../shared/realtime-provider-catalog.mjs'
import { updateRealtimeModelConfig } from '../../cli/src/config-command.mjs'
import { createSettingsStore } from '../../desktop/src/settings-store.mjs'
import { realtimeSettingsConfiguration } from '../../desktop/src/settings-config.mjs'
import { config } from '../src/core/config.mjs'
import { frontendTools } from '../src/frontend/frontend-tools.mjs'
import { dashscopeProvider } from '../src/voice/providers/dashscope.mjs'
import { stepfunProvider } from '../src/voice/providers/stepfun.mjs'
import { gptLiveProvider } from '../src/voice/providers/gpt-live.mjs'
import { googleLiveProvider } from '../src/voice/providers/google-live.mjs'
import { doubaoSeeduplexProvider } from '../src/voice/providers/doubao-seeduplex.mjs'
import { describeActiveRealtime } from '../src/voice/providers/registry.mjs'
import { RealtimeConfigurationError } from '../src/voice/realtime-errors.mjs'
import { RealtimeFrontend } from '../src/voice/realtime-provider.mjs'

const PROVIDERS = [
  { provider: dashscopeProvider, voice: session => session.voice },
  { provider: stepfunProvider, voice: session => session.voice },
  { provider: gptLiveProvider, voice: session => session.audio.output.voice },
  { provider: googleLiveProvider, voice: session => session.generationConfig.speechConfig?.voiceConfig.prebuiltVoiceConfig.voiceName },
  { provider: doubaoSeeduplexProvider, voice: session => session.audio.output.voice },
]

function configure(t, patch) {
  patch = { audioProvider: 'dashscope', realtimeModelCatalogs: BUILTIN_REALTIME_MODEL_CATALOGS, ...patch }
  const previous = Object.fromEntries(Object.keys(patch).map(key => [key, config[key]]))
  Object.assign(config, patch)
  t.after(() => Object.assign(config, previous))
}

function initialSession(provider, voice) {
  return provider.buildSession({ configured: false, sessionOptions: { voice } })
}

async function mockService(t, provider) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await once(server, 'listening')
  t.after(async () => {
    for (const socket of server.clients) socket.terminate()
    await new Promise(resolve => server.close(resolve))
  })
  const result = { endpoint: `ws://127.0.0.1:${server.address().port}/ws`, received: [], model: null }
  server.once('connection', (socket, request) => {
    result.model = new URL(request.url, 'http://localhost').searchParams.get('model')
    if (!['google-live', 'doubao-seeduplex'].includes(provider.key)) {
      socket.send(JSON.stringify({ type: 'session.created' }))
    }
    socket.on('message', raw => {
      const event = JSON.parse(raw)
      result.received.push(event)
      if (event.setup) socket.send(JSON.stringify({ setupComplete: {} }))
      else if (event.type === 'session.create') socket.send(JSON.stringify({ type: 'session.created' }))
      else if (event.type === 'session.update') socket.send(JSON.stringify({ type: 'session.updated' }))
    })
  })
  return result
}

for (const spec of PROVIDERS) {
  const { provider } = spec
  const model = BUILTIN_REALTIME_MODEL_CATALOGS[provider.key].defaultModel
  test(`${provider.key} uses supported capabilities and voice defaults and rejects unknown models before connecting`, async t => {
    configure(t, {
      audioProvider: provider.key, realtimeModel: model, realtimeVoice: '',
      realtimeCredential: 'test-only-key', realtimeEndpoint: 'wss://realtime.invalid/ws',
    })
    const profile = resolveRealtimeModelProfile(model, provider.key)
    assert.equal(provider.modelProfile(), profile)
    assert.equal(profile.modelCapabilities.functionCalling, true)
    assert.equal(provider.modelCatalog().find(item => item.id === model), profile)
    const description = describeActiveRealtime(provider.key)
    assert.equal(description.modelProfile, profile)
    assert.equal(description.modelCapabilities, profile.modelCapabilities)
    assert.equal(description.transportCapabilities, profile.transportCapabilities)
    assert.equal(description.voice, profile.sessionDefaults.voice)
    assert.ok(description.providers.find(item => item.key === provider.key).realtimeModelIds.includes(model))
    assert.equal(spec.voice(initialSession(provider)), profile.sessionDefaults.voice || undefined)
    assert.doesNotMatch(JSON.stringify(initialSession(provider)), /"voice"\s*:\s*null/)
    config.realtimeVoice = ' config-voice '
    assert.equal(provider.voice(), 'config-voice')
    assert.equal(spec.voice(initialSession(provider)), 'config-voice')
    assert.equal(spec.voice(initialSession(provider, ' session-voice ')), 'session-voice')
    assert.equal(spec.voice(initialSession(provider, '  ')), 'config-voice')

    config.realtimeModel = 'unsupported/model:v2'
    let urlCalls = 0
    const frontend = new RealtimeFrontend({ provider: {
      ...provider,
      url: () => { urlCalls += 1; throw new Error('must not reach transport') },
    } })
    assert.equal(frontend.modelProfile.family, 'unknown')
    await assert.rejects(frontend.connect(), error => {
      assert.ok(error instanceof RealtimeConfigurationError)
      assert.match(error.message, /unsupported\/model:v2/)
      assert.doesNotMatch(error.message, /frontend-models\.json/)
      return true
    })
    assert.equal(urlCalls, 0)
    assert.equal(frontend.ws, null)
  })

  test(`${provider.key} sends its supported model and explicit voice through its existing wire API`, async t => {
    const service = await mockService(t, provider)
    configure(t, {
      audioProvider: provider.key, realtimeModel: model, realtimeVoice: 'mock-voice',
      realtimeCredential: 'test-only-key', realtimeEndpoint: service.endpoint,
    })
    const frontend = new RealtimeFrontend({ provider: { ...provider, connectTimeoutMs: 1000 } })
    t.after(() => frontend.close())
    await frontend.connect()
    assert.equal(frontend.ready, true)
    const event = service.received[0]
    const session = event.setup || event.session
    if (provider.key === 'google-live') {
      assert.equal(session.model, `models/${model}`)
      assert.deepEqual(session.generationConfig.responseModalities, ['AUDIO'])
    } else if (provider.key === 'doubao-seeduplex') {
      assert.equal(event.type, 'session.create')
      assert.equal(session.model, model)
    } else {
      assert.equal(service.model, model)
      assert.equal(event.type, 'session.update')
    }
    assert.equal(spec.voice(session), 'mock-voice')
    frontend.close()
  })
}

for (const model of [DASHSCOPE_AUDIO_31_FLASH_REALTIME_MODEL, 'qwen-audio-3.1-realtime-plus']) {
  test(`${model} keeps smart_turn_v2 through CLI, desktop and Gateway into the mock session`, async t => {
    const directory = mkdtempSync(join(tmpdir(), 'qwaudio-supported-model-session-'))
    t.after(() => rmSync(directory, { recursive: true, force: true }))
    const service = await mockService(t, dashscopeProvider)
    const configPath = join(directory, 'config.env')
    writeFileSync(configPath, [
      'QWEN_AUDIO_REALTIME_PROVIDER=dashscope',
      'QWEN_AUDIO_REALTIME_API_KEY=test-only-key',
      `QWEN_AUDIO_REALTIME_URL=${service.endpoint}`,
      'QWEN_AUDIO_REALTIME_VOICE=', '',
    ].join('\n'))
    // A stale registration file must not change the packaged session defaults.
    writeFileSync(join(directory, 'frontend-models.json'), JSON.stringify({ providers: {
      dashscope: { models: { [model]: { voice: 'untrusted-voice', turnDetection: 'smart_turn' } } },
    } }))
    const selected = updateRealtimeModelConfig(configPath, model)
    const store = createSettingsStore({ configDir: directory, clientDir: join(directory, 'client'), env: {} })
    assert.equal(store.load().realtimeModel, model)
    store.save({ realtimeModel: model, realtimeVoice: '' })
    const desktop = realtimeSettingsConfiguration(store.load(), store.modelCatalogs())
    const runtime = resolveRealtimeFrontendConfiguration({
      ...parseEnv(readFileSync(configPath, 'utf8')), QWAUDIO_CONFIG_DIR: directory,
    })
    assert.deepEqual(desktop.active, runtime.active)
    assert.equal(runtime.active.modelProfile, selected.profile)
    configure(t, {
      realtimeModel: runtime.active.model, realtimeVoice: runtime.active.voice,
      realtimeCredential: runtime.credential, realtimeEndpoint: runtime.active.endpoint,
    })
    const agentContext = { frontend: { tools: [{
      type: 'function', function: {
        name: 'catalog_probe', description: 'Supported model integration test',
        parameters: { type: 'object', properties: {} },
      },
    }] } }
    const frontend = new RealtimeFrontend({
      provider: { ...dashscopeProvider, connectTimeoutMs: 1000 }, agentContext,
    })
    t.after(() => frontend.close())
    await frontend.connect()
    assert.equal(frontend.ready, true)
    assert.equal(service.model, model)
    assert.equal(service.received[0].type, 'session.update')
    const { session } = service.received[0]
    assert.deepEqual(session.turn_detection, { type: 'smart_turn_v2' })
    assert.equal(session.voice, 'longanqian_v3.1')
    assert.deepEqual(session.modalities, ['text', 'audio'])
    assert.equal(session.input_audio_format, 'pcm')
    assert.equal(session.output_audio_format, 'pcm')
    const sharedTools = frontendTools(agentContext)
    const sharedTime = sharedTools.find(tool => tool.function.name === 'get_current_time')
    assert.equal(sharedTime.function.parameters.additionalProperties, false)
    assert.equal(sharedTime.function.parameters.required, undefined)
    // Both models receive the standard shared schema without provider rewrites.
    assert.deepEqual(session.tools, sharedTools)
    const refreshed = dashscopeProvider.buildSession({ configured: true, agentContext })
    assert.deepEqual(refreshed.tools, sharedTools)
    assert.ok(session.tools.some(tool => tool.function.name === 'catalog_probe'))
    assert.equal(frontend.modelCapabilities.functionCalling, true)
    frontend.close()
  })
}

test('every supported DashScope model retains its declared API shape, voice and turn detector', t => {
  configure(t, { realtimeVoice: '', realtimeEndpoint: 'wss://workspace.example/ws' })
  for (const profile of BUILTIN_REALTIME_MODEL_CATALOGS.dashscope.profiles) {
    config.realtimeModel = profile.id
    const session = initialSession(dashscopeProvider)
    assert.deepEqual(session.turn_detection, profile.sessionDefaults.turnDetection)
    assert.deepEqual(session.modalities, ['text', 'audio'])
    if (profile.api === 'audio') {
      const expected = profile.id.startsWith('qwen-audio-3.1-') ? 'smart_turn_v2' : 'smart_turn'
      assert.equal(session.turn_detection.type, expected)
    } else assert.equal(session.turn_detection.type, 'semantic_vad')
    if (profile.api === 'omni-v2') {
      assert.deepEqual(session.audio.input.format, { type: 'pcm', sample_rate: 16000 })
      assert.deepEqual(session.audio.output.format, { type: 'pcm', sample_rate: 24000 })
      assert.equal(session.audio.output.voice, profile.sessionDefaults.voice)
      assert.equal(Object.hasOwn(session, 'voice'), false)
      assert.equal(Object.hasOwn(session, 'input_audio_format'), false)
    } else {
      assert.equal(session.voice, profile.sessionDefaults.voice)
      assert.equal(session.input_audio_format, 'pcm')
      assert.equal(session.output_audio_format, 'pcm')
      assert.equal(Object.hasOwn(session, 'audio'), false)
    }
    const refreshed = dashscopeProvider.buildSession({ configured: true })
    for (const key of ['voice', 'audio', 'turn_detection']) assert.equal(Object.hasOwn(refreshed, key), false)
  }
})

test('supported Omni API constraints remain distinct from Audio settings', t => {
  configure(t, {
    realtimeModel: 'qwen3.5-omni-plus-realtime', realtimeVoice: 'Cherry',
    realtimeEndpoint: 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime',
  })
  assert.throws(() => dashscopeProvider.validateSessionOptions(), /音色 Cherry/)
  assert.doesNotThrow(() => dashscopeProvider.validateSessionOptions({ sessionOptions: { voice: 'custom-voice' } }))
  config.realtimeModel = 'qwen3.8-omni-flash-realtime'
  assert.throws(() => dashscopeProvider.validateSessionOptions(), /业务空间/)
  config.realtimeEndpoint = 'wss://workspace.example/ws'
  assert.doesNotThrow(() => dashscopeProvider.validateSessionOptions())
  assert.equal(initialSession(dashscopeProvider).audio.output.voice, 'Cherry')
  config.realtimeModel = DASHSCOPE_AUDIO_31_FLASH_REALTIME_MODEL
  config.realtimeEndpoint = 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime'
  assert.doesNotThrow(() => dashscopeProvider.validateSessionOptions())
  assert.equal(initialSession(dashscopeProvider).voice, 'Cherry')
})
