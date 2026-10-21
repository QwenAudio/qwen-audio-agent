import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { loadRealtimeModelCatalogs, realtimeModelConfigPath } from '../shared/realtime-models/config-file.mjs'
import { assertRealtimeFrontendModel, resolveRealtimeFrontendConfiguration } from '../shared/realtime-provider-catalog.mjs'
import { gatewaySetupStatus } from '../shared/gateway/setup.mjs'
import { createSettingsStore } from '../desktop/src/settings-store.mjs'
import { realtimeSettingsChanged, realtimeSettingsConfiguration } from '../desktop/src/settings-config.mjs'
import { resolveConfigModel, showConfig, updateRealtimeModelConfig } from '../cli/src/config-command.mjs'

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'qwaudio-model-catalog-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return { directory, env: { QWAUDIO_CONFIG_DIR: directory } }
}

function writeCatalog(directory, models, file = 'frontend-models.json') {
  writeFileSync(join(directory, file), JSON.stringify({ providers: { dashscope: { models } } }))
}

test('absent default catalog uses builtins without creating directories', t => {
  const { directory } = fixture(t)
  const absent = join(directory, 'absent')
  const catalogs = loadRealtimeModelCatalogs({ QWAUDIO_CONFIG_DIR: absent })
  assert.equal(catalogs.dashscope.defaultModel, 'qwen-audio-3.1-realtime-plus')
  assert.equal(existsSync(absent), false)
})

test('relative catalog paths resolve against configuration directory, not launch directory', t => {
  const { directory, env } = fixture(t)
  writeCatalog(directory, { 'custom-omni': { api: 'omni', voice: 'test-voice' } }, 'models.json')
  env.QWEN_AUDIO_FRONTEND_MODELS_CONFIG = 'models.json'
  assert.equal(realtimeModelConfigPath(env), join(directory, 'models.json'))
  const resolved = resolveRealtimeFrontendConfiguration({
    ...env, DASHSCOPE_API_KEY: 'test-key', QWEN_AUDIO_REALTIME_MODEL: 'custom-omni',
    QWEN_AUDIO_REALTIME_VOICE: 'omni-override',
  })
  assert.equal(resolved.active.modelProfile.api, 'omni')
  assert.equal(resolved.active.voice, 'omni-override')
  assert.doesNotThrow(() => assertRealtimeFrontendModel(resolved.active))
  assert.equal(gatewaySetupStatus({ ...env, DASHSCOPE_API_KEY: 'test', QWEN_AUDIO_REALTIME_MODEL: 'custom-omni' }).ready, true)
})

test('explicit missing, malformed, invalid and oversized catalogs fail clearly', t => {
  const { directory, env } = fixture(t)
  assert.throws(() => loadRealtimeModelCatalogs({ ...env, QWEN_AUDIO_FRONTEND_MODELS_CONFIG: 'missing.json' }), /Cannot read.*missing.json/)
  const path = join(directory, 'frontend-models.json')
  writeFileSync(path, '{ broken')
  assert.throws(() => loadRealtimeModelCatalogs(env), /Invalid JSON/)
  assert.equal(gatewaySetupStatus(env).ready, false)
  assert.equal(gatewaySetupStatus(env).missing[0].key, 'QWEN_AUDIO_FRONTEND_MODELS_CONFIG')
  writeCatalog(directory, { typo: { api: 'unknown-protocol' } })
  assert.throws(() => loadRealtimeModelCatalogs(env), /unsupported API/)
  writeFileSync(path, ' '.repeat(1024 * 1024 + 1))
  assert.throws(() => loadRealtimeModelCatalogs(env), /exceeds 1 MiB/)
})

test('model metadata participates in runtime identity without leaking credentials', t => {
  const { directory, env } = fixture(t)
  const activeEnv = { ...env, QWEN_AUDIO_REALTIME_MODEL: 'custom-audio', DASHSCOPE_API_KEY: 'secret-test-value' }
  writeCatalog(directory, { 'custom-audio': { api: 'audio', voice: 'voice-a' } })
  const first = resolveRealtimeFrontendConfiguration(activeEnv)
  writeCatalog(directory, { 'custom-audio': { api: 'audio', voice: 'voice-b' } })
  const second = resolveRealtimeFrontendConfiguration(activeEnv)
  assert.notEqual(first.active.signature, second.active.signature)
  assert.equal(JSON.stringify(first.active).includes('secret-test-value'), false)
  assert.equal(first.modelCatalogs.dashscope.profiles.at(-1).sessionDefaults.voice, 'voice-a')
  const settings = { realtimeModel: 'custom-audio', realtimeApiKey: 'secret-test-value' }
  const runningSignature = realtimeSettingsConfiguration(settings, first.modelCatalogs).active.signature
  assert.equal(realtimeSettingsChanged(settings, settings, first.modelCatalogs, runningSignature), false)
  assert.equal(realtimeSettingsChanged(settings, settings, second.modelCatalogs, runningSignature), true)
})

test('CLI, fresh desktop settings and runtime share the Audio 3.1 default without rewriting explicit choices', t => {
  const { directory, env } = fixture(t)
  const configPath = join(directory, 'config.env')
  const store = createSettingsStore({ configDir: directory, clientDir: join(directory, 'client'), env: {} })
  assert.equal(resolveConfigModel(), 'qwen-audio-3.1-realtime-plus')
  assert.match(showConfig({ configPath }), /Realtime 模型：qwen-audio-3\.1-realtime-plus/)
  assert.equal(store.load().realtimeModel, 'qwen-audio-3.1-realtime-plus')
  const configuration = resolveRealtimeFrontendConfiguration(env)
  assert.equal(configuration.active.model, 'qwen-audio-3.1-realtime-plus')
  assert.equal(configuration.active.modelProfile.sessionDefaults.voice, 'longanqian_v3.1')
  assert.equal(configuration.active.voice, '', 'a model default is not an explicit voice override')
  assert.equal(existsSync(configPath), false, 'reading defaults must not rewrite configuration')

  const content = 'QWEN_AUDIO_REALTIME_MODEL=qwen-audio-3.0-realtime-plus\nQWEN_AUDIO_REALTIME_VOICE=custom-voice\n'
  writeFileSync(configPath, content)
  assert.equal(resolveConfigModel({}, content), 'qwen-audio-3.0-realtime-plus')
  assert.equal(store.load().realtimeModel, 'qwen-audio-3.0-realtime-plus')
  assert.equal(store.load().realtimeVoice, 'custom-voice')
  assert.equal(readFileSync(configPath, 'utf8'), content)
})

test('CLI lists and selects registered models, rejecting unknown IDs without changing configuration', t => {
  const { directory } = fixture(t)
  writeCatalog(directory, { 'custom-audio': { api: 'audio', label: 'My Audio' } })
  const configPath = join(directory, 'config.env')
  assert.match(showConfig({ configPath }), /custom-audio（My Audio）/)
  updateRealtimeModelConfig(configPath, 'custom-audio')
  const content = readFileSync(configPath, 'utf8')
  assert.match(content, /QWEN_AUDIO_REALTIME_MODEL=custom-audio/)
  assert.throws(() => updateRealtimeModelConfig(configPath, 'unregistered'), /frontend-models.json/)
  assert.equal(readFileSync(configPath, 'utf8'), content)
})

test('desktop uses its explicit config directory and never trusts an editable catalog payload', t => {
  const { directory } = fixture(t)
  const configDir = join(directory, 'gateway')
  mkdirSync(configDir)
  writeCatalog(configDir, { 'custom-audio': { api: 'audio' } }, 'custom.json')
  writeFileSync(join(configDir, 'config.env'), 'QWEN_AUDIO_FRONTEND_MODELS_CONFIG=custom.json\n')
  const store = createSettingsStore({ configDir, clientDir: join(directory, 'client'), env: {} })
  assert.equal(store.modelCatalogs().dashscope.profiles.at(-1).id, 'custom-audio')
  store.save({ realtimeModel: 'custom-audio', realtimeApiKey: 'test-key' })
  assert.equal(store.ready(), true)
  const before = readFileSync(store.path, 'utf8')
  assert.throws(() => store.save({ realtimeModel: 'unregistered', realtimeModelCatalogs: { dashscope: {} } }), /已注册模型/)
  assert.equal(readFileSync(store.path, 'utf8'), before)
  // Client-only settings remain independent of local model configuration.
  assert.doesNotThrow(() => store.save({ autoHideSeconds: 60 }))
  assert.equal(readFileSync(store.path, 'utf8'), before)
})

test('invalid local catalog remains visible without blocking remote client settings', t => {
  const { directory } = fixture(t)
  writeFileSync(join(directory, 'frontend-models.json'), 'invalid JSON')
  const store = createSettingsStore({ configDir: directory, clientDir: join(directory, 'client'), env: {} })
  assert.doesNotThrow(() => store.load())
  assert.equal(store.modelCatalogStatus().realtimeModelCatalogs, null)
  assert.match(store.modelCatalogStatus().realtimeModelCatalogError, /Invalid JSON/)
  assert.doesNotThrow(() => store.save({ gatewayUrl: 'https://remote.example', language: 'en' }))
  assert.throws(() => store.save({ realtimeModel: 'qwen-audio-3.0-realtime-plus' }), /Invalid JSON/)
})
