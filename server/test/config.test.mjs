import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  numberSetting,
  resolveCodeBuddyWorkspace,
  resolveCodexWorkspace,
  resolveBackendModels,
  resolveHermesWorkspace,
  resolveKimiWorkspace,
  resolveOpenCodeCoordinatorAgent,
  resolveOpenCodeWorkspace,
  resolveQoderWorkspace,
} from '../src/core/config.mjs'

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

test('uses the user data directory for the default OpenCode workspace', () => {
  const directory = resolve('/home/user/.config/qwaudio')
  assert.equal(
    resolveOpenCodeWorkspace({}, directory),
    resolve(directory, 'workspaces/opencode'),
  )
})

test('uses only the explicit OPENCODE_WORKSPACE setting', () => {
  assert.equal(
    resolveOpenCodeWorkspace({
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

test('uses the user data directory for the default Qoder workspace', () => {
  const directory = resolve('/home/user/.config/qwaudio')
  assert.equal(
    resolveQoderWorkspace({}, directory),
    resolve(directory, 'workspaces/qoder'),
  )
})

test('uses the user data directory for additional ACP backend workspaces', () => {
  const directory = resolve('/home/user/.config/qwaudio')
  assert.equal(
    resolveHermesWorkspace({}, directory),
    resolve(directory, 'workspaces/hermes'),
  )
  assert.equal(
    resolveKimiWorkspace({}, directory),
    resolve(directory, 'workspaces/kimi'),
  )
  assert.equal(
    resolveCodeBuddyWorkspace({}, directory),
    resolve(directory, 'workspaces/codebuddy'),
  )
  assert.equal(
    resolveCodexWorkspace({}, directory),
    resolve(directory, 'workspaces/codex'),
  )
})

test('maps one backend model name to each managed backend provider', () => {
  assert.deepEqual(resolveBackendModels({
    QWEN_AUDIO_AGENT_BACKEND_MODEL: 'qwen3.7-plus',
  }), {
    common: 'qwen3.7-plus',
    openCode: 'alibaba-cn/qwen3.7-plus',
    openClaw: 'bailian/qwen3.7-plus',
    qoder: 'qwen3.7-plus',
    kimi: 'qwen3.7-plus',
    hermes: 'qwen3.7-plus',
    codeBuddy: 'qwen3.7-plus',
    codex: 'qwen3.7-plus',
    claude: 'qwen3.7-plus',
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
    kimi: '',
    hermes: '',
    codeBuddy: '',
    codex: '',
    claude: '',
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
    kimi: '',
    hermes: '',
    codeBuddy: '',
    codex: '',
    claude: '',
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
    kimi: 'qwen3.7-max',
    hermes: 'qwen3.7-max',
    codeBuddy: 'qwen3.7-max',
    codex: 'qwen3.7-max',
    claude: 'qwen3.7-max',
    acp: 'qwen3.7-max',
  })
})
