import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  MASKED_SECRET,
  requiresOrbHandoffRetry,
  runtimePresentation,
  secretFieldDisplayValue,
  secretSettingUpdateValue,
} from '../src/runtime-presentation.mjs'

const READY_ENVIRONMENT = {
  distribution: 'Ubuntu',
  wslVersion: 2,
  architecture: 'x86_64',
  nodeVersion: 'v22.22.2',
  npmVersion: '10.9.4',
  runtimeVersion: '1.2.0',
  protocolVersion: 1,
}

test('maps every stable controller state to fixed concise presentation copy', () => {
  const expected = {
    checking: ['正在检查 WSL', 'none'],
    'setup-required': ['需要安装运行环境', 'prepare-install'],
    starting: ['正在启动运行环境', 'none'],
    ready: ['运行环境已就绪', 'none'],
    recovering: ['正在重新连接 WSL', 'none'],
    external: ['外部 Gateway 已连接', 'none'],
    error: ['运行环境暂不可用', 'retry'],
    stopping: ['正在停止运行环境', 'none'],
  }
  for (const [state, [title, primaryAction]] of Object.entries(expected)) {
    const result = runtimePresentation({
      status: {
        state,
        reason: state === 'setup-required' ? 'runtime-required' : null,
      },
      environment: READY_ENVIRONMENT,
    })
    assert.equal(result.title, title)
    assert.equal(result.primaryAction, primaryAction)
    assert.equal(typeof result.actionText, 'string')
    assert.equal(typeof result.showCommandConfirmation, 'boolean')
    assert.equal(typeof result.offerMicrophoneSettings, 'boolean')
  }
})

test('offers an orb retry when a ready runtime was not presented', () => {
  const result = runtimePresentation({
    status: { state: 'ready', syncAvailable: true },
    environment: READY_ENVIRONMENT,
    orbHandoffFailed: true,
  })
  assert.equal(result.title, '主窗口未打开')
  assert.equal(result.actionText, '运行环境已安装，请重新打开主窗口。')
  assert.equal(result.primaryAction, 'open-orb')
  assert.equal(result.primaryLabel, '打开主窗口')
})

test('derives orb retry only from the structured install result', () => {
  assert.equal(requiresOrbHandoffRetry({ orbPresented: false }), true)
  assert.equal(requiresOrbHandoffRetry({ orbPresented: true }), false)
  assert.equal(requiresOrbHandoffRetry(null), false)
})

test('maps prerequisite, runtime, bridge, gateway, and external failures', () => {
  const cases = [
    ['wsl-unavailable', '需要安装或启用 WSL', 'open-wsl-install', false],
    ['no-distributions', '需要安装 WSL 发行版', 'open-wsl-install', false],
    ['distribution-not-found', '所选 WSL 发行版不可用', 'retry', false],
    ['wsl2-required', '所选发行版需要 WSL 2', 'open-wsl-install', false],
    ['unsupported-architecture', '当前 WSL 架构不受支持', 'none', false],
    ['node-required', 'WSL 中需要 Node.js 和 npm', 'open-node-download', false],
    ['runtime-required', '需要安装运行环境', 'prepare-install', true],
    ['runtime-install-failed', '运行环境安装未完成', 'prepare-install', true],
    ['runtime-integrity-failed', '安装包完整性校验失败', 'retry', false],
    ['runtime-verification-failed', '运行环境校验失败', 'prepare-install', true],
    ['bridge-handshake-failed', 'WSL 连接协议不匹配', 'prepare-install', true],
    ['bridge-recovery-exhausted', 'WSL 连接多次中断', 'retry', false],
    ['gateway-start-failed', 'Gateway 启动失败', 'retry', false],
    ['gateway-health-timeout', 'Windows 无法连接 Gateway', 'open-wsl-networking', false],
    ['external-invalid', '外部 Gateway 地址无效', 'none', false],
    ['external-unavailable', '外部 Gateway 暂不可用', 'retry', false],
    ['runtime-removal-failed', '运行环境移除失败', 'retry', false],
    ['cancelled', '安装已取消', 'retry', false],
    ['microphone-denied', '需要麦克风权限', 'open-microphone-settings', false],
  ]
  for (const [reason, title, primaryAction, installable] of cases) {
    const result = runtimePresentation({
      status: { state: 'error', reason },
      environment: READY_ENVIRONMENT,
      installPlan: installable
        ? { displayCommand: 'npm install exact-runtime.tgz' }
        : null,
    })
    assert.equal(result.title, title, reason)
    assert.equal(result.primaryAction, primaryAction, reason)
    assert.equal(result.showCommandConfirmation, installable, reason)
    assert.equal(
      result.offerMicrophoneSettings,
      reason === 'microphone-denied',
      reason,
    )
  }
})

test('never reflects unknown error, stack, or shell output into presentation copy', () => {
  const secret = 'token=super-secret\n    at ChildProcess.<anonymous>'
  const result = runtimePresentation({
    status: {
      state: 'error',
      reason: 'unknown-reason',
      message: secret,
      stderr: `npm failed ${secret}`,
    },
    environment: READY_ENVIRONMENT,
  })
  assert.equal(result.title, '运行环境暂不可用')
  assert.equal(result.primaryAction, 'retry')
  assert.doesNotMatch(JSON.stringify(result), /super-secret|ChildProcess|npm failed/)
})

test('offers Windows microphone settings when system access is denied', () => {
  const result = runtimePresentation({
    status: { state: 'ready', microphoneAccess: 'denied' },
    environment: READY_ENVIRONMENT,
  })
  assert.equal(result.offerMicrophoneSettings, true)
  assert.equal(result.checks.find(check => check.id === 'microphone').state, 'failed')
  assert.equal(result.checks.find(check => check.id === 'microphone').value, '需要授权')
})

test('builds a bounded diagnostic checklist and progress state', () => {
  const result = runtimePresentation({
    status: {
      state: 'setup-required',
      reason: 'runtime-required',
      progress: { phase: 'installing', completed: 2, total: 4 },
      health: {
        gatewayConnected: false,
        backend: { label: 'Codex', connected: false },
      },
    },
    environment: READY_ENVIRONMENT,
  })
  assert.deepEqual(result.progress, {
    visible: true,
    label: '正在安装运行环境',
    value: 50,
  })
  assert.deepEqual(result.checks.map(check => check.id), [
    'wsl',
    'distribution',
    'wsl-version',
    'bash',
    'node',
    'runtime',
    'backend',
    'gateway',
    'microphone',
  ])
  assert.equal(result.checks.find(check => check.id === 'node').value, 'Node.js v22.22.2 · npm 10.9.4')
  assert.equal(result.checks.find(check => check.id === 'runtime').state, 'failed')
})

test('offers a confirmed sync when a healthy runtime has a matching update', () => {
  const pending = runtimePresentation({
    status: { state: 'ready', syncAvailable: true },
    environment: READY_ENVIRONMENT,
  })
  assert.equal(pending.title, '运行环境可以同步')
  assert.equal(pending.primaryAction, 'prepare-install')
  assert.equal(pending.primaryLabel, '准备同步')
  assert.equal(pending.showCommandConfirmation, false)

  const confirmed = runtimePresentation({
    status: { state: 'ready', syncAvailable: true },
    environment: READY_ENVIRONMENT,
    installPlan: { displayCommand: 'npm install exact-runtime.tgz' },
  })
  assert.equal(confirmed.showCommandConfirmation, true)
})

test('preserves, clears, and replaces configured secrets without exposing them', () => {
  const configured = { configured: true }
  assert.equal(secretFieldDisplayValue(configured), MASKED_SECRET)
  assert.equal(secretFieldDisplayValue({ configured: false }), '')
  assert.deepEqual(
    secretSettingUpdateValue(configured, MASKED_SECRET),
    { configured: true },
  )
  assert.equal(secretSettingUpdateValue(configured, ''), '')
  assert.equal(secretSettingUpdateValue(configured, 'sk-new'), 'sk-new')
  assert.equal(secretSettingUpdateValue('native-secret', 'native-secret'), 'native-secret')
})

test('repair document provides semantic status, confirmation, and danger controls', async () => {
  const [html, css, renderer] = await Promise.all([
    readFile(new URL('../src/repair.html', import.meta.url), 'utf8'),
    readFile(new URL('../src/repair.css', import.meta.url), 'utf8'),
    readFile(new URL('../src/repair.js', import.meta.url), 'utf8'),
  ])
  assert.match(html, /aria-live="polite"/)
  assert.match(html, /id="runtime-checks"/)
  assert.match(html, /id="install-command"/)
  assert.match(html, /id="confirm-install"/)
  assert.match(html, /id="copy-diagnostics"/)
  assert.match(html, /id="confirm-removal"/)
  assert.match(html, /id="runtime-mode"/)
  assert.match(html, /id="wsl-distribution"/)
  assert.match(html, /id="external-gateway-origin"/)
  assert.match(html, /<script src="\.\/repair\.js" type="module"><\/script>/)
  assert.doesNotMatch(html, /nodeIntegration|shell\.openExternal/)
  const pixelRadii = [...css.matchAll(/border-radius:\s*(\d+)px/g)]
    .map(match => Number(match[1]))
  assert.equal(pixelRadii.every(value => value <= 8), true)
  assert.match(css, /:focus-visible/)
  assert.match(renderer, /orbHandoffFailed/)
  assert.match(renderer, /api\.openWindowsOrb\(\)/)
  assert.match(renderer, /requiresOrbHandoffRetry/)
  assert.doesNotMatch(renderer, /\['ready', 'external'\]\.includes\(status\.state\)/)
  assert.doesNotMatch(renderer, /openExternal|windows\.show/)
})
