import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseEnv } from 'node:util'
import test from 'node:test'
import {
  REALTIME_PROVIDERS, mergeRealtimeEnvironment, realtimeCredentialFromEnvironment,
  realtimeRuntimeEnvironment, realtimeSettingsFromEnvironment,
} from '../shared/realtime-provider-definitions.mjs'
import {
  DEFAULT_DASHSCOPE_REALTIME_MODEL, DEFAULT_STEPFUN_REALTIME_MODEL,
  resolveDashScopeRealtimeVoiceOverride, resolveRealtimeFrontendConfiguration,
} from '../shared/realtime-provider-catalog.mjs'
import { loadRuntimeEnvironment, requireRealtimeFrontendConfiguration } from '../shared/runtime-environment.mjs'
import { createSettingsStore } from '../desktop/src/settings-store.mjs'
import { desktopGatewayEnvironment } from '../desktop/src/gateway-process.mjs'

const legacyKeys = {
  dashscope: ['DASHSCOPE_API_KEY', 'QWEN_AUDIO_REALTIME_BASE_URL'],
  stepfun: ['STEPFUN_API_KEY', 'STEPFUN_REALTIME_URL'],
  'gpt-live': ['OPENAI_API_KEY', 'GPT_LIVE_REALTIME_URL'],
  'google-live': ['GOOGLE_API_KEY', 'GOOGLE_LIVE_REALTIME_URL'],
  'doubao-seeduplex': ['DOUBAO_API_KEY', 'DOUBAO_SEEDUPLEX_REALTIME_URL'],
  'speech-to-speech': ['SPEECH_TO_SPEECH_AUTH_TOKEN', 'SPEECH_TO_SPEECH_REALTIME_URL'],
  'minicpm-o': ['MINICPM_O_AUTH_TOKEN', 'MINICPM_O_REALTIME_URL'],
}
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'qwaudio-provider-env-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const configDir = join(root, 'config')
  mkdirSync(configDir)
  return { root, configDir, configPath: join(configDir, 'config.env'), clientDir: join(root, 'desktop') }
}
const encode = env => Object.entries(env).map(([key, value]) => key + '=' + value).join('\n') + '\n'
function cliConfiguration({ root, configDir }, overrides = {}) {
  const env = { QWAUDIO_CONFIG_DIR: configDir, ...overrides }
  const loaded = loadRuntimeEnvironment({ root, env, readOnly: true })
  return { env, loaded, ...resolveRealtimeFrontendConfiguration(env) }
}

for (const provider of REALTIME_PROVIDERS) {
  const local = !provider.settings.some(field => field.slot === 'model')
  test(provider.key + ': the same five fields round-trip from env through desktop to runtime', () => {
    const env = {
      QWEN_AUDIO_REALTIME_PROVIDER: provider.key,
      QWEN_AUDIO_REALTIME_API_KEY: 'active-key',
      QWEN_AUDIO_REALTIME_URL: 'wss://service.example/realtime?mode=video',
      QWEN_AUDIO_REALTIME_MODEL: local ? 'upstream-controlled' : '',
      QWEN_AUDIO_REALTIME_VOICE: 'voice-override',
    }
    const result = resolveRealtimeFrontendConfiguration(env)
    assert.equal(result.credential, 'active-key')
    assert.equal(result.active.endpoint, env.QWEN_AUDIO_REALTIME_URL)
    assert.equal(result.active.voice, local ? '' : 'voice-override')
    assert.equal(result.active.model, local ? null : provider.settings.find(field => field.slot === 'model').default)
    assert.equal(result.active.configured, true)
    assert.equal(realtimeCredentialFromEnvironment(env), 'active-key')
    assert.equal(Object.hasOwn(result.active, 'credential'), false)
    const runtime = realtimeRuntimeEnvironment(realtimeSettingsFromEnvironment(env))
    assert.equal(Object.keys(runtime).length, 5)
    assert.deepEqual(resolveRealtimeFrontendConfiguration(runtime), result)
    assert.doesNotThrow(() => requireRealtimeFrontendConfiguration(runtime))
  })

  // Only providers older than the shared names have old ones.
  if (legacyKeys[provider.key]) test(provider.key + ': canonical fields override old names, including explicit blanks', () => {
    const [key, url] = legacyKeys[provider.key]
    const old = { QWEN_AUDIO_REALTIME_PROVIDER: provider.key, [key]: 'old-key', [url]: 'wss://old.example/realtime' }
    assert.equal(resolveRealtimeFrontendConfiguration(old).credential, 'old-key')
    const result = resolveRealtimeFrontendConfiguration({
      ...old, QWEN_AUDIO_REALTIME_API_KEY: '', QWEN_AUDIO_REALTIME_URL: '',
    })
    assert.equal(result.credential, '')
    assert.equal(result.active.endpoint, provider.settings.find(field => field.slot === 'endpoint').default)
    assert.equal(result.active.configured, local)
  })

  test(provider.key + ': blank optional fields use provider/model defaults', () => {
    const result = resolveRealtimeFrontendConfiguration({
      QWEN_AUDIO_REALTIME_PROVIDER: provider.key, QWEN_AUDIO_REALTIME_API_KEY: 'key',
      QWEN_AUDIO_REALTIME_MODEL: '', QWEN_AUDIO_REALTIME_URL: '', QWEN_AUDIO_REALTIME_VOICE: '',
    })
    assert.equal(result.active.model, local ? null : provider.settings.find(field => field.slot === 'model').default)
    assert.equal(result.active.voice, '')
    assert.equal(result.active.endpoint, provider.settings.find(field => field.slot === 'endpoint').default)
  })
}

test('legacy credential fallback never borrows another provider key', () => {
  for (const provider of REALTIME_PROVIDERS.filter(item => item.key !== 'dashscope')) {
    assert.equal(resolveRealtimeFrontendConfiguration({
      QWEN_AUDIO_REALTIME_PROVIDER: provider.key, DASHSCOPE_API_KEY: 'dash-only',
    }).credential, '')
  }
})

test('DashScope audio and both Omni APIs use one explicit voice setting', () => {
  for (const model of [DEFAULT_DASHSCOPE_REALTIME_MODEL, 'qwen3.5-omni-plus-realtime', 'qwen3.8-omni-flash-realtime']) {
    assert.equal(resolveDashScopeRealtimeVoiceOverride(model, { QWEN_AUDIO_REALTIME_VOICE: 'chosen' }), 'chosen')
    assert.equal(resolveDashScopeRealtimeVoiceOverride(model, {
      QWEN_AUDIO_REALTIME_VOICE: '', QWEN_OMNI_REALTIME_VOICE: 'legacy',
    }), '')
  }
  assert.equal(resolveDashScopeRealtimeVoiceOverride('qwen3.5-omni-plus-realtime', { QWEN_OMNI_REALTIME_VOICE: 'legacy' }), 'legacy')
  assert.equal(resolveDashScopeRealtimeVoiceOverride(DEFAULT_DASHSCOPE_REALTIME_MODEL, { QWEN_OMNI_REALTIME_VOICE: 'legacy' }), '')
})

test('legacy workspace shortcut works; canonical URL takes precedence even when blank', () => {
  const env = { DASHSCOPE_WORKSPACE_ID: 'workspace-test' }
  assert.match(resolveRealtimeFrontendConfiguration(env).active.endpoint, /workspace-test\.cn-beijing/)
  assert.equal(resolveRealtimeFrontendConfiguration({ ...env, QWEN_AUDIO_REALTIME_URL: '' }).active.endpoint,
    'wss://dashscope.aliyuncs.com/api-ws/v1/realtime')
})

test('invalid model/provider combinations fail instead of guessing an API', () => {
  assert.throws(() => requireRealtimeFrontendConfiguration({
    QWEN_AUDIO_REALTIME_PROVIDER: 'stepfun', QWEN_AUDIO_REALTIME_API_KEY: 'key',
    QWEN_AUDIO_REALTIME_MODEL: DEFAULT_DASHSCOPE_REALTIME_MODEL,
  }), /QWEN_AUDIO_REALTIME_MODEL.*stepfun/)
})

test('provider switch between config sources clears all four connection fields', () => {
  const base = {
    QWEN_AUDIO_REALTIME_PROVIDER: 'dashscope', QWEN_AUDIO_REALTIME_API_KEY: 'dash-key',
    QWEN_AUDIO_REALTIME_MODEL: DEFAULT_DASHSCOPE_REALTIME_MODEL,
    QWEN_AUDIO_REALTIME_URL: 'wss://dash.example/realtime', QWEN_AUDIO_REALTIME_VOICE: 'dash-voice',
    OPENAI_API_KEY: 'backend-key',
  }
  const env = mergeRealtimeEnvironment(base, { QWEN_AUDIO_REALTIME_PROVIDER: 'stepfun' })
  const result = resolveRealtimeFrontendConfiguration(env)
  assert.equal(result.credential, '')
  assert.equal(result.active.model, DEFAULT_STEPFUN_REALTIME_MODEL)
  assert.equal(result.active.voice, '')
  assert.equal(result.active.endpoint, 'wss://api.stepfun.com/v1/realtime')
  assert.equal(env.OPENAI_API_KEY, 'backend-key')
  const same = resolveRealtimeFrontendConfiguration(mergeRealtimeEnvironment(base, {
    QWEN_AUDIO_REALTIME_PROVIDER: 'qwen', QWEN_AUDIO_REALTIME_VOICE: 'new-voice',
  }))
  assert.equal(same.credential, 'dash-key')
  assert.equal(same.active.voice, 'new-voice')
})

test('CLI respects file and process precedence with provider-scoped legacy fallback', t => {
  const paths = fixture(t)
  writeFileSync(paths.configPath, encode({
    QWEN_AUDIO_REALTIME_API_KEY: 'dash-key', QWEN_AUDIO_REALTIME_MODEL: DEFAULT_DASHSCOPE_REALTIME_MODEL,
    STEPFUN_API_KEY: 'step-key', OTHER_VALUE: 'user',
  }))
  writeFileSync(join(paths.root, '.env'), 'OTHER_VALUE=project\n')
  writeFileSync(join(paths.root, '.env.local'), 'QWEN_AUDIO_REALTIME_PROVIDER=stepfun\nOTHER_VALUE=local\n')
  const result = cliConfiguration(paths, { QWEN_AUDIO_REALTIME_VOICE: 'shell-voice' })
  assert.equal(result.credential, 'step-key')
  assert.equal(result.active.model, DEFAULT_STEPFUN_REALTIME_MODEL)
  assert.equal(result.active.voice, 'shell-voice')
  assert.equal(result.env.OTHER_VALUE, 'local')
  assert.deepEqual(result.loaded.loadedFiles, [join(paths.root, '.env.local'), join(paths.root, '.env'), paths.configPath])
})

test('higher-priority old key overrides lower-priority canonical key of same provider', () => {
  const env = mergeRealtimeEnvironment({ QWEN_AUDIO_REALTIME_API_KEY: 'file-key' }, { DASHSCOPE_API_KEY: 'shell-key' })
  assert.equal(resolveRealtimeFrontendConfiguration(env).credential, 'shell-key')
  const cleared = mergeRealtimeEnvironment(env, { QWEN_AUDIO_REALTIME_API_KEY: '', DASHSCOPE_API_KEY: 'ignored' })
  assert.equal(resolveRealtimeFrontendConfiguration(cleared).credential, '')
})

test('higher-priority legacy Omni voices use the merged model and support explicit clearing', () => {
  for (const original of [
    { QWEN_OMNI_REALTIME_VOICE: 'Ethan' },
    { QWEN_AUDIO_REALTIME_VOICE: 'Ethan' },
  ]) {
    const base = mergeRealtimeEnvironment({}, {
      QWEN_AUDIO_REALTIME_PROVIDER: 'dashscope',
      QWEN_AUDIO_REALTIME_MODEL: 'qwen3.5-omni-plus-realtime',
      ...original,
    })
    for (const voice of ['Chelsie', '']) {
      const merged = mergeRealtimeEnvironment(base, { QWEN_OMNI_REALTIME_VOICE: voice })
      assert.equal(realtimeSettingsFromEnvironment(merged).realtimeVoice, voice)
      assert.equal(realtimeSettingsFromEnvironment(mergeRealtimeEnvironment(merged, {})).realtimeVoice, voice)
    }
    for (const voice of ['canonical-voice', '']) {
      const merged = mergeRealtimeEnvironment(base, {
        QWEN_OMNI_REALTIME_VOICE: 'ignored', QWEN_AUDIO_REALTIME_VOICE: voice,
      })
      assert.equal(realtimeSettingsFromEnvironment(merged).realtimeVoice, voice)
    }
  }
})

test('legacy Omni voice stays model-scoped through source changes without erasing explicit voices', () => {
  const omni = mergeRealtimeEnvironment({}, {
    QWEN_AUDIO_REALTIME_MODEL: 'qwen3.5-omni-plus-realtime', QWEN_OMNI_REALTIME_VOICE: 'Ethan',
  })
  const audio = mergeRealtimeEnvironment(omni, { QWEN_AUDIO_REALTIME_MODEL: DEFAULT_DASHSCOPE_REALTIME_MODEL })
  assert.equal(realtimeSettingsFromEnvironment(audio).realtimeVoice, '')
  const backToOmni = mergeRealtimeEnvironment(audio, { QWEN_AUDIO_REALTIME_MODEL: 'qwen3.8-omni-flash-realtime' })
  assert.equal(realtimeSettingsFromEnvironment(backToOmni).realtimeVoice, 'Ethan')
  for (const voice of ['explicit-voice', '']) {
    const explicitAudio = mergeRealtimeEnvironment(audio, { QWEN_AUDIO_REALTIME_VOICE: voice })
    const updatedLegacy = mergeRealtimeEnvironment(explicitAudio, { QWEN_OMNI_REALTIME_VOICE: 'Chelsie' })
    assert.equal(realtimeSettingsFromEnvironment(updatedLegacy).realtimeVoice, voice)
    const explicitOmni = mergeRealtimeEnvironment(explicitAudio, { QWEN_AUDIO_REALTIME_MODEL: 'qwen3.5-omni-plus-realtime' })
    assert.equal(realtimeSettingsFromEnvironment(explicitOmni).realtimeVoice, voice)
  }
})

test('CLI resolves legacy Omni voices after all file and process sources have merged', t => {
  const paths = fixture(t)
  writeFileSync(paths.configPath, encode({
    QWEN_AUDIO_REALTIME_MODEL: 'qwen3.5-omni-plus-realtime', QWEN_AUDIO_REALTIME_VOICE: 'Ethan',
  }))
  writeFileSync(join(paths.root, '.env'), 'QWEN_OMNI_REALTIME_VOICE=Chelsie\n')
  writeFileSync(join(paths.root, '.env.local'), 'OTHER_VALUE=local\n')
  assert.equal(cliConfiguration(paths).active.voice, 'Chelsie')
  assert.equal(cliConfiguration(paths, { QWEN_OMNI_REALTIME_VOICE: '' }).active.voice, '')
  assert.equal(cliConfiguration(paths, { QWEN_AUDIO_REALTIME_MODEL: DEFAULT_DASHSCOPE_REALTIME_MODEL }).active.voice, '')
  assert.equal(cliConfiguration(paths, {
    QWEN_AUDIO_REALTIME_MODEL: DEFAULT_DASHSCOPE_REALTIME_MODEL, QWEN_AUDIO_REALTIME_VOICE: 'audio-voice',
  }).active.voice, 'audio-voice')
})

test('Desktop readiness and child configuration agree when saved provider replaces environment', t => {
  const paths = fixture(t)
  const env = {
    QWEN_AUDIO_REALTIME_PROVIDER: 'dashscope', QWEN_AUDIO_REALTIME_API_KEY: 'stale-dash',
    QWEN_AUDIO_REALTIME_MODEL: DEFAULT_DASHSCOPE_REALTIME_MODEL,
  }
  const configured = { QWEN_AUDIO_REALTIME_PROVIDER: 'stepfun', QWEN_AUDIO_REALTIME_API_KEY: 'saved-step' }
  writeFileSync(paths.configPath, encode(configured))
  const store = createSettingsStore({ ...paths, env })
  assert.equal(store.status().provider, 'stepfun')
  assert.equal(store.ready(), true)
  assert.equal(store.load().realtimeApiKey, 'saved-step')
  const child = resolveRealtimeFrontendConfiguration(desktopGatewayEnvironment({ env, configured }))
  assert.equal(child.credential, 'saved-step')
  assert.equal(child.active.model, DEFAULT_STEPFUN_REALTIME_MODEL)
})

test('Desktop saves only the active connection and does not overwrite backend keys', t => {
  const paths = fixture(t)
  writeFileSync(paths.configPath, encode({ DASHSCOPE_API_KEY: 'backend-key' }))
  const store = createSettingsStore({ ...paths, env: {} })
  assert.equal(store.load().realtimeApiKey, 'backend-key')
  store.save({ realtimeProvider: 'stepfun', realtimeApiKey: 'frontend-step' })
  const saved = parseEnv(readFileSync(paths.configPath, 'utf8'))
  assert.equal(saved.DASHSCOPE_API_KEY, 'backend-key')
  assert.equal(saved.QWEN_AUDIO_REALTIME_API_KEY, 'frontend-step')
  assert.equal(saved.QWEN_AUDIO_REALTIME_MODEL, DEFAULT_STEPFUN_REALTIME_MODEL)
  const reopened = createSettingsStore({ ...paths, env: {} })
  assert.equal(reopened.load().realtimeApiKey, 'frontend-step')
  reopened.save({ realtimeApiKey: '' })
  assert.equal(cliConfiguration(paths).credential, '')
  assert.equal(reopened.ready(), false)
})

test('generated template exposes the required key without masking higher-priority shell credentials', t => {
  const paths = fixture(t)
  const env = {
    QWAUDIO_CONFIG_DIR: paths.configDir, QWAUDIO_DATA_DIR: join(paths.root, 'data'),
    QWAUDIO_STATE_DIR: join(paths.root, 'state'), QWAUDIO_CACHE_DIR: join(paths.root, 'cache'),
    QWAUDIO_WORKSPACE: join(paths.root, 'workspace'), DASHSCOPE_API_KEY: 'shell-key',
  }
  loadRuntimeEnvironment({ root: paths.root, env, generateSecret: false, prepareBackendRuntime: false })
  const content = readFileSync(paths.configPath, 'utf8')
  assert.match(content, /^QWEN_AUDIO_REALTIME_API_KEY=$/m)
  const generated = parseEnv(content)
  const frontendDefaults = realtimeRuntimeEnvironment()
  assert.deepEqual(Object.fromEntries(Object.keys(frontendDefaults).map(key => [key, generated[key]])), frontendDefaults)
  assert.equal(generated.QWEN_AUDIO_AGENT_BACKEND_PERMISSION_MODE, 'native')
  assert.equal(generated.QWEN_AUDIO_MEMORY_PROVIDER, 'markdown')
  assert.equal(generated.QWEN_AUDIO_LOG_LEVEL, 'info')
  assert.equal(generated.QWEN_AUDIO_LOG_MAX_BYTES, '10485760')
  assert.equal(generated.QWEN_AUDIO_LOG_MAX_FILES, '5')
  assert.equal(generated.VOICEMEM_PYTHON, undefined, 'optional integration examples must not become active paths')
  assert.equal(generated.QWEN_AUDIO_GATEWAY_LAN, undefined, 'generating defaults must not enable remote access')
  assert.equal(generated.QWEN_AUDIO_GATEWAY_TAILNET, undefined)
  assert.match(content, /音色留空跟随模型/)
  assert.equal(cliConfiguration(paths).active.configured, false)
  assert.equal(cliConfiguration(paths, { DASHSCOPE_API_KEY: 'shell-key' }).credential, 'shell-key')
  assert.equal(cliConfiguration(paths, { QWEN_AUDIO_REALTIME_API_KEY: 'new-shell-key' }).credential, 'new-shell-key')
  for (const provider of REALTIME_PROVIDERS) {
    const selected = cliConfiguration(paths, { QWEN_AUDIO_REALTIME_PROVIDER: provider.key, QWEN_AUDIO_REALTIME_API_KEY: 'test-key' })
    assert.equal(selected.active.model, provider.settings.find(field => field.slot === 'model')?.default || null)
    assert.equal(selected.active.endpoint, provider.settings.find(field => field.slot === 'endpoint').default)
  }
  assert.equal(readFileSync(paths.configPath, 'utf8'), content, 'loading overrides must not rewrite visible defaults')
})
