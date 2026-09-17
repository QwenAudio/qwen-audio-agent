import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseEnv } from 'node:util'
import test from 'node:test'
import {
  mergeRealtimeEnvironment,
  realtimeCredentialFromEnvironment,
  realtimeRuntimeEnvironment,
  realtimeSettingsFromEnvironment,
} from '../shared/realtime-provider-definitions.mjs'
import {
  DEFAULT_DASHSCOPE_REALTIME_MODEL,
  DEFAULT_STEPFUN_REALTIME_MODEL,
  resolveDashScopeRealtimeVoiceOverride,
  resolveRealtimeFrontendConfiguration,
} from '../shared/realtime-provider-catalog.mjs'
import { loadRuntimeEnvironment, requireRealtimeFrontendConfiguration } from '../shared/runtime-environment.mjs'
import { createSettingsStore } from '../desktop/src/settings-store.mjs'
import { desktopGatewayEnvironment } from '../desktop/src/gateway-process.mjs'

const providerCases = [
  {
    provider: 'dashscope',
    env: { DASHSCOPE_API_KEY: 'dash-key', QWEN_AUDIO_REALTIME_BASE_URL: 'wss://dash.example/realtime' },
    credential: 'dash-key', endpoint: 'wss://dash.example/realtime',
    model: DEFAULT_DASHSCOPE_REALTIME_MODEL, voice: '',
  },
  {
    provider: 'stepfun',
    env: {
      STEPFUN_API_KEY: 'step-key', STEPFUN_REALTIME_URL: 'wss://step.example/realtime',
      STEPFUN_REALTIME_MODEL: DEFAULT_STEPFUN_REALTIME_MODEL, STEPFUN_REALTIME_VOICE: 'step-voice',
      DASHSCOPE_API_KEY: 'not-the-stepfun-key',
    },
    credential: 'step-key', endpoint: 'wss://step.example/realtime',
    model: DEFAULT_STEPFUN_REALTIME_MODEL, voice: 'step-voice',
  },
  {
    provider: 'speech-to-speech',
    env: { SPEECH_TO_SPEECH_AUTH_TOKEN: 's2s-key', SPEECH_TO_SPEECH_REALTIME_URL: 'ws://s2s.example/realtime' },
    credential: 's2s-key', endpoint: 'ws://s2s.example/realtime', model: null, voice: '',
  },
  {
    provider: 'minicpm-o',
    env: { MINICPM_O_AUTH_TOKEN: 'mini-key', MINICPM_O_REALTIME_URL: 'ws://mini.example/realtime?mode=audio' },
    credential: 'mini-key', endpoint: 'ws://mini.example/realtime?mode=audio', model: null, voice: '',
  },
]

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'qwaudio-provider-env-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const configDir = join(root, 'config')
  mkdirSync(configDir)
  return { root, configDir, configPath: join(configDir, 'config.env'), clientDir: join(root, 'desktop') }
}

function encode(env) {
  return Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\n') + '\n'
}

function cliConfiguration({ root, configDir }, overrides = {}) {
  const env = { QWAUDIO_CONFIG_DIR: configDir, ...overrides }
  const loaded = loadRuntimeEnvironment({ root, env, readOnly: true })
  return { env, loaded, ...resolveRealtimeFrontendConfiguration(env) }
}

for (const entry of providerCases) {
  test(`${entry.provider}: provider-owned inputs round-trip without changing the active profile`, () => {
    const env = { ...entry.env, QWEN_AUDIO_REALTIME_PROVIDER: entry.provider }
    const result = resolveRealtimeFrontendConfiguration(env)
    assert.equal(result.credential, entry.credential)
    assert.equal(result.active.endpoint, entry.endpoint)
    assert.equal(result.active.model, entry.model)
    assert.equal(result.active.voice, entry.voice)
    assert.equal(result.active.configured, true)
    assert.equal(realtimeCredentialFromEnvironment(env), entry.credential)
    assert.equal(Object.hasOwn(result.active, 'credential'), false)
    const unified = realtimeRuntimeEnvironment(realtimeSettingsFromEnvironment(env))
    assert.deepEqual(resolveRealtimeFrontendConfiguration(unified), result)
  })

  test(`${entry.provider}: removed global overrides are ignored and own credentials can be cleared`, () => {
    const keys = { dashscope: 'DASHSCOPE_API_KEY', stepfun: 'STEPFUN_API_KEY', 'speech-to-speech': 'SPEECH_TO_SPEECH_AUTH_TOKEN', 'minicpm-o': 'MINICPM_O_AUTH_TOKEN' }
    const env = {
      ...entry.env, QWEN_AUDIO_REALTIME_PROVIDER: entry.provider,
      QWEN_AUDIO_REALTIME_API_KEY: 'must-not-use',
      QWEN_AUDIO_REALTIME_ENDPOINT: 'wss://must-not-use.example/realtime',
    }
    assert.equal(resolveRealtimeFrontendConfiguration(env).credential, entry.credential)
    assert.equal(resolveRealtimeFrontendConfiguration(env).active.endpoint, entry.endpoint)
    env[keys[entry.provider]] = ''
    assert.equal(resolveRealtimeFrontendConfiguration(env).credential, '')
    assert.equal(realtimeCredentialFromEnvironment(env), '')
  })
}

test('legacy DashScope key works without a provider setting and supports endpoint aliases', () => {
  const result = resolveRealtimeFrontendConfiguration({
    DASHSCOPE_API_KEY: 'legacy-key', QWEN_AUDIO_REALTIME_URL: 'wss://legacy.example/realtime',
  })
  assert.equal(result.active.provider, 'dashscope')
  assert.equal(result.active.configured, true)
  assert.equal(result.active.endpoint, 'wss://legacy.example/realtime')
  assert.equal(resolveRealtimeFrontendConfiguration({
    QWEN_AUDIO_REALTIME_PROVIDER: 'qwen', DASHSCOPE_API_KEY: 'legacy-key',
  }).credential, 'legacy-key')
})

test('provider credentials are never borrowed by another provider', () => {
  for (const provider of ['stepfun', 'speech-to-speech', 'minicpm-o']) {
    assert.equal(resolveRealtimeFrontendConfiguration({
      QWEN_AUDIO_REALTIME_PROVIDER: provider, DASHSCOPE_API_KEY: 'dash-only',
    }).credential, '')
  }
  assert.equal(resolveRealtimeFrontendConfiguration({ STEPFUN_API_KEY: 'step-only' }).credential, '')
})

test('Omni voice is family-scoped and an empty Audio voice does not override it', () => {
  const env = { QWEN_OMNI_REALTIME_VOICE: 'legacy-omni' }
  assert.equal(resolveDashScopeRealtimeVoiceOverride(DEFAULT_DASHSCOPE_REALTIME_MODEL, env), '')
  assert.equal(resolveDashScopeRealtimeVoiceOverride('qwen3.5-omni-plus-realtime', env), 'legacy-omni')
  assert.equal(resolveRealtimeFrontendConfiguration({
    ...env, QWEN_AUDIO_REALTIME_MODEL: 'qwen3.5-omni-plus-realtime',
  }).active.voice, 'legacy-omni')
  assert.equal(resolveDashScopeRealtimeVoiceOverride('qwen3.5-omni-plus-realtime', {
    ...env, QWEN_AUDIO_REALTIME_VOICE: '',
  }), 'legacy-omni')
})

test('S2S aliases are supported without overriding explicitly cleared primary variables', () => {
  const env = {
    QWEN_AUDIO_REALTIME_PROVIDER: 's2s',
    S2S_REALTIME_URL: 'ws://alias.example/realtime', S2S_API_KEY: 'alias-key',
  }
  assert.equal(resolveRealtimeFrontendConfiguration(env).credential, 'alias-key')
  assert.equal(resolveRealtimeFrontendConfiguration(env).active.endpoint, 'ws://alias.example/realtime')
  assert.equal(resolveRealtimeFrontendConfiguration({ ...env, SPEECH_TO_SPEECH_AUTH_TOKEN: '' }).credential, '')
})

test('invalid provider-owned models are rejected without consulting another provider', () => {
  assert.throws(() => requireRealtimeFrontendConfiguration({
    QWEN_AUDIO_REALTIME_PROVIDER: 'stepfun',
    QWEN_AUDIO_REALTIME_MODEL: DEFAULT_DASHSCOPE_REALTIME_MODEL,
    STEPFUN_REALTIME_MODEL: DEFAULT_DASHSCOPE_REALTIME_MODEL,
    STEPFUN_API_KEY: 'step-key',
  }), /STEPFUN_REALTIME_MODEL.*stepfun/)
})

test('explicit provider-owned fields supersede inactive draft fallbacks', () => {
  const env = { DASHSCOPE_API_KEY: 'dash-key', STEPFUN_API_KEY: 'step-key' }
  assert.equal(realtimeSettingsFromEnvironment(env).stepfunApiKey, 'step-key')
  assert.equal(realtimeSettingsFromEnvironment(env, { stepfunApiKey: '' }).stepfunApiKey, 'step-key')
  assert.equal(realtimeSettingsFromEnvironment(env, { stepfunApiKey: 'saved-step-key' }).stepfunApiKey, 'step-key')
})

test('CLI migrates each file before applying a provider-only project selection', t => {
  const paths = fixture(t)
  writeFileSync(paths.configPath, encode({
    QWEN_AUDIO_REALTIME_PROVIDER: 'dashscope',
    QWEN_AUDIO_REALTIME_API_KEY: 'dash-unified',
    QWEN_AUDIO_REALTIME_ENDPOINT: 'wss://dash.example/realtime',
    QWEN_AUDIO_REALTIME_MODEL: DEFAULT_DASHSCOPE_REALTIME_MODEL,
    QWEN_AUDIO_REALTIME_VOICE: 'dash-voice',
    STEPFUN_API_KEY: 'step-key', STEPFUN_REALTIME_VOICE: 'step-voice',
    OTHER_VALUE: 'user-config',
  }))
  writeFileSync(join(paths.root, '.env'), 'OTHER_VALUE=project-env\n')
  writeFileSync(join(paths.root, '.env.local'), 'QWEN_AUDIO_REALTIME_PROVIDER=stepfun\nOTHER_VALUE=project-local\n')
  const result = cliConfiguration(paths, { PROCESS_ONLY: 'keep' })
  assert.equal(result.active.provider, 'stepfun')
  assert.equal(result.active.model, DEFAULT_STEPFUN_REALTIME_MODEL)
  assert.equal(result.active.endpoint, 'wss://api.stepfun.com/v1/realtime')
  assert.equal(result.active.voice, 'step-voice')
  assert.equal(result.credential, 'step-key')
  assert.equal(result.env.QWEN_AUDIO_REALTIME_API_KEY, undefined)
  assert.equal(result.env.DASHSCOPE_API_KEY, 'dash-unified')
  assert.equal(result.env.OTHER_VALUE, 'project-local')
  assert.equal(result.env.PROCESS_ONLY, 'keep')
  assert.deepEqual(result.loaded.loadedFiles, [join(paths.root, '.env.local'), join(paths.root, '.env'), paths.configPath])
})

test('CLI process provider overrides are isolated while same-provider partial overrides inherit', t => {
  const paths = fixture(t)
  writeFileSync(paths.configPath, encode({
    QWEN_AUDIO_REALTIME_PROVIDER: 'dashscope',
    QWEN_AUDIO_REALTIME_API_KEY: 'dash-key',
    QWEN_AUDIO_REALTIME_MODEL: DEFAULT_DASHSCOPE_REALTIME_MODEL,
    STEPFUN_API_KEY: 'step-key',
  }))
  const switched = cliConfiguration(paths, { QWEN_AUDIO_REALTIME_PROVIDER: 'stepfun' })
  assert.equal(switched.credential, 'step-key')
  assert.equal(switched.active.model, DEFAULT_STEPFUN_REALTIME_MODEL)
  const same = cliConfiguration(paths, {
    QWEN_AUDIO_REALTIME_PROVIDER: 'qwen', QWEN_AUDIO_REALTIME_VOICE: 'process-voice',
  })
  assert.equal(same.credential, 'dash-key')
  assert.equal(same.active.voice, 'process-voice')
  assert.equal(same.active.model, DEFAULT_DASHSCOPE_REALTIME_MODEL)
})

test('Desktop readiness and child configuration agree when saved provider replaces stale environment', t => {
  const paths = fixture(t)
  const env = {
    QWEN_AUDIO_REALTIME_PROVIDER: 'dashscope',
    QWEN_AUDIO_REALTIME_MODEL: DEFAULT_DASHSCOPE_REALTIME_MODEL,
    QWEN_AUDIO_REALTIME_API_KEY: 'stale-dash-key',
  }
  const configured = { QWEN_AUDIO_REALTIME_PROVIDER: 'stepfun', STEPFUN_API_KEY: 'saved-step-key' }
  writeFileSync(paths.configPath, encode(configured))
  const store = createSettingsStore({ ...paths, env })
  assert.equal(store.status().provider, 'stepfun')
  assert.equal(store.ready(), true)
  assert.equal(store.load().stepfunApiKey, 'saved-step-key')
  const child = resolveRealtimeFrontendConfiguration(desktopGatewayEnvironment({ env, configured }))
  assert.equal(child.credential, 'saved-step-key')
  assert.equal(child.active.model, DEFAULT_STEPFUN_REALTIME_MODEL)
})

test('Desktop imports old providers and preserves credentials through save, restart, switch and clear', t => {
  const paths = fixture(t)
  writeFileSync(paths.configPath, encode({
    QWEN_AUDIO_REALTIME_PROVIDER: 'dashscope',
    DASHSCOPE_API_KEY: 'legacy-dash-key',
    QWEN_AUDIO_REALTIME_BASE_URL: 'wss://dash.example/realtime',
    STEPFUN_API_KEY: 'legacy-step-key',
    STEPFUN_REALTIME_URL: 'wss://step.example/realtime',
    STEPFUN_REALTIME_MODEL: DEFAULT_STEPFUN_REALTIME_MODEL,
    STEPFUN_REALTIME_VOICE: 'legacy-step-voice',
  }))
  const store = createSettingsStore({ ...paths, env: {} })
  assert.equal(store.ready(), true)
  assert.equal(store.load().stepfunApiKey, 'legacy-step-key')
  store.save({ realtimeProvider: 'stepfun' })
  const cli = cliConfiguration(paths)
  assert.equal(cli.credential, 'legacy-step-key')
  assert.equal(cli.active.endpoint, 'wss://step.example/realtime')
  assert.equal(cli.active.voice, 'legacy-step-voice')
  assert.equal(parseEnv(readFileSync(paths.configPath, 'utf8')).DASHSCOPE_API_KEY, 'legacy-dash-key')
  store.save({ stepfunApiKey: '' })
  store.save({ realtimeProvider: 'dashscope' })
  const reopened = createSettingsStore({ ...paths, env: {} })
  assert.equal(reopened.load().stepfunApiKey, '')
  assert.equal(cliConfiguration(paths).credential, 'legacy-dash-key')
  reopened.save({ realtimeProvider: 'stepfun' })
  assert.equal(reopened.ready(), false)
  assert.equal(cliConfiguration(paths).credential, '')
})

test('generated templates do not mask legacy credentials on subsequent launches', t => {
  const paths = fixture(t)
  const env = {
    QWAUDIO_CONFIG_DIR: paths.configDir,
    QWAUDIO_DATA_DIR: join(paths.root, 'data'),
    QWAUDIO_STATE_DIR: join(paths.root, 'state'),
    QWAUDIO_CACHE_DIR: join(paths.root, 'cache'),
    QWAUDIO_WORKSPACE: join(paths.root, 'workspace'),
    DASHSCOPE_API_KEY: 'shell-dash-key',
  }
  loadRuntimeEnvironment({ root: paths.root, env, generateSecret: false, prepareBackendRuntime: false })
  assert.equal(parseEnv(readFileSync(paths.configPath, 'utf8')).QWEN_AUDIO_REALTIME_API_KEY, undefined)
  assert.equal(cliConfiguration(paths, env).credential, 'shell-dash-key')
})

test('merging a provider switch retains provider-owned variables and explicit blanks', () => {
  const env = mergeRealtimeEnvironment({
    QWEN_AUDIO_REALTIME_PROVIDER: 'dashscope',
    QWEN_AUDIO_REALTIME_API_KEY: 'dash-key',
    STEPFUN_API_KEY: 'step-key',
  }, { QWEN_AUDIO_REALTIME_PROVIDER: 'stepfun', STEPFUN_API_KEY: '' })
  assert.equal(env.STEPFUN_API_KEY, '')
  assert.equal(resolveRealtimeFrontendConfiguration(env).credential, '')
})
