import assert from 'node:assert/strict'
import test from 'node:test'
import {
  backendOptionStates,
  backendRuntimePhase,
  backendRuntimeReady,
} from '../src/backend-options.mjs'

function report(backends) {
  return { selected: '', readOnly: true, backends }
}

function backend(overrides) {
  return {
    id: 'x',
    label: 'X',
    ready: false,
    selected: false,
    issues: [],
    install: { supported: false },
    ...overrides,
  }
}

test('always offers the none option first, even without a report', () => {
  const states = backendOptionStates(null)
  assert.deepEqual(states, [{
    id: 'none',
    label: '不使用后台 Agent',
    ready: true,
    selectable: true,
    installable: false,
    requiresConfirmation: false,
    configurationRequired: false,
    configurable: false,
    reason: '',
    title: '',
  }])
})

test('ready backends are selectable and never installable', () => {
  const states = backendOptionStates(report([
    backend({
      id: 'opencode',
      label: 'OpenCode',
      ready: true,
      install: { supported: true, requiresConfirmation: false, steps: [] },
    }),
  ]))
  assert.deepEqual(states[1], {
    id: 'opencode',
    label: 'OpenCode',
    ready: true,
    selectable: true,
    installable: false,
    requiresConfirmation: false,
    configurationRequired: false,
    configurationReady: false,
    configurable: false,
    configurationLabel: '配置',
    configurationHint: '',
    onboardingState: 'installed',
    statusLabel: '已安装',
    reason: '',
    title: '',
  })
})

test('passes external service capabilities to the renderer state', () => {
  const states = backendOptionStates(report([
    backend({
      id: 'openclaw',
      label: 'OpenClaw',
      ready: true,
      externalService: {
        supported: true,
        defaultBaseUrl: 'http://127.0.0.1:18789',
        credential: true,
      },
    }),
  ]))
  assert.deepEqual(states[1].externalService, {
    supported: true,
    defaultBaseUrl: 'http://127.0.0.1:18789',
    credential: true,
  })
})

test('unavailable installable backends show a short reason and full title', () => {
  const states = backendOptionStates(report([
    backend({
      id: 'claude',
      label: 'Claude Code',
      issues: ['未找到 Claude Code，请先安装并完成原生配置'],
      install: { supported: true, requiresConfirmation: false, steps: [] },
    }),
  ]))
  assert.equal(states[1].label, 'Claude Code')
  assert.equal(states[1].selectable, false)
  assert.equal(states[1].installable, true)
  assert.equal(states[1].reason, '未安装')
  assert.equal(states[1].title, '未找到 Claude Code，请先安装并完成原生配置')
})

test('script-based installs mark the row as requiring confirmation', () => {
  const states = backendOptionStates(report([
    backend({
      id: 'hermes',
      label: 'Hermes',
      issues: ['未找到 Hermes'],
      install: { supported: true, requiresConfirmation: true, steps: [] },
    }),
  ]))
  assert.equal(states[1].installable, true)
  assert.equal(states[1].requiresConfirmation, true)
})

test('offers backend-owned configuration only after an Agent is installed', () => {
  const states = backendOptionStates(report([
    backend({
      id: 'qoder',
      ready: true,
      onboarding: {
        state: 'configuration-required',
        configuration: {
          required: true,
          status: 'unauthenticated',
          actionAvailable: true,
          action: {
            kind: 'terminal',
            label: '配置',
            hint: '完成官方配置',
          },
        },
      },
    }),
    backend({
      id: 'codebuddy',
      ready: true,
      onboarding: { configuration: { required: false, action: null } },
    }),
  ]))
  assert.equal(states[1].configurationRequired, true)
  assert.equal(states[1].configurable, true)
  assert.equal(states[1].configurationLabel, '配置')
  assert.equal(states[1].configurationHint, '完成官方配置')
  assert.equal(states[1].statusLabel, '待配置')
  assert.equal(states[2].configurationRequired, false)
  assert.equal(states[2].configurable, false)
})

test('offers configuration when backend-owned status is inconclusive', () => {
  const states = backendOptionStates(report([
    backend({
      id: 'kimi',
      ready: true,
      onboarding: {
        configuration: {
          required: false,
          actionAvailable: true,
          status: 'unknown',
          action: { kind: 'terminal', label: '配置' },
        },
      },
    }),
  ]))
  assert.equal(states[1].configurable, true)
  assert.equal(states[1].configurationLabel, '配置')
  assert.equal(states[1].statusLabel, '已安装')
})

test('reports a positively authenticated installed backend as ready', () => {
  const states = backendOptionStates(report([
    backend({
      id: 'pi',
      ready: true,
      onboarding: {
        configuration: {
          required: false,
          actionAvailable: false,
          status: 'authenticated',
          action: { kind: 'terminal', label: '配置' },
        },
      },
    }),
  ]))
  assert.equal(states[1].configurationReady, true)
  assert.equal(states[1].configurable, false)
  assert.equal(states[1].statusLabel, '已就绪')
})

test('does not expose the generic ACP backend in desktop options', () => {
  const states = backendOptionStates(report([
    backend({
      id: 'acp',
      label: 'ACP Agent',
      issues: ['ACP_COMMAND 指定的命令不可用：missing-agent'],
      install: {
        supported: false,
        reason: '通用 ACP 后台需自行安装，并通过 ACP_COMMAND 配置',
      },
    }),
  ]))
  assert.equal(states.length, 1)
  assert.equal(states[0].id, 'none')
})

test('missing install information falls back to not installable', () => {
  const states = backendOptionStates(report([
    {
      id: 'qoder',
      label: 'Qoder',
      ready: false,
      selected: false,
      issues: ['未找到 Qoder CLI'],
    },
  ]))
  assert.equal(states[1].installable, false)
  assert.equal(states[1].reason, '未安装')
})

test('keeps the selected backend selectable even when unavailable', () => {
  const states = backendOptionStates(report([
    backend({
      id: 'claude',
      selected: true,
      issues: ['未找到 Claude Code，请先安装并完成原生配置'],
      install: { supported: true, requiresConfirmation: false, steps: [] },
    }),
  ]))
  assert.equal(states[1].selectable, true)
  assert.equal(states[1].installable, true)
})

test('never reports an uninstalled backend ready from a stale runtime alone', () => {
  assert.equal(backendRuntimeReady({ id: 'codebuddy', ready: false }, {
    selectedBackend: 'codebuddy',
    runtimeBackend: { connected: true },
  }), false)
  assert.equal(backendRuntimeReady({ id: 'codebuddy', ready: true }, {
    selectedBackend: 'codebuddy',
    runtimeBackend: { connected: true },
  }), true)
  assert.equal(backendRuntimeReady({
    id: 'codebuddy',
    ready: true,
    configurationRequired: true,
  }, {
    selectedBackend: 'codebuddy',
    runtimeBackend: { connected: true },
  }), false)
})

test('keeps installation, configuration, and runtime phases separate', () => {
  assert.equal(backendRuntimePhase({
    ready: true,
    configurationRequired: true,
  }, {
    connected: false,
    error: 'ACP connection closed',
  }), 'configuration-required')
  assert.equal(backendRuntimePhase({
    ready: true,
    configurationRequired: false,
  }, {
    connected: false,
    error: 'native backend failed',
  }), 'connection-failed')
  assert.equal(backendRuntimePhase({ ready: true }, {
    connected: true,
  }), 'connected')
  assert.equal(backendRuntimePhase({ ready: true }, {
    connected: false,
    status: 'starting',
    code: 'BACKEND_STARTING',
    error: 'OpenClaw Gateway 正在启动',
  }), 'starting')
  assert.equal(backendRuntimePhase({ ready: true }, null), 'not-configured')
})

test('classifies issue texts into short reasons', () => {
  const cases = [
    ['PATH 中未找到 OpenCode', '未安装'],
    ['未找到 Kimi Code，请先安装并完成原生配置', '未安装'],
    ['OpenCode 1.17.9 低于最低版本 1.18.0', '版本不兼容'],
    ['Kimi Code 版本不兼容；自动部署需要 DASHSCOPE_API_KEY', '版本不兼容'],
    ['无法确认 Kimi Code 版本', '版本不兼容'],
    ['缺少 DASHSCOPE_API_KEY 和 QWEN_AUDIO_AGENT_BACKEND_MODEL', '缺少百炼配置'],
    ['缺少 claude-code-acp，并且 npx 不可用', '需要 ACP 适配器'],
    ['ACP_COMMAND 指定的命令不可用：missing-agent', '需要配置'],
    ['', '当前不可用'],
  ]
  for (const [issue, reason] of cases) {
    const states = backendOptionStates(report([
      backend({ issues: [issue] }),
    ]))
    assert.equal(states[1].reason, reason, issue)
  }
})
