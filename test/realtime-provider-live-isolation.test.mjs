import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { REALTIME_PROVIDERS, realtimeRuntimeEnvironment, realtimeSettingsFromEnvironment } from '../shared/realtime-provider-definitions.mjs'
import { resolveRealtimeFrontendConfiguration } from '../shared/realtime-provider-catalog.mjs'

const profiles = [
  { provider: 'doubao-seeduplex', alias: 'seeduplex', modelValue: '1.2.6.1' },
  { provider: 'gpt-live', alias: 'openai', modelValue: 'gpt-realtime-2.1' },
  { provider: 'gpt-live-1', alias: 'openai-live', modelValue: 'gpt-live-1' },
  { provider: 'google-live', alias: 'gemini-live', modelValue: 'gemini-3.8-live' },
]
for(const entry of profiles) {
  test(`${entry.provider} preserves aliases, clearing, isolation and environment round trips`, () => {
    const env = {
      QWEN_AUDIO_REALTIME_PROVIDER: entry.alias,
      DASHSCOPE_API_KEY: 'dash-not-live', STEPFUN_API_KEY: 'step-not-live',
      QWEN_AUDIO_REALTIME_MODEL: entry.modelValue,
      QWEN_AUDIO_REALTIME_API_KEY: 'live-key', QWEN_AUDIO_REALTIME_VOICE: 'live-voice',
      QWEN_AUDIO_REALTIME_URL: 'wss://live.example/realtime',
    }
    const result = resolveRealtimeFrontendConfiguration(env)
    assert.equal(result.active.provider, entry.provider)
    assert.equal(result.active.model, entry.modelValue)
    assert.equal(result.active.voice, 'live-voice')
    assert.equal(result.credential, 'live-key')
    assert.equal(result.active.endpoint, 'wss://live.example/realtime')
    assert.deepEqual(resolveRealtimeFrontendConfiguration(realtimeRuntimeEnvironment(realtimeSettingsFromEnvironment(env))), result)
    const cleared = resolveRealtimeFrontendConfiguration({ ...env, QWEN_AUDIO_REALTIME_API_KEY: '', QWEN_AUDIO_REALTIME_VOICE: '' })
    assert.equal(cleared.credential, '')
    assert.equal(cleared.active.voice, '')
    assert.equal(cleared.active.configured, false)
  })
}

test('all registered providers declare the same connection environment bindings', () => {
  assert.ok(REALTIME_PROVIDERS.length > 0)
  for (const provider of REALTIME_PROVIDERS) assert.ok(provider.settings.length > 0, provider.key)
  const bindings = REALTIME_PROVIDERS.flatMap(provider => provider.settings.map(field => field.environment[0]))
  assert.ok(bindings.every(Boolean))
  assert.deepEqual([...new Set(bindings)].sort(), [
    'QWEN_AUDIO_REALTIME_API_KEY', 'QWEN_AUDIO_REALTIME_MODEL',
    'QWEN_AUDIO_REALTIME_URL', 'QWEN_AUDIO_REALTIME_VOICE',
  ])
})

test('DashScope dedicated workspace routing stays provider-scoped', () => {
  const env = { DASHSCOPE_WORKSPACE_ID: 'dedicated-test', DASHSCOPE_API_KEY: 'dash-key', STEPFUN_API_KEY: 'step-key' }
  assert.equal(resolveRealtimeFrontendConfiguration(env).active.endpoint, 'wss://dedicated-test.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime')
  assert.equal(resolveRealtimeFrontendConfiguration({ ...env, QWEN_AUDIO_REALTIME_PROVIDER: 'stepfun' }).active.endpoint, 'wss://api.stepfun.com/v1/realtime')
  assert.equal(resolveRealtimeFrontendConfiguration({ ...env, QWEN_AUDIO_REALTIME_URL: 'wss://explicit.example/realtime' }).active.endpoint, 'wss://explicit.example/realtime')
})

test('server exposes one active frontend connection without changing backend credentials', t => {
  const root = mkdtempSync(join(tmpdir(), 'qwaudio-config-isolation-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const source = `
    import { config } from ${JSON.stringify(new URL('../server/src/core/config.mjs', import.meta.url).href)};
    import { providerRuntimeConfiguration } from ${JSON.stringify(new URL('../server/src/voice/providers/runtime-configuration.mjs', import.meta.url).href)};
    import { listRealtimeProviders } from ${JSON.stringify(new URL('../server/src/voice/providers/registry.mjs', import.meta.url).href)};
    process.stdout.write(JSON.stringify({
      provider: config.audioProvider, active: config.realtimeModel,
      credential: config.realtimeCredential, backendCredential: config.backends.llm.apiKey,
      providers: listRealtimeProviders().map(provider => provider.key),
      inactive: ['dashscope', 'gpt-live', 'gpt-live-1', 'google-live'].map(key => providerRuntimeConfiguration(key).credential),
    }));
  `
  const env = { ...process.env,
    QWAUDIO_CONFIG_DIR: join(root,'config'), QWAUDIO_DATA_DIR: join(root,'data'),
    QWAUDIO_STATE_DIR: join(root,'state'), QWAUDIO_CACHE_DIR: join(root,'cache'), QWAUDIO_WORKSPACE: join(root,'workspace'),
    QWEN_AUDIO_REALTIME_PROVIDER: 'stepfun',
    QWEN_AUDIO_REALTIME_API_KEY: 'step-key', QWEN_AUDIO_REALTIME_MODEL: 'stepaudio-3-realtime-preview',
    QWEN_AUDIO_REALTIME_URL: 'wss://frontend.invalid/realtime',
    QWEN_AUDIO_AGENT_LLM_API_KEY: 'backend-key',
    DASHSCOPE_API_KEY: 'dash-key', OPENAI_API_KEY: 'gpt-key', GOOGLE_API_KEY: 'google-key',
  }
  const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module','-e',source], { env, encoding:'utf8' }))
  assert.equal(result.provider, 'stepfun')
  assert.equal(result.active, 'stepaudio-3-realtime-preview')
  assert.equal(result.credential, 'step-key')
  assert.equal(result.backendCredential, 'backend-key')
  assert.deepEqual(result.providers, ['stepfun'])
  assert.deepEqual(result.inactive, ['', '', '', ''])
})
