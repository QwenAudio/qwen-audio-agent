import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  BUILTIN_REALTIME_MODEL_CATALOGS,
  DASHSCOPE_AUDIO_31_FLASH_REALTIME_MODEL,
  resolveRealtimeModelProfile,
} from '../shared/realtime-model-catalog.mjs'
import { assertRealtimeFrontendModel, resolveRealtimeFrontendConfiguration } from '../shared/realtime-provider-catalog.mjs'
import { gatewaySetupStatus } from '../shared/gateway/setup.mjs'
import { createSettingsStore } from '../desktop/src/settings-store.mjs'
import { realtimeSettingsChanged, realtimeSettingsConfiguration } from '../desktop/src/settings-config.mjs'
import { resolveConfigModel, showConfig, updateRealtimeModelConfig } from '../cli/src/config-command.mjs'

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'qwaudio-supported-models-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return { directory, env: { QWAUDIO_CONFIG_DIR: directory } }
}

test('reading fixed model defaults never creates a catalog or configuration directory', t => {
  const { directory } = fixture(t)
  const absent = join(directory, 'absent')
  const configuration = resolveRealtimeFrontendConfiguration({ QWAUDIO_CONFIG_DIR: absent })
  assert.equal(configuration.modelCatalogs, BUILTIN_REALTIME_MODEL_CATALOGS)
  assert.equal(configuration.active.model, 'qwen-audio-3.1-realtime-plus')
  assert.equal(existsSync(absent), false)
})

test('CLI, desktop and runtime share the Audio 3.1 default without rewriting explicit choices', t => {
  const { directory, env } = fixture(t)
  const configPath = join(directory, 'config.env')
  const store = createSettingsStore({ configDir: directory, clientDir: join(directory, 'client'), env: {} })
  assert.equal(resolveConfigModel(), 'qwen-audio-3.1-realtime-plus')
  assert.match(showConfig({ configPath }), /Realtime 模型：qwen-audio-3\.1-realtime-plus/)
  assert.equal(store.load().realtimeModel, 'qwen-audio-3.1-realtime-plus')
  const configuration = resolveRealtimeFrontendConfiguration(env)
  assert.equal(configuration.active.modelProfile.sessionDefaults.voice, 'longanqian_v3.1')
  assert.deepEqual(configuration.active.modelProfile.sessionDefaults.turnDetection, { type: 'smart_turn_v2' })
  assert.equal(configuration.active.voice, '', 'a model default is not an explicit voice override')
  assert.equal(existsSync(configPath), false)
  assert.equal(existsSync(join(directory, 'frontend-models.json')), false)

  const content = 'QWEN_AUDIO_REALTIME_MODEL=qwen-audio-3.0-realtime-plus\nQWEN_AUDIO_REALTIME_VOICE=custom-voice\n'
  writeFileSync(configPath, content)
  assert.equal(resolveConfigModel({}, content), 'qwen-audio-3.0-realtime-plus')
  assert.equal(store.load().realtimeModel, 'qwen-audio-3.0-realtime-plus')
  assert.equal(store.load().realtimeVoice, 'custom-voice')
  assert.equal(readFileSync(configPath, 'utf8'), content)
})

test('CLI lists and selects built-in Audio 3.1 Flash and rejects unsupported IDs without writing', t => {
  const { directory } = fixture(t)
  const configPath = join(directory, 'config.env')
  assert.match(showConfig({ configPath }), /qwen-audio-3\.1-realtime-flash（Qwen Audio 3\.1 Realtime Flash）/)
  const selected = updateRealtimeModelConfig(configPath, DASHSCOPE_AUDIO_31_FLASH_REALTIME_MODEL)
  assert.equal(selected.profile, resolveRealtimeModelProfile(DASHSCOPE_AUDIO_31_FLASH_REALTIME_MODEL))
  assert.deepEqual(selected.profile.sessionDefaults, {
    voice: 'longanqian_v3.1', turnDetection: { type: 'smart_turn_v2' },
  })
  const content = readFileSync(configPath, 'utf8')
  assert.match(content, /QWEN_AUDIO_REALTIME_MODEL=qwen-audio-3.1-realtime-flash/)
  assert.throws(() => updateRealtimeModelConfig(configPath, 'unsupported-model'), error => {
    assert.match(error.message, /不支持的 Realtime 模型/)
    assert.doesNotMatch(error.message, /frontend-models\.json/)
    return true
  })
  assert.equal(readFileSync(configPath, 'utf8'), content)
})

test('desktop saves built-in Flash and resolves the same fixed profile as the runtime', t => {
  const { directory, env } = fixture(t)
  const store = createSettingsStore({ configDir: directory, clientDir: join(directory, 'client'), env: {} })
  store.save({ realtimeModel: DASHSCOPE_AUDIO_31_FLASH_REALTIME_MODEL, realtimeApiKey: 'test-only-key' })
  assert.equal(store.ready(), true)
  assert.equal(store.modelCatalogs(), BUILTIN_REALTIME_MODEL_CATALOGS)
  const desktop = realtimeSettingsConfiguration(store.load(), store.modelCatalogs())
  const runtime = resolveRealtimeFrontendConfiguration({
    ...env, QWEN_AUDIO_REALTIME_MODEL: DASHSCOPE_AUDIO_31_FLASH_REALTIME_MODEL,
    QWEN_AUDIO_REALTIME_API_KEY: 'test-only-key',
  })
  assert.deepEqual(desktop.active, runtime.active)
  assert.equal(runtime.active.voice, '')
  assert.equal(existsSync(join(directory, 'frontend-models.json')), false)
  const before = readFileSync(store.path, 'utf8')
  assert.throws(() => store.save({ realtimeModel: 'unsupported-model', realtimeModelCatalogs: { dashscope: {} } }), /模型/)
  assert.equal(readFileSync(store.path, 'utf8'), before)
})

test('legacy JSON and its path override cannot add models, change Plus defaults or block settings', t => {
  const { directory, env } = fixture(t)
  const configPath = join(directory, 'config.env')
  const legacyPath = join(directory, 'frontend-models.json')
  const initialSnapshot = JSON.stringify(BUILTIN_REALTIME_MODEL_CATALOGS)
  const settings = { realtimeModel: 'qwen-audio-3.1-realtime-plus', realtimeApiKey: 'test-only-key' }
  const initial = realtimeSettingsConfiguration(settings)
  const store = createSettingsStore({ configDir: directory, clientDir: join(directory, 'client'), env: {} })
  for (const content of [
    JSON.stringify({ providers: { dashscope: { models: {
      'custom-audio': { api: 'audio', voice: 'untrusted-voice' },
      'qwen-audio-3.1-realtime-plus': { voice: 'untrusted-voice', turnDetection: 'smart_turn' },
    } } } }),
    'invalid JSON',
  ]) {
    writeFileSync(legacyPath, content)
    const legacyEnv = { ...env, QWEN_AUDIO_FRONTEND_MODELS_CONFIG: legacyPath, QWEN_AUDIO_REALTIME_API_KEY: 'test-only-key' }
    assert.equal(resolveRealtimeFrontendConfiguration(legacyEnv).modelCatalogs, BUILTIN_REALTIME_MODEL_CATALOGS)
    assert.equal(gatewaySetupStatus(legacyEnv).ready, true)
    assert.doesNotMatch(showConfig({ configPath, env: legacyEnv }), /custom-audio|untrusted-voice/)
    assert.throws(() => updateRealtimeModelConfig(configPath, 'custom-audio', { env: legacyEnv }), /不支持/)
    assert.equal(store.modelCatalogs(), BUILTIN_REALTIME_MODEL_CATALOGS)
    store.save(settings)
    assert.equal(realtimeSettingsChanged(settings, settings, store.modelCatalogs(), initial.active.signature), false)
    assert.equal(readFileSync(legacyPath, 'utf8'), content)
  }
  assert.doesNotThrow(() => store.save({ gatewayUrl: 'https://remote.example', language: 'en' }))
  assert.doesNotThrow(() => resolveRealtimeFrontendConfiguration({
    ...env, QWEN_AUDIO_FRONTEND_MODELS_CONFIG: join(directory, 'missing.json'),
  }))
  assert.equal(JSON.stringify(BUILTIN_REALTIME_MODEL_CATALOGS), initialSnapshot)
  const unknown = resolveRealtimeFrontendConfiguration({ ...env, QWEN_AUDIO_REALTIME_MODEL: 'custom-audio' })
  assert.equal(unknown.active.modelProfile.family, 'unknown')
  assert.throws(() => assertRealtimeFrontendModel(unknown.active), /模型/)
})
