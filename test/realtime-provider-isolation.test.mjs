import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseEnv } from 'node:util'
import test from 'node:test'
import { migrateRealtimeFileEnvironment, realtimeRuntimeEnvironment, realtimeSettingsFromEnvironment } from '../shared/realtime-provider-definitions.mjs'
import { resolveRealtimeFrontendConfiguration } from '../shared/realtime-provider-catalog.mjs'
import { createSettingsStore } from '../desktop/src/settings-store.mjs'
import { resolveConfigModel, updateRealtimeModelConfig } from '../cli/src/config-command.mjs'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'qwaudio-provider-isolation-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const configDir = join(root, 'config')
  mkdirSync(configDir)
  return { root, configDir, clientDir: join(root, 'client'), env: {} }
}
const encode = values => Object.entries(values).map(([key, value]) => key + '=' + value).join('\n') + '\n'

test('legacy normalization is idempotent and never mutates input or other module keys', () => {
  const input = {
    QWEN_AUDIO_REALTIME_PROVIDER: 'stepfun', STEPFUN_API_KEY: 'step-key',
    STEPFUN_REALTIME_MODEL: 'stepaudio-3-realtime-preview', STEPFUN_REALTIME_URL: 'wss://step.example/realtime',
    STEPFUN_REALTIME_VOICE: 'voice', DASHSCOPE_API_KEY: 'backend-key',
  }
  const result = migrateRealtimeFileEnvironment(input)
  assert.equal(result.QWEN_AUDIO_REALTIME_API_KEY, 'step-key')
  assert.equal(result.QWEN_AUDIO_REALTIME_MODEL, 'stepaudio-3-realtime-preview')
  assert.equal(result.QWEN_AUDIO_REALTIME_URL, 'wss://step.example/realtime')
  assert.equal(result.QWEN_AUDIO_REALTIME_VOICE, 'voice')
  assert.equal(result.DASHSCOPE_API_KEY, 'backend-key')
  assert.equal(input.QWEN_AUDIO_REALTIME_API_KEY, undefined)
  assert.deepEqual(migrateRealtimeFileEnvironment(result), result)
})

test('canonical frontend credential is independent of a different backend credential', () => {
  const input = { DASHSCOPE_API_KEY: 'backend-value', QWEN_AUDIO_REALTIME_API_KEY: 'frontend-value' }
  const result = migrateRealtimeFileEnvironment(input)
  assert.equal(result.DASHSCOPE_API_KEY, 'backend-value')
  assert.equal(resolveRealtimeFrontendConfiguration(result).credential, 'frontend-value')
})

test('serialization emits only the five active settings', () => {
  const input = {
    DASHSCOPE_API_KEY: 'dash-key', STEPFUN_API_KEY: 'step-key',
    QWEN_AUDIO_REALTIME_MODEL: 'qwen-audio-3.0-realtime-flash',
    QWEN_AUDIO_REALTIME_BASE_URL: 'wss://dash.example/realtime',
    QWEN_AUDIO_REALTIME_VOICE: 'dash-voice', QWEN_OMNI_REALTIME_VOICE: 'omni-voice',
  }
  assert.deepEqual(realtimeRuntimeEnvironment(realtimeSettingsFromEnvironment(input)), {
    QWEN_AUDIO_REALTIME_PROVIDER: 'dashscope', QWEN_AUDIO_REALTIME_API_KEY: 'dash-key',
    QWEN_AUDIO_REALTIME_MODEL: input.QWEN_AUDIO_REALTIME_MODEL,
    QWEN_AUDIO_REALTIME_URL: input.QWEN_AUDIO_REALTIME_BASE_URL,
    QWEN_AUDIO_REALTIME_VOICE: 'dash-voice',
  })
})

test('obsolete profile files cannot restore credentials on a provider switch', t => {
  const options = fixture(t)
  const configPath = join(options.configDir, 'config.env')
  writeFileSync(configPath, encode({
    QWEN_AUDIO_REALTIME_PROVIDER: 'stepfun', QWEN_AUDIO_REALTIME_API_KEY: 'step-key',
  }))
  writeFileSync(join(options.configDir, 'realtime-profiles.json'), JSON.stringify({
    activeProvider: 'dashscope', profiles: { dashscope: { credential: 'obsolete-key' } },
  }))
  const store = createSettingsStore(options)
  assert.equal(store.load().realtimeApiKey, 'step-key')
  store.save({ realtimeProvider: 'dashscope' })
  assert.equal(store.load().realtimeApiKey, '')
  assert.equal(parseEnv(readFileSync(configPath, 'utf8')).QWEN_AUDIO_REALTIME_API_KEY, '')
})

test('CLI model edits use the canonical field and preserve unrelated keys', t => {
  const options = fixture(t)
  const path = join(options.configDir, 'config.env')
  writeFileSync(path, encode({
    QWEN_AUDIO_REALTIME_PROVIDER: 'stepfun', STEPFUN_REALTIME_MODEL: 'stepaudio-3-realtime-preview',
    DASHSCOPE_API_KEY: 'backend-key',
  }))
  const result = updateRealtimeModelConfig(path, 'stepaudio-3-realtime-preview')
  assert.equal(result.environment, 'QWEN_AUDIO_REALTIME_MODEL')
  const after = parseEnv(readFileSync(path, 'utf8'))
  assert.equal(after.QWEN_AUDIO_REALTIME_MODEL, 'stepaudio-3-realtime-preview')
  assert.equal(after.DASHSCOPE_API_KEY, 'backend-key')
  assert.equal(resolveConfigModel({}, readFileSync(path, 'utf8')), 'stepaudio-3-realtime-preview')
})

test('CLI model display does not retain the previous provider model across source overrides', () => {
  assert.equal(resolveConfigModel({ QWEN_AUDIO_REALTIME_PROVIDER: 'stepfun' },
    'QWEN_AUDIO_REALTIME_PROVIDER=dashscope\nQWEN_AUDIO_REALTIME_MODEL=qwen-audio-3.0-realtime-plus\n'),
  'stepaudio-3-realtime-preview')
  assert.equal(resolveConfigModel({ QWEN_AUDIO_REALTIME_PROVIDER: 'minicpm-o' }), '')
})
