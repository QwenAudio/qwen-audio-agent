import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseEnv } from 'node:util'
import test from 'node:test'
import { createSettingsStore } from '../src/settings-store.mjs'
import { desktopGatewayEnvironment } from '../src/gateway-process.mjs'
import { updateSettingsContent } from '../src/settings-config.mjs'
import { resolveRealtimeFrontendConfiguration } from '../../shared/realtime-provider-catalog.mjs'
import { REALTIME_PROVIDERS, realtimeSettingsValues } from '../../shared/realtime-provider-definitions.mjs'
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

// A separate process reads the same persisted configuration as CLI startup.
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

for (const provider of REALTIME_PROVIDERS) {
  test(`${provider.key}: desktop save, restart and CLI use one active connection`, t => {
    const { root, env, options, store } = fixture(t)
    const selected = { ...realtimeSettingsValues({ realtimeProvider: provider.key }), realtimeApiKey: `${provider.key}-test-key` }
    store.save(selected)
    const persisted = parseEnv(readFileSync(store.path, 'utf8'))
    assert.deepEqual(Object.keys(persisted).sort(), [
      'QWEN_AUDIO_REALTIME_API_KEY', 'QWEN_AUDIO_REALTIME_MODEL', 'QWEN_AUDIO_REALTIME_PROVIDER',
      'QWEN_AUDIO_REALTIME_URL', 'QWEN_AUDIO_REALTIME_VOICE',
    ])
    const restarted = createSettingsStore({ ...options, env: {} })
    assert.deepEqual(restarted.load(), store.load())
    const desktop = resolveRealtimeFrontendConfiguration(desktopGatewayEnvironment({ env, configured: persisted }))
    const cli = cliConfiguration(root, options.configDir)
    assert.equal(cli.active.provider, provider.key)
    assert.equal(cli.credential, selected.realtimeApiKey)
    assert.equal(cli.active.signature, desktop.active.signature)
    assert.equal(cli.active.signature, resolveRealtimeFrontendConfiguration(env).active.signature)
    assert.equal(existsSync(join(options.configDir, 'realtime-profiles.json')), false)
    if (process.platform !== 'win32') assert.equal(statSync(store.path).mode & 0o777, 0o600)
  })
}

test('provider-only switches reset connection data rather than reuse a different provider secret', t => {
  const { store, env, options } = fixture(t)
  store.save({ realtimeProvider: 'dashscope', realtimeApiKey: 'secret', realtimeVoice: 'custom', realtimeUrl: 'wss://private.example/realtime' })
  const preview = store.preview({ realtimeProvider: 'stepfun' })
  assert.equal(preview.realtimeApiKey, '')
  assert.equal(preview.realtimeUrl, 'wss://api.stepfun.com/v1/realtime')
  assert.equal(preview.realtimeVoice, '')
  store.save({ realtimeProvider: 'stepfun' })
  assert.equal(env.QWEN_AUDIO_REALTIME_API_KEY, '')
  assert.equal(createSettingsStore({ ...options, env: {} }).ready(), false)
  store.save({ realtimeProvider: 'speech-to-speech' })
  assert.equal(store.load().realtimeModel, '')
  assert.equal(store.load().realtimeVoice, '')
  assert.equal(store.ready(), true)
})

test('client preferences do not rewrite or reset the active connection', t => {
  const { store, env } = fixture(t)
  store.save({ realtimeProvider: 'stepfun', realtimeApiKey: 'test-key' })
  const signature = resolveRealtimeFrontendConfiguration(env).active.signature
  const content = readFileSync(store.path, 'utf8')
  store.save({ language: 'en' })
  assert.equal(readFileSync(store.path, 'utf8'), content)
  assert.equal(resolveRealtimeFrontendConfiguration(env).active.signature, signature)
})

test('partial updates retain provider and explicitly clear credential and voice', t => {
  const { env, options, store } = fixture(t)
  store.save({ realtimeProvider: 'stepfun', realtimeApiKey: 'test-key', realtimeVoice: 'custom' })
  store.save({ realtimeApiKey: '', realtimeVoice: '' })
  const persisted = parseEnv(readFileSync(store.path, 'utf8'))
  assert.equal(persisted.QWEN_AUDIO_REALTIME_PROVIDER, 'stepfun')
  assert.equal(persisted.QWEN_AUDIO_REALTIME_API_KEY, '')
  assert.equal(persisted.QWEN_AUDIO_REALTIME_VOICE, '')
  assert.equal(env.QWEN_AUDIO_REALTIME_API_KEY, '')
  assert.equal(createSettingsStore({ ...options, env: {} }).ready(), false)
})

test('CLI model edits are visible in the desktop without a second profile store', t => {
  const { root, options, store } = fixture(t)
  store.save({ realtimeApiKey: 'test-key' })
  updateRealtimeModelConfig(store.path, 'qwen-audio-3.0-realtime-flash')
  const reopened = createSettingsStore({ ...options, env: {} })
  assert.equal(reopened.load().realtimeModel, 'qwen-audio-3.0-realtime-flash')
  assert.equal(cliConfiguration(root, options.configDir).active.model, 'qwen-audio-3.0-realtime-flash')
})

test('runtime writes deduplicate active assignments and preserve unrelated backend credentials', () => {
  const content = updateSettingsContent('QWEN_AUDIO_REALTIME_MODEL=old\nQWEN_AUDIO_REALTIME_MODEL=stale\nOPENAI_API_KEY=backend-only\n', {
    realtimeProvider: 'stepfun', realtimeApiKey: 'frontend-key',
  })
  assert.equal(content.match(/^QWEN_AUDIO_REALTIME_MODEL=/gm).length, 1)
  assert.equal(parseEnv(content).QWEN_AUDIO_REALTIME_MODEL, 'stepaudio-3-realtime-preview')
  assert.equal(parseEnv(content).OPENAI_API_KEY, 'backend-only')
})

test('rejects a mixed provider and model before starting a Gateway', () => {
  const env = {
    QWEN_AUDIO_REALTIME_PROVIDER: 'stepfun',
    QWEN_AUDIO_REALTIME_MODEL: 'qwen-audio-3.0-realtime-plus',
    QWEN_AUDIO_REALTIME_API_KEY: 'private-key',
  }
  const status = gatewaySetupStatus(env)
  assert.equal(status.ready, false)
  assert.equal(status.missing[0].key, 'QWEN_AUDIO_REALTIME_MODEL')
  assert.throws(() => assertGatewaySetup(env), /QWEN_AUDIO_REALTIME_MODEL.*stepfun/)
  assert.throws(() => requireRealtimeFrontendConfiguration(env), error => {
    assert.match(error.message, /QWEN_AUDIO_REALTIME_MODEL.*stepfun/)
    assert.doesNotMatch(error.message, /private-key/)
    return true
  })
})
