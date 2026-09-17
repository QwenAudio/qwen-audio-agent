import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { REALTIME_PROVIDERS, realtimeRuntimeEnvironment, realtimeSettingsFromEnvironment } from '../shared/realtime-provider-definitions.mjs'
import { resolveRealtimeFrontendConfiguration } from '../shared/realtime-provider-catalog.mjs'

const profiles = [
  { provider: 'gpt-live', alias: 'openai', credential: 'OPENAI_API_KEY', credentialAlias: 'GPT_LIVE_API_KEY', model: 'GPT_LIVE_REALTIME_MODEL', modelValue: 'gpt-realtime-2.1', voice: 'GPT_LIVE_REALTIME_VOICE', voiceAlias: 'OPENAI_REALTIME_VOICE', endpoint: 'GPT_LIVE_REALTIME_URL', endpointAlias: 'OPENAI_REALTIME_URL' },
  { provider: 'google-live', alias: 'gemini-live', credential: 'GOOGLE_API_KEY', credentialAlias: 'GEMINI_API_KEY', model: 'GOOGLE_LIVE_REALTIME_MODEL', modelValue: 'gemini-3.8-live', voice: 'GOOGLE_LIVE_REALTIME_VOICE', voiceAlias: 'GEMINI_LIVE_REALTIME_VOICE', endpoint: 'GOOGLE_LIVE_REALTIME_URL', endpointAlias: 'GEMINI_LIVE_REALTIME_URL' },
]
for(const entry of profiles) {
  test(`${entry.provider} preserves aliases, clearing, isolation and environment round trips`, () => {
    const env = {
      QWEN_AUDIO_REALTIME_PROVIDER: entry.alias,
      DASHSCOPE_API_KEY: 'dash-not-live', STEPFUN_API_KEY: 'step-not-live',
      QWEN_AUDIO_REALTIME_MODEL: 'qwen-audio-3.0-realtime-plus', QWEN_AUDIO_REALTIME_VOICE: 'qwen-not-live',
      [entry.credentialAlias]: 'live-key', [entry.voiceAlias]: 'live-voice',
      [entry.endpointAlias]: 'wss://live.example/realtime',
    }
    const result = resolveRealtimeFrontendConfiguration(env)
    assert.equal(result.active.provider, entry.provider)
    assert.equal(result.active.model, entry.modelValue)
    assert.equal(result.active.voice, 'live-voice')
    assert.equal(result.credential, 'live-key')
    assert.equal(result.active.endpoint, 'wss://live.example/realtime')
    assert.deepEqual(resolveRealtimeFrontendConfiguration(realtimeRuntimeEnvironment(realtimeSettingsFromEnvironment(env))), result)
    const cleared = resolveRealtimeFrontendConfiguration({ ...env, [entry.credential]: '', [entry.voice]: '' })
    assert.equal(cleared.credential, '')
    assert.equal(cleared.active.voice, '')
    assert.equal(cleared.active.configured, false)
  })
}

test('all six providers declare independent native environment bindings', () => {
  assert.equal(REALTIME_PROVIDERS.length, 6)
  const bindings = REALTIME_PROVIDERS.flatMap(provider => provider.settings.map(field => field.environment[0]))
  assert.ok(bindings.every(Boolean))
  assert.equal(new Set(bindings).size, bindings.length)
})

test('DashScope dedicated workspace routing stays provider-scoped', () => {
  const env = { DASHSCOPE_WORKSPACE_ID: 'dedicated-test', DASHSCOPE_API_KEY: 'dash-key', STEPFUN_API_KEY: 'step-key' }
  assert.equal(resolveRealtimeFrontendConfiguration(env).active.endpoint, 'wss://dedicated-test.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime')
  assert.equal(resolveRealtimeFrontendConfiguration({ ...env, QWEN_AUDIO_REALTIME_PROVIDER: 'stepfun' }).active.endpoint, 'wss://api.stepfun.com/v1/realtime')
  assert.equal(resolveRealtimeFrontendConfiguration({ ...env, QWEN_AUDIO_REALTIME_BASE_URL: 'wss://explicit.example/realtime' }).active.endpoint, 'wss://explicit.example/realtime')
})

test('server provider descriptors never reuse the active provider model or credential', t => {
  const root = mkdtempSync(join(tmpdir(), 'qwaudio-config-isolation-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const source = `
    import { config } from ${JSON.stringify(new URL('../server/src/core/config.mjs', import.meta.url).href)};
    process.stdout.write(JSON.stringify({
      provider: config.audioProvider, active: config.realtimeModel,
      dash: [config.audioModel, config.dashscopeApiKey], step: [config.stepfunModel, config.stepfunApiKey],
      gpt: [config.gptLiveModel, config.openaiApiKey], google: [config.googleLiveModel, config.googleApiKey],
    }));
  `
  const env = { ...process.env,
    QWAUDIO_CONFIG_DIR: join(root,'config'), QWAUDIO_DATA_DIR: join(root,'data'),
    QWAUDIO_STATE_DIR: join(root,'state'), QWAUDIO_CACHE_DIR: join(root,'cache'), QWAUDIO_WORKSPACE: join(root,'workspace'),
    QWEN_AUDIO_REALTIME_PROVIDER: 'stepfun',
    DASHSCOPE_API_KEY: 'dash-key', QWEN_AUDIO_REALTIME_MODEL: 'qwen-audio-3.0-realtime-plus',
    STEPFUN_API_KEY: 'step-key', STEPFUN_REALTIME_MODEL: 'stepaudio-3-realtime-preview',
    OPENAI_API_KEY: 'gpt-key', GPT_LIVE_REALTIME_MODEL: 'gpt-realtime-2.1',
    GOOGLE_API_KEY: 'google-key', GOOGLE_LIVE_REALTIME_MODEL: 'gemini-3.8-live',
  }
  const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module','-e',source], { env, encoding:'utf8' }))
  assert.equal(result.provider, 'stepfun')
  assert.equal(result.active, 'stepaudio-3-realtime-preview')
  assert.deepEqual(result.dash, ['qwen-audio-3.0-realtime-plus','dash-key'])
  assert.deepEqual(result.step, ['stepaudio-3-realtime-preview','step-key'])
  assert.deepEqual(result.gpt, ['gpt-realtime-2.1','gpt-key'])
  assert.deepEqual(result.google, ['gemini-3.8-live','google-key'])
})
