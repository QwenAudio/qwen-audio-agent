import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseEnv } from 'node:util'
import test from 'node:test'
import {
  migrateRealtimeFileEnvironment,
  realtimeRuntimeEnvironment,
  realtimeSettingsFromEnvironment,
} from '../shared/realtime-provider-definitions.mjs'
import { resolveRealtimeFrontendConfiguration } from '../shared/realtime-provider-catalog.mjs'
import { createSettingsStore } from '../desktop/src/settings-store.mjs'
import { updateRealtimeModelConfig } from '../cli/src/config-command.mjs'
import { loadRuntimeEnvironment } from '../shared/runtime-environment.mjs'

const providers = {
  DASHSCOPE_API_KEY: 'dash-key',
  QWEN_AUDIO_REALTIME_MODEL: 'qwen-audio-3.0-realtime-flash',
  QWEN_AUDIO_REALTIME_BASE_URL: 'wss://dash.example/realtime',
  QWEN_AUDIO_REALTIME_VOICE: 'dash-voice',
  QWEN_OMNI_REALTIME_VOICE: 'omni-voice',
  STEPFUN_API_KEY: 'step-key',
  STEPFUN_REALTIME_MODEL: 'stepaudio-3-realtime-preview',
  STEPFUN_REALTIME_URL: 'wss://step.example/realtime',
  STEPFUN_REALTIME_VOICE: 'step-voice',
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'qwaudio-provider-isolation-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const configDir = join(root, 'config')
  mkdirSync(configDir)
  return { root, configDir, clientDir: join(root, 'client'), env: {} }
}
function encode(values) {
  return Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n') + '\n'
}

test('switching just the selector uses the complete independent supplier profile', () => {
  for (const provider of ['dashscope', 'stepfun', 'dashscope']) {
    const result = resolveRealtimeFrontendConfiguration({ ...providers, QWEN_AUDIO_REALTIME_PROVIDER: provider })
    const step = provider === 'stepfun'
    assert.equal(result.credential, step ? providers.STEPFUN_API_KEY : providers.DASHSCOPE_API_KEY)
    assert.equal(result.active.model, step ? providers.STEPFUN_REALTIME_MODEL : providers.QWEN_AUDIO_REALTIME_MODEL)
    assert.equal(result.active.endpoint, step ? providers.STEPFUN_REALTIME_URL : providers.QWEN_AUDIO_REALTIME_BASE_URL)
    assert.equal(result.active.voice, step ? providers.STEPFUN_REALTIME_VOICE : providers.QWEN_AUDIO_REALTIME_VOICE)
  }
})

test('global process credentials and endpoint cannot configure any provider', () => {
  for (const provider of ['dashscope', 'stepfun', 'speech-to-speech', 'minicpm-o']) {
    const result = resolveRealtimeFrontendConfiguration({
      QWEN_AUDIO_REALTIME_PROVIDER: provider,
      QWEN_AUDIO_REALTIME_API_KEY: 'forbidden-key',
      QWEN_AUDIO_REALTIME_ENDPOINT: 'wss://forbidden.example/realtime',
    })
    assert.equal(result.credential, '')
    assert.notEqual(result.active.endpoint, 'wss://forbidden.example/realtime')
  }
})

test('serialization preserves all provider parameters and independent voice families', () => {
  const serialized = realtimeRuntimeEnvironment(realtimeSettingsFromEnvironment(providers))
  for (const [key, value] of Object.entries(providers)) assert.equal(serialized[key], value, key)
  assert.equal(Object.hasOwn(serialized, 'QWEN_AUDIO_REALTIME_API_KEY'), false)
  assert.equal(Object.hasOwn(serialized, 'QWEN_AUDIO_REALTIME_ENDPOINT'), false)
})

test('transitional file migration is provider-scoped and idempotent', () => {
  const input = {
    QWEN_AUDIO_REALTIME_PROVIDER: 'stepfun',
    QWEN_AUDIO_REALTIME_API_KEY: 'old-step-key',
    QWEN_AUDIO_REALTIME_ENDPOINT: 'wss://old-step.example/realtime',
    QWEN_AUDIO_REALTIME_MODEL: 'stepaudio-3-realtime-preview',
    QWEN_AUDIO_REALTIME_VOICE: 'old-step-voice',
    DASHSCOPE_API_KEY: 'unrelated-dash-key',
  }
  const result = migrateRealtimeFileEnvironment(input)
  assert.equal(result.STEPFUN_API_KEY, 'old-step-key')
  assert.equal(result.STEPFUN_REALTIME_URL, 'wss://old-step.example/realtime')
  assert.equal(result.STEPFUN_REALTIME_MODEL, 'stepaudio-3-realtime-preview')
  assert.equal(result.STEPFUN_REALTIME_VOICE, 'old-step-voice')
  assert.equal(result.DASHSCOPE_API_KEY, 'unrelated-dash-key')
  assert.equal(result.QWEN_AUDIO_REALTIME_MODEL, undefined)
  assert.equal(result.QWEN_AUDIO_REALTIME_VOICE, undefined)
  assert.deepEqual(migrateRealtimeFileEnvironment(result), result)
  assert.equal(input.QWEN_AUDIO_REALTIME_API_KEY, 'old-step-key')
})

test('migration does not reinterpret a historical DashScope model as a StepFun model', () => {
  const result = migrateRealtimeFileEnvironment({
    QWEN_AUDIO_REALTIME_PROVIDER: 'stepfun',
    QWEN_AUDIO_REALTIME_API_KEY: 'step-key',
    QWEN_AUDIO_REALTIME_MODEL: providers.QWEN_AUDIO_REALTIME_MODEL,
  })
  assert.equal(result.QWEN_AUDIO_REALTIME_MODEL, providers.QWEN_AUDIO_REALTIME_MODEL)
  assert.equal(resolveRealtimeFrontendConfiguration(result).active.model, providers.STEPFUN_REALTIME_MODEL)
})

test('legacy Omni voice imports into the Omni family only', () => {
  const result = migrateRealtimeFileEnvironment({
    QWEN_AUDIO_REALTIME_API_KEY: 'dash-key',
    QWEN_AUDIO_REALTIME_MODEL: 'qwen3.5-omni-plus-realtime',
    QWEN_AUDIO_REALTIME_VOICE: 'old-omni',
  })
  assert.equal(result.QWEN_OMNI_REALTIME_VOICE, 'old-omni')
  assert.equal(result.QWEN_AUDIO_REALTIME_VOICE, undefined)
  assert.equal(resolveRealtimeFrontendConfiguration(result).active.voice, 'old-omni')
})

test('conflicting stored credentials fail without exposing or changing either key', () => {
  const input = { DASHSCOPE_API_KEY: 'backend-private-value', QWEN_AUDIO_REALTIME_API_KEY: 'frontend-private-value' }
  assert.throws(() => migrateRealtimeFileEnvironment(input), error => {
    assert.match(error.message, /migration conflict.*DASHSCOPE_API_KEY/)
    assert.doesNotMatch(error.message, /backend-private-value|frontend-private-value/)
    return true
  })
  assert.equal(input.DASHSCOPE_API_KEY, 'backend-private-value')
})

test('CLI source precedence applies after importing the persisted provider', t => {
  const options = fixture(t)
  writeFileSync(join(options.configDir, 'config.env'), encode({
    QWEN_AUDIO_REALTIME_PROVIDER: 'stepfun',
    QWEN_AUDIO_REALTIME_API_KEY: 'old-step-key',
    QWEN_AUDIO_REALTIME_MODEL: providers.STEPFUN_REALTIME_MODEL,
    DASHSCOPE_API_KEY: 'dash-key',
  }))
  const env = { QWAUDIO_CONFIG_DIR: options.configDir, QWEN_AUDIO_REALTIME_PROVIDER: 'dashscope' }
  loadRuntimeEnvironment({ root: options.root, env, readOnly: true })
  assert.equal(resolveRealtimeFrontendConfiguration(env).credential, 'dash-key')
  assert.equal(env.STEPFUN_API_KEY, 'old-step-key')
  assert.equal(env.QWEN_AUDIO_REALTIME_API_KEY, undefined)
})

test('Desktop migrates stored active connection and sidecar drafts to provider fields on save', t => {
  const options = fixture(t)
  const configPath = join(options.configDir, 'config.env')
  writeFileSync(configPath, encode({
    QWEN_AUDIO_REALTIME_PROVIDER: 'stepfun',
    QWEN_AUDIO_REALTIME_API_KEY: 'old-step-key',
    QWEN_AUDIO_REALTIME_MODEL: providers.STEPFUN_REALTIME_MODEL,
    QWEN_AUDIO_REALTIME_VOICE: 'old-step-voice',
  }))
  writeFileSync(join(options.configDir, 'realtime-profiles.json'), JSON.stringify({
    activeProvider: 'stepfun',
    profiles: { dashscope: { credential: 'draft-dash-key', model: providers.QWEN_AUDIO_REALTIME_MODEL, audioVoice: 'saved-audio', omniVoice: 'saved-omni' } },
  }))
  const store = createSettingsStore(options)
  assert.equal(store.load().stepfunApiKey, 'old-step-key')
  assert.equal(store.load().dashscopeApiKey, 'draft-dash-key')
  store.save({ realtimeProvider: 'dashscope' })
  const values = parseEnv(readFileSync(configPath, 'utf8'))
  assert.equal(values.STEPFUN_API_KEY, 'old-step-key')
  assert.equal(values.DASHSCOPE_API_KEY, 'draft-dash-key')
  assert.equal(values.QWEN_AUDIO_REALTIME_VOICE, 'saved-audio')
  assert.equal(values.QWEN_OMNI_REALTIME_VOICE, 'saved-omni')
  assert.equal(values.QWEN_AUDIO_REALTIME_API_KEY, undefined)
  assert.equal(values.QWEN_AUDIO_REALTIME_ENDPOINT, undefined)
  assert.equal(createSettingsStore({ ...options, env: {} }).load().stepfunRealtimeVoice, 'old-step-voice')
})

test('CLI edits selected supplier model without modifying the other provider', t => {
  const options = fixture(t)
  const path = join(options.configDir, 'config.env')
  writeFileSync(path, encode({ ...providers, QWEN_AUDIO_REALTIME_PROVIDER: 'stepfun' }))
  const result = updateRealtimeModelConfig(path, providers.STEPFUN_REALTIME_MODEL)
  assert.equal(result.environment, 'STEPFUN_REALTIME_MODEL')
  const after = parseEnv(readFileSync(path, 'utf8'))
  assert.equal(after.QWEN_AUDIO_REALTIME_MODEL, providers.QWEN_AUDIO_REALTIME_MODEL)
  assert.equal(after.DASHSCOPE_API_KEY, providers.DASHSCOPE_API_KEY)
  assert.equal(after.STEPFUN_REALTIME_MODEL, providers.STEPFUN_REALTIME_MODEL)
})
