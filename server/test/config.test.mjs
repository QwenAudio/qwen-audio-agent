import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  numberSetting,
  resolveBackendModels,
  resolveBackendWorkspace,
  resolveOpenCodeCoordinatorAgent,
} from '../src/core/config.mjs'
import {
  resolveRealtimeFrontendConfiguration,
} from '../../shared/realtime-provider-catalog.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

test('treats missing and blank numeric settings as unset', () => {
  for (const value of [null, undefined, '', '   ', '\t\n']) {
    assert.equal(numberSetting(value, 120, { min: 0, max: 1000 }), 120)
  }
})

test('preserves explicit zero numeric settings', () => {
  assert.equal(numberSetting('0', 120, { min: 0, max: 1000 }), 0)
  assert.equal(numberSetting(0, 120, { min: 0, max: 1000 }), 0)
})

test('uses the shared user data workspace for the default OpenCode workspace', () => {
  const directory = resolve('/home/user/.config/qwaudio')
  assert.equal(
    resolveBackendWorkspace('opencode', {}, directory),
    resolve(directory, 'workspace'),
  )
})

test('uses only the explicit OPENCODE_WORKSPACE setting', () => {
  assert.equal(
    resolveBackendWorkspace('opencode', {
      OPENCODE_WORKSPACE: 'projects/voice',
      OPENCODE_DIRECTORY: 'legacy',
    }),
    resolve(root, 'projects/voice'),
  )
})

test('uses the default ACP Session mode unless a custom OpenCode Agent is explicit', () => {
  assert.equal(resolveOpenCodeCoordinatorAgent({}), '')
  assert.equal(resolveOpenCodeCoordinatorAgent({
    OPENCODE_COORDINATOR_AGENT: 'qwen-audio-agent-backend',
  }), '')
  assert.equal(resolveOpenCodeCoordinatorAgent({
    OPENCODE_COORDINATOR_AGENT: 'custom-coordinator',
  }), 'custom-coordinator')
  assert.equal(resolveOpenCodeCoordinatorAgent({
    QWEN_AUDIO_AGENT_BACKEND_AGENT: 'shared-agent',
    OPENCODE_COORDINATOR_AGENT: 'custom-coordinator',
  }), 'shared-agent')
})

test('uses the shared user data workspace for the default Qoder workspace', () => {
  const directory = resolve('/home/user/.config/qwaudio')
  assert.equal(
    resolveBackendWorkspace('qoder', {}, directory),
    resolve(directory, 'workspace'),
  )
})

test('shares one default workspace across additional ACP backends', () => {
  const directory = resolve('/home/user/.config/qwaudio')
  for (const backend of ['hermes', 'kimi', 'codebuddy', 'codex', 'qwen', 'pi']) {
    assert.equal(
      resolveBackendWorkspace(backend, {}, directory),
      resolve(directory, 'workspace'),
    )
  }
})

test('maps one backend model name to each managed backend provider', () => {
  assert.deepEqual(resolveBackendModels({
    QWEN_AUDIO_AGENT_BACKEND_MODEL: 'qwen3.7-plus',
  }), {
    common: 'qwen3.7-plus',
    openCode: 'alibaba-cn/qwen3.7-plus',
    openClaw: 'bailian/qwen3.7-plus',
    qoder: 'qwen3.7-plus',
    qwen: 'qwen3.7-plus',
    kimi: 'qwen3.7-plus',
    hermes: 'qwen3.7-plus',
    codeBuddy: 'qwen3.7-plus',
    codex: 'qwen3.7-plus',
    claude: 'qwen3.7-plus',
    pi: 'qwen3.7-plus',
    deepSeekHarness: '',
    acp: 'qwen3.7-plus',
  })
})

test('ignores backend-native model variables as Gateway overrides', () => {
  assert.deepEqual(resolveBackendModels({
    OPENCODE_MODEL: 'custom-open/code-model',
    QODER_MODEL: 'qoder-model',
  }), {
    common: '',
    openCode: '',
    openClaw: '',
    qoder: '',
    qwen: '',
    kimi: '',
    hermes: '',
    codeBuddy: '',
    codex: '',
    claude: '',
    pi: '',
    deepSeekHarness: '',
    acp: '',
  })
})

test('treats legacy auto as no backend model override', () => {
  assert.deepEqual(resolveBackendModels({
    QWEN_AUDIO_AGENT_BACKEND_MODEL: 'AUTO',
  }), {
    common: '',
    openCode: '',
    openClaw: '',
    qoder: '',
    qwen: '',
    kimi: '',
    hermes: '',
    codeBuddy: '',
    codex: '',
    claude: '',
    pi: '',
    deepSeekHarness: '',
    acp: '',
  })
})

test('uses only the unified backend model override', () => {
  assert.deepEqual(resolveBackendModels({
    QWEN_AUDIO_AGENT_BACKEND_MODEL: 'qwen3.7-max',
    OPENCODE_MODEL: 'custom-open/code-model',
  }), {
    common: 'qwen3.7-max',
    openCode: 'alibaba-cn/qwen3.7-max',
    openClaw: 'bailian/qwen3.7-max',
    qoder: 'qwen3.7-max',
    qwen: 'qwen3.7-max',
    kimi: 'qwen3.7-max',
    hermes: 'qwen3.7-max',
    codeBuddy: 'qwen3.7-max',
    codex: 'qwen3.7-max',
    claude: 'qwen3.7-max',
    pi: 'qwen3.7-max',
    deepSeekHarness: '',
    acp: 'qwen3.7-max',
  })
})

test('uses a DeepSeek-specific model without leaking unrelated overrides', () => {
  assert.equal(resolveBackendModels({
    DEEPSEEK_HARNESS_MODEL: 'deepseek-v4-flash',
    QWEN_AUDIO_AGENT_BACKEND_MODEL: 'qwen3.7-max',
  }).deepSeekHarness, 'deepseek-v4-flash')
  assert.equal(resolveBackendModels({
    QWEN_AUDIO_AGENT_BACKEND_MODEL: 'deepseek-v4-pro',
  }).deepSeekHarness, 'deepseek-v4-pro')
})

test('changes the realtime configuration signature when only the model changes', () => {
  const shared = {
    DASHSCOPE_API_KEY: 'same-key',
    QWEN_AUDIO_REALTIME_BASE_URL: 'wss://gateway.example/realtime',
    QWEN_AUDIO_REALTIME_VOICE: 'same-voice',
  }
  const first = resolveRealtimeFrontendConfiguration({
    ...shared,
    QWEN_AUDIO_REALTIME_MODEL: 'qwen-audio-3.0-realtime-plus',
  })
  const second = resolveRealtimeFrontendConfiguration({
    ...shared,
    QWEN_AUDIO_REALTIME_MODEL: 'qwen3.5-omni-plus-realtime',
  })

  assert.notEqual(first.signature, second.signature)
})

test('selects only the explicit voice override for the active model family', () => {
  const legacy = resolveRealtimeFrontendConfiguration({
    DASHSCOPE_API_KEY: 'same-key',
    QWEN_AUDIO_REALTIME_MODEL: 'qwen-audio-3.0-realtime-plus',
    QWEN_AUDIO_REALTIME_VOICE: 'Cherry',
    QWEN_OMNI_REALTIME_VOICE: 'Ethan-custom',
  })
  const omni = resolveRealtimeFrontendConfiguration({
    DASHSCOPE_API_KEY: 'same-key',
    QWEN_AUDIO_REALTIME_MODEL: 'qwen3.5-omni-plus-realtime',
    QWEN_AUDIO_REALTIME_VOICE: 'Cherry',
    QWEN_OMNI_REALTIME_VOICE: 'Ethan-custom',
  })
  const defaults = resolveRealtimeFrontendConfiguration({
    DASHSCOPE_API_KEY: 'same-key',
    QWEN_AUDIO_REALTIME_MODEL: 'qwen3.5-omni-plus-realtime',
  })

  assert.equal(legacy.dashscopeVoice, 'Cherry')
  assert.equal(omni.dashscopeVoice, 'Ethan-custom')
  assert.equal(defaults.dashscopeVoice, '')
})
