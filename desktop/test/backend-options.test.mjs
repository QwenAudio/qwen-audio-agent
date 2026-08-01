import assert from 'node:assert/strict'
import test from 'node:test'
import { backendOptionStates } from '../src/backend-options.mjs'

function report(backends) {
  return { selected: '', readOnly: true, backends }
}

test('always offers the none option first, even without a report', () => {
  const states = backendOptionStates(null)
  assert.deepEqual(states, [{
    id: 'none',
    label: '不使用后台 Agent',
    disabled: false,
    title: '',
  }])
})

test('ready backends are selectable with a plain label', () => {
  const states = backendOptionStates(report([
    {
      id: 'opencode',
      label: 'OpenCode',
      ready: true,
      selected: false,
      issues: [],
    },
  ]))
  assert.deepEqual(states[1], {
    id: 'opencode',
    label: 'OpenCode',
    disabled: false,
    title: '',
  })
})

test('unavailable backends are disabled with a short reason and full title', () => {
  const states = backendOptionStates(report([
    {
      id: 'claude',
      label: 'Claude Code',
      ready: false,
      selected: false,
      issues: ['未找到 Claude Code，请先安装并完成原生配置'],
    },
  ]))
  assert.equal(states[1].disabled, true)
  assert.equal(states[1].label, 'Claude Code（未安装）')
  assert.equal(states[1].title, '未找到 Claude Code，请先安装并完成原生配置')
})

test('keeps the selected backend selectable even when unavailable', () => {
  const states = backendOptionStates(report([
    {
      id: 'claude',
      label: 'Claude Code',
      ready: false,
      selected: true,
      issues: ['未找到 Claude Code，请先安装并完成原生配置'],
    },
  ]))
  assert.equal(states[1].disabled, false)
  assert.match(states[1].label, /（未安装）/)
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
      {
        id: 'x',
        label: 'X',
        ready: false,
        selected: false,
        issues: [issue],
      },
    ]))
    assert.equal(states[1].label, `X（${reason}）`, issue)
  }
})
