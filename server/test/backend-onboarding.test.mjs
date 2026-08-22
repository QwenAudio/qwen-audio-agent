import assert from 'node:assert/strict'
import test from 'node:test'
import {
  backendConfigurationAction,
  backendOnboardingAdapter,
  resolveBackendOnboarding,
} from '../../shared/backend-onboarding.mjs'
import { backendNames } from '../../shared/backend-catalog.mjs'

const expectedCommands = new Map([
  ['opencode', 'opencode auth login'],
  ['openclaw', 'openclaw onboard'],
  ['qoder', 'qodercli login'],
  ['qwen', 'qwen'],
  ['kimi', 'kimi login'],
  ['hermes', 'hermes setup --portal'],
  ['codebuddy', 'codebuddy'],
  ['codex', 'codex login'],
  ['claude', 'claude'],
  ['pi', 'pi'],
  ['deepseek', 'dsh web'],
])

test('every product backend owns an explicit configuration adapter', () => {
  for (const id of backendNames()) {
    const action = backendConfigurationAction(id, {
      env: {},
      platform: 'darwin',
    })
    if (id === 'acp') {
      assert.equal(action, null)
      continue
    }
    assert.equal(action?.command, expectedCommands.get(id), id)
    assert.equal(action?.kind, 'terminal', id)
    assert.ok(action?.hint, id)
  }
})

test('exposes a uniform trusted configuration action per backend', () => {
  assert.deepEqual(
    backendConfigurationAction('qoder', { env: {}, platform: 'darwin' }),
    {
      id: 'configure',
      kind: 'terminal',
      label: '配置',
      command: 'qodercli login',
      hint: '首次使用请完成 Qoder 官方认证。',
    },
  )
  assert.equal(
    backendConfigurationAction('acp', { env: {}, platform: 'darwin' }),
    null,
  )
  assert.deepEqual(
    backendOnboardingAdapter('deepseek', {
      env: {},
      platform: 'darwin',
    }).configuration.probe,
    { kind: 'deepseek-credentials' },
  )
})

test('lets an adapter suppress configuration when it configures automatically', () => {
  const adapter = backendOnboardingAdapter('opencode', {
    env: {
      DASHSCOPE_API_KEY: 'key',
      QWEN_AUDIO_AGENT_BACKEND_MODEL: 'qwen3-coder-plus',
    },
    platform: 'darwin',
  })
  assert.equal(adapter.configuration.automatic, true)
  assert.equal(adapter.configuration.action, null)
})

test('normalizes adapter details into the shared onboarding lifecycle', () => {
  assert.deepEqual(resolveBackendOnboarding({ ready: true }, {
    installation: { supported: true },
    configuration: { required: true, status: 'unauthenticated' },
  }), {
    state: 'configuration-required',
    installation: { supported: true, status: 'installed' },
    configuration: { required: true, status: 'unauthenticated' },
    readiness: { status: 'not-connected' },
  })
})
