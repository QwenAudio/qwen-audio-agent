import assert from 'node:assert/strict'
import test from 'node:test'
import {
  formatBackendSetup,
  inspectBackendSetups,
} from '../../shared/backend-setup.mjs'

function inspector({
  env = {},
  commands = {},
  versions = {},
  backend = '',
} = {}) {
  return inspectBackendSetups({
    env,
    platform: 'linux',
    backend,
    find: command => commands[command] || '',
    readVersion: command => versions[command] || '',
  })
}

test('reports installed backends without probing credentials or changing models', () => {
  const report = inspector({
    env: { AGENT_PROTOCOL: 'codex' },
    commands: {
      opencode: '/bin/opencode',
      codex: '/bin/codex',
      npx: '/bin/npx',
    },
    versions: {
      '/bin/opencode': '1.18.6',
    },
  })
  const openCode = report.backends.find(item => item.id === 'opencode')
  const codex = report.backends.find(item => item.id === 'codex')
  const hermes = report.backends.find(item => item.id === 'hermes')

  assert.equal(report.readOnly, true)
  assert.equal(openCode.ready, true)
  assert.equal(openCode.configuration, 'preserved')
  assert.equal(codex.selected, true)
  assert.equal(codex.ready, true)
  assert.equal(codex.adapter.source, 'managed')
  assert.equal(codex.authentication, 'backend-managed')
  assert.equal(hermes.ready, false)
})

test('reports an incompatible installed OpenCode version', () => {
  const report = inspector({
    backend: 'opencode',
    commands: { opencode: '/bin/opencode' },
    versions: { '/bin/opencode': '1.17.9' },
  })
  assert.equal(report.backends[0].ready, false)
  assert.match(report.backends[0].issues[0], /最低版本 1\.18\.0/)
})

test('requires a compatible Kimi Code version', () => {
  const ready = inspector({
    backend: 'kimi',
    commands: { kimi: '/bin/kimi' },
    versions: { '/bin/kimi': '0.31.0' },
  }).backends[0]
  assert.equal(ready.ready, true)
  assert.equal(ready.backend.version, '0.31.0')
  assert.equal(ready.integration, 'native')

  const legacy = inspector({
    backend: 'kimi',
    commands: { kimi: '/bin/kimi' },
    versions: { '/bin/kimi': 'kimi-cli 0.30.9' },
  }).backends[0]
  assert.equal(legacy.ready, false)
  assert.match(legacy.issues[0], /最低版本 0\.31\.0/)
})

test('reports automatic OpenCode and OpenClaw package setup', () => {
  const openCode = inspector({
    backend: 'opencode',
    env: {
      DASHSCOPE_API_KEY: 'test-key',
      QWEN_AUDIO_AGENT_BACKEND_MODEL: 'qwen3.7-max',
    },
    commands: { npx: '/bin/npx' },
  }).backends[0]
  assert.equal(openCode.ready, true)
  assert.equal(openCode.backend.source, 'managed')
  assert.equal(openCode.configuration, 'automatic-bailian')

  const openClaw = inspector({
    backend: 'openclaw',
    env: {
      DASHSCOPE_API_KEY: 'test-key',
      QWEN_AUDIO_AGENT_BACKEND_MODEL: 'qwen3.7-max',
    },
    commands: { npx: '/bin/npx' },
  }).backends[0]
  assert.equal(openClaw.ready, true)
  assert.equal(openClaw.backend.source, 'managed')
  assert.equal(openClaw.configuration, 'automatic-bailian')
})

test('does not report automatic fallback ready without Bailian setup', () => {
  for (const backend of ['opencode', 'openclaw']) {
    const item = inspector({
      backend,
      commands: { npx: '/bin/npx' },
    }).backends[0]
    assert.equal(item.ready, false)
    assert.match(item.issues[0], /DASHSCOPE_API_KEY/)
    assert.match(item.issues[0], /QWEN_AUDIO_AGENT_BACKEND_MODEL/)
  }
})

test('checks explicit generic ACP commands and adapter binaries', () => {
  const generic = inspector({
    backend: 'acp',
    env: { ACP_COMMAND: 'my-agent' },
    commands: { 'my-agent': '/bin/my-agent' },
  }).backends[0]
  assert.equal(generic.ready, true)
  assert.equal(generic.configuration, 'command-managed')
  const missingGeneric = inspector({
    backend: 'acp',
    env: { ACP_COMMAND: 'missing-agent' },
  }).backends[0]
  assert.match(missingGeneric.issues[0], /ACP_COMMAND 指定的命令不可用/)

  const claude = inspector({
    backend: 'claude',
    env: {
      CLAUDE_CODE_EXECUTABLE: '/tools/claude',
      CLAUDE_CODE_ACP_BIN: '/tools/claude-code-acp',
    },
    commands: {
      '/tools/claude': '/tools/claude',
      '/tools/claude-code-acp': '/tools/claude-code-acp',
    },
  }).backends[0]
  assert.equal(claude.ready, true)
  assert.equal(claude.backend.source, 'configured')
  assert.equal(claude.adapter.source, 'installed')
})

test('honors explicit package and binary runtime requirements', () => {
  const packageMode = inspector({
    backend: 'opencode',
    env: { OPENCODE_RUNTIME: 'package' },
    commands: { npx: '/bin/npx' },
  }).backends[0]
  assert.equal(packageMode.ready, true)
  assert.equal(packageMode.backend.source, 'package')

  const missingAdapter = inspector({
    backend: 'codex',
    env: { CODEX_ACP_RUNTIME: 'binary' },
    commands: { codex: '/bin/codex' },
  }).backends[0]
  assert.equal(missingAdapter.ready, false)
  assert.match(missingAdapter.issues[0], /codex-acp/)
})

test('desktop installed-only mode disables every npx fallback', () => {
  const env = {
    QWEN_AUDIO_AGENT_DESKTOP_INSTALLED_ONLY: '1',
    DASHSCOPE_API_KEY: 'test-key',
    QWEN_AUDIO_AGENT_BACKEND_MODEL: 'qwen3.7-max',
  }

  // 未安装时不再走百炼自动部署，直接报告未安装
  const missingOpenCode = inspector({
    backend: 'opencode',
    env,
    commands: { npx: '/bin/npx' },
  }).backends[0]
  assert.equal(missingOpenCode.ready, false)
  assert.match(missingOpenCode.issues[0], /未找到 OpenCode/)
  assert.doesNotMatch(missingOpenCode.issues[0], /自动部署/)

  // 版本过低时不再 npx 回退，报告版本不兼容
  const legacyOpenCode = inspector({
    backend: 'opencode',
    env,
    commands: { opencode: '/bin/opencode', npx: '/bin/npx' },
    versions: { '/bin/opencode': '1.17.9' },
  }).backends[0]
  assert.equal(legacyOpenCode.ready, false)
  assert.match(legacyOpenCode.issues[0], /低于最低版本/)

  // 缺少 ACP Adapter 时不再 npx 回退，提示手动安装
  const claude = inspector({
    backend: 'claude',
    env,
    commands: { claude: '/bin/claude', npx: '/bin/npx' },
  }).backends[0]
  assert.equal(claude.ready, false)
  assert.match(claude.issues[0], /桌面版需先手动安装/)

  // package 模式同样被拒绝
  const packageMode = inspector({
    backend: 'claude',
    env: { ...env, CLAUDE_CODE_ACP_RUNTIME: 'package' },
    commands: { claude: '/bin/claude', npx: '/bin/npx' },
  }).backends[0]
  assert.equal(packageMode.ready, false)
  assert.match(packageMode.issues[0], /桌面版需先安装 ACP Adapter/)

  // 已安装的组件不受影响
  const installed = inspector({
    backend: 'claude',
    env,
    commands: {
      claude: '/bin/claude',
      'claude-code-acp': '/bin/claude-code-acp',
    },
  }).backends[0]
  assert.equal(installed.ready, true)
})

test('formats a concise read-only setup report', () => {
  const report = inspector({
    backend: 'codex',
    commands: {
      codex: '/bin/codex',
      npx: '/bin/npx',
    },
  })
  const output = formatBackendSetup(report)
  assert.match(output, /只读，不会安装、登录或修改配置/)
  assert.match(output, /Codex \[当前\]/)
  assert.match(output, /默认不覆盖后台模型/)
  assert.match(output, /不会输出或验证凭据/)
})
