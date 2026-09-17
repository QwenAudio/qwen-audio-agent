import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseEnv } from 'node:util'
import test from 'node:test'
import { createSettingsStore } from '../src/settings-store.mjs'
import { desktopGatewayEnvironment } from '../src/gateway-process.mjs'
import { updateSettingsContent } from '../src/settings-config.mjs'
import { resolveRealtimeFrontendConfiguration } from '../../shared/realtime-provider-catalog.mjs'
import { requireRealtimeFrontendConfiguration } from '../../shared/runtime-environment.mjs'
import { updateRealtimeModelConfig } from '../../cli/src/config-command.mjs'
import { assertGatewaySetup, gatewaySetupStatus } from '../../shared/gateway/setup.mjs'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'qwaudio-realtime-lifecycle-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const env = {}
  const options = { configDir: join(root, 'config'), clientDir: join(root, 'desktop'), env }
  return { root, env, options, store: createSettingsStore(options) }
}

// An independent Node process loads the actual persisted config exactly as
// the CLI does, without the Desktop process's just-saved environment.
function cliConfiguration(root, configDir) {
  const source = `
    import { loadRuntimeEnvironment, requireRealtimeFrontendConfiguration } from ${JSON.stringify(new URL('../../shared/runtime-environment.mjs', import.meta.url).href)};
    import { resolveRealtimeFrontendConfiguration } from ${JSON.stringify(new URL('../../shared/realtime-provider-catalog.mjs', import.meta.url).href)};
    const env = { QWAUDIO_CONFIG_DIR: ${JSON.stringify(configDir)} };
    loadRuntimeEnvironment({ root: ${JSON.stringify(root)}, env, readOnly: true });
    requireRealtimeFrontendConfiguration(env);
    process.stdout.write(JSON.stringify(resolveRealtimeFrontendConfiguration(env)));
  `
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8' }))
}

const drafts = {
  realtimeProvider: 'dashscope',
  dashscopeApiKey: 'dashscope-test-key',
  realtimeModel: 'qwen-audio-3.0-realtime-plus',
  realtimeBaseUrl: 'wss://dashscope.example/realtime',
  audioRealtimeVoice: 'audio-test-voice',
  omniRealtimeVoice: 'omni-test-voice',
  stepfunApiKey: 'stepfun-test-key',
  stepfunRealtimeModel: 'stepaudio-3-realtime-preview',
  stepfunRealtimeUrl: 'wss://stepfun.example/realtime',
  stepfunRealtimeVoice: 'stepfun-test-voice',
}

test('Desktop save, restart and independent CLI startup use the same complete active profile', t => {
  const { root, env, options, store } = fixture(t)
  store.save(drafts)
  const staleEnvironment = { ...env, DASHSCOPE_API_KEY: 'backend-only-dashscope-key' }
  store.save({ realtimeProvider: 'stepfun' })
  const raw = readFileSync(store.path, 'utf8')
  const persisted = parseEnv(raw)
  assert.equal(persisted.STEPFUN_REALTIME_MODEL, drafts.stepfunRealtimeModel)
  assert.equal(persisted.STEPFUN_API_KEY, drafts.stepfunApiKey)
  assert.equal(persisted.STEPFUN_REALTIME_URL, drafts.stepfunRealtimeUrl)
  assert.equal(persisted.STEPFUN_REALTIME_VOICE, drafts.stepfunRealtimeVoice)
  assert.doesNotMatch(raw, /QWEN_AUDIO_REALTIME_(API_KEY|ENDPOINT)=/)
  assert.equal(persisted.DASHSCOPE_API_KEY, drafts.dashscopeApiKey)
  assert.equal(persisted.QWEN_AUDIO_REALTIME_MODEL, drafts.realtimeModel)
  assert.equal(persisted.QWEN_OMNI_REALTIME_VOICE, drafts.omniRealtimeVoice)

  const restarted = createSettingsStore({ ...options, env: {} })
  assert.deepEqual(restarted.load(), store.load())
  assert.equal(restarted.load().realtimeModel, drafts.realtimeModel)
  assert.equal(restarted.load().omniRealtimeVoice, drafts.omniRealtimeVoice)
  const desktop = resolveRealtimeFrontendConfiguration(desktopGatewayEnvironment({
    env: staleEnvironment, configured: { ...persisted, DASHSCOPE_API_KEY: 'backend-only-dashscope-key' },
  }))
  const cli = cliConfiguration(root, options.configDir)
  assert.equal(cli.active.model, drafts.stepfunRealtimeModel)
  assert.equal(cli.credential, drafts.stepfunApiKey)
  assert.equal(cli.active.signature, desktop.active.signature)
  assert.equal(cli.active.signature, resolveRealtimeFrontendConfiguration(env).active.signature)

  const profiles = JSON.parse(readFileSync(store.realtimeProfilesPath, 'utf8'))
  assert.equal(profiles.activeProvider, 'stepfun')
  assert.equal(profiles.profiles.stepfun.model, drafts.stepfunRealtimeModel)
  assert.equal(profiles.profiles.dashscope.model, drafts.realtimeModel)
  if (process.platform !== 'win32') assert.equal(statSync(store.realtimeProfilesPath).mode & 0o777, 0o600)

  restarted.save({ realtimeProvider: 'dashscope' })
  const qwen = cliConfiguration(root, options.configDir)
  assert.equal(qwen.active.model, drafts.realtimeModel)
  assert.equal(qwen.credential, drafts.dashscopeApiKey)
  assert.equal(qwen.active.voice, drafts.audioRealtimeVoice)
})

test('client preferences and inactive draft edits do not reset the active runtime profile', t => {
  const { root, env, options, store } = fixture(t)
  store.save({ ...drafts, realtimeProvider: 'stepfun' })
  const signature = resolveRealtimeFrontendConfiguration(env).active.signature
  const content = readFileSync(store.path, 'utf8')
  store.save({ language: 'en' })
  assert.equal(readFileSync(store.path, 'utf8'), content)
  assert.equal(resolveRealtimeFrontendConfiguration(env).active.signature, signature)
  store.save({ realtimeModel: 'qwen3.5-omni-plus-realtime', dashscopeApiKey: 'next-qwen-key' })
  assert.equal(cliConfiguration(root, options.configDir).active.signature, signature)
  assert.equal(createSettingsStore({ ...options, env: {} }).load().dashscopeApiKey, 'next-qwen-key')
})

test('service-owned profiles ignore other providers without erasing their settings', t => {
  const { root, env, options, store } = fixture(t)
  store.save(drafts)
  const staleEnvironment = { ...env }
  store.save({ realtimeProvider: 'speech-to-speech' })
  const persisted = parseEnv(readFileSync(store.path, 'utf8'))
  assert.equal(persisted.SPEECH_TO_SPEECH_AUTH_TOKEN, '')
  assert.equal(persisted.QWEN_AUDIO_REALTIME_MODEL, drafts.realtimeModel)
  assert.equal(persisted.DASHSCOPE_API_KEY, drafts.dashscopeApiKey)
  const desktop = resolveRealtimeFrontendConfiguration(desktopGatewayEnvironment({ env: staleEnvironment, configured: persisted }))
  assert.equal(desktop.credential, '')
  assert.equal(desktop.active.model, null)
  assert.equal(desktop.active.signature, cliConfiguration(root, options.configDir).active.signature)
})

test('partial updates keep the selected provider and explicitly clear its credential', t => {
  const { env, options, store } = fixture(t)
  store.save({ ...drafts, realtimeProvider: 'stepfun' })
  store.save({ stepfunApiKey: '', stepfunRealtimeVoice: '' })
  const persisted = parseEnv(readFileSync(store.path, 'utf8'))
  assert.equal(persisted.QWEN_AUDIO_REALTIME_PROVIDER, 'stepfun')
  assert.equal(persisted.STEPFUN_API_KEY, '')
  assert.equal(persisted.STEPFUN_REALTIME_VOICE, '')
  assert.equal(env.STEPFUN_API_KEY, '')
  assert.equal(createSettingsStore({ ...options, env: {} }).ready(), false)
})

test('family voice drafts survive model changes and subsequent CLI model edits', t => {
  const { root, options, store } = fixture(t)
  store.save(drafts)
  store.save({ realtimeModel: 'qwen3.5-omni-plus-realtime' })
  assert.equal(cliConfiguration(root, options.configDir).active.voice, drafts.omniRealtimeVoice)
  const restarted = createSettingsStore({ ...options, env: {} })
  restarted.save({ realtimeModel: drafts.realtimeModel })
  assert.equal(cliConfiguration(root, options.configDir).active.voice, drafts.audioRealtimeVoice)
  updateRealtimeModelConfig(store.path, 'qwen-audio-3.0-realtime-flash')
  const reopened = createSettingsStore({ ...options, env: {} })
  assert.equal(reopened.load().realtimeModel, 'qwen-audio-3.0-realtime-flash')
  reopened.save({ realtimeProvider: 'stepfun' })
  reopened.save({ realtimeProvider: 'dashscope' })
  assert.equal(cliConfiguration(root, options.configDir).active.model, 'qwen-audio-3.0-realtime-flash')
})

test('runtime writes deduplicate all active assignments', () => {
  const content = updateSettingsContent('QWEN_AUDIO_REALTIME_MODEL=old\nQWEN_AUDIO_REALTIME_MODEL=stale\n', {
    ...drafts, realtimeProvider: 'stepfun',
  })
  assert.equal(content.match(/^QWEN_AUDIO_REALTIME_MODEL=/gm).length, 1)
  assert.equal(parseEnv(content).QWEN_AUDIO_REALTIME_MODEL, drafts.realtimeModel)
})

test('rejects a mixed provider and model before starting a Gateway', () => {
  const env = {
    QWEN_AUDIO_REALTIME_PROVIDER: 'stepfun',
    STEPFUN_REALTIME_MODEL: drafts.realtimeModel,
    STEPFUN_API_KEY: 'private-key',
  }
  const status = gatewaySetupStatus(env)
  assert.equal(status.ready, false)
  assert.equal(status.missing[0].key, 'STEPFUN_REALTIME_MODEL')
  assert.throws(() => assertGatewaySetup(env), /STEPFUN_REALTIME_MODEL.*stepfun/)
  assert.throws(() => requireRealtimeFrontendConfiguration(env), error => {
    assert.match(error.message, /STEPFUN_REALTIME_MODEL.*stepfun/)
    assert.doesNotMatch(error.message, /private-key/)
    return true
  })
})
