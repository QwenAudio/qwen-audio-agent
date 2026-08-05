import assert from 'node:assert/strict'
import test from 'node:test'
import { helpText, parseArguments } from '../src/arguments.mjs'

test('allows the Gateway to run without a backend Agent', () => {
  const frontendOnly = parseArguments([], {})
  assert.equal(frontendOnly.command, 'gateway')
  assert.equal(frontendOnly.gatewayAction, 'run')
  assert.equal(frontendOnly.backend, '')
  assert.equal(frontendOnly.backendUrl, '')
  assert.equal(parseArguments([], {
    QWEN_AUDIO_AGENT_BACKEND_PERMISSION_MODE: 'unused-invalid-value',
  }).backend, '')
  assert.equal(parseArguments(['gateway', '--backend', 'none'], {}).backend, '')
  assert.equal(parseArguments([], { AGENT_PROTOCOL: 'NONE' }).backend, '')

  const options = parseArguments([], { AGENT_PROTOCOL: 'openclaw' })
  assert.equal(options.command, 'gateway')
  assert.equal(options.gatewayAction, 'run')
  assert.equal(options.url, 'http://127.0.0.1:3101')
  assert.equal(options.backend, 'openclaw')
  assert.equal(options.backendPermissionMode, 'native')
  assert.equal(options.backendUrl, 'http://127.0.0.1:18789')
})

test('parses independent TUI and WebUI client commands', () => {
  const tui = parseArguments([
    'tui',
    '--url', 'https://voice.example.com/path',
    '--session', 'project-one',
    '--audio-mode', 'full',
  ], {})
  assert.equal(tui.command, 'tui')
  assert.equal(tui.url, 'https://voice.example.com')
  assert.equal(tui.sessionId, 'project-one')
  assert.equal(tui.audioMode, 'full')
  assert.equal(
    parseArguments(['tui'], {
      QWEN_AUDIO_AGENT_TUI_AUDIO_MODE: 'FULL',
    }).audioMode,
    'full',
  )

  const web = parseArguments(['webui', '--no-open', '--takeover'], {})
  assert.equal(web.command, 'webui')
  assert.equal(web.openBrowser, false)
  assert.equal(web.takeover, true)
})

test('parses read-only backend setup options', () => {
  const all = parseArguments(['setup'], {})
  assert.equal(all.command, 'setup')
  assert.equal(all.backendSpecified, false)
  assert.equal(all.json, false)

  const selected = parseArguments([
    'setup',
    '--backend', 'codex',
    '--json',
  ], {})
  assert.equal(selected.backend, 'codex')
  assert.equal(selected.backendSpecified, true)
  assert.equal(selected.json, true)
  assert.throws(
    () => parseArguments(['status', '--json'], {}),
    /只适用于 setup/,
  )
})

test('parses Gateway backend settings', () => {
  const options = parseArguments([
    'gateway',
    '--backend', 'openclaw',
    '--backend-agent', 'build',
    '--backend-url', 'http://localhost:18888/path',
  ], {})
  assert.equal(options.backend, 'openclaw')
  assert.equal(options.backendAgent, 'build')
  assert.equal(options.backendUrl, 'http://localhost:18888')
})

test('accepts Qoder as a Gateway-owned backend without a URL', () => {
  const options = parseArguments([
    'gateway',
    '--backend', 'qoder',
  ], {})
  assert.equal(options.backend, 'qoder')
  assert.equal(options.backendUrl, '')
})

test('accepts a generic ACP backend without an HTTP URL', () => {
  const options = parseArguments(['gateway', '--backend', 'acp'], {})
  assert.equal(options.backend, 'acp')
  assert.equal(options.backendUrl, '')
})

test('accepts named local ACP backends without an HTTP URL', () => {
  for (const backend of ['kimi', 'hermes', 'codebuddy', 'codex', 'claude']) {
    const options = parseArguments(['gateway', '--backend', backend], {})
    assert.equal(options.backend, backend)
    assert.equal(options.backendUrl, '')
  }
})

test('parses the install command with an optional confirmation skip', () => {
  const install = parseArguments(['install', 'codex'], {})
  assert.equal(install.command, 'install')
  assert.equal(install.installTarget, 'codex')
  assert.equal(install.yes, false)

  const skip = parseArguments(['install', 'kimi', '--yes'], {})
  assert.equal(skip.installTarget, 'kimi')
  assert.equal(skip.yes, true)
  assert.equal(parseArguments(['install', 'kimi', '-y'], {}).yes, true)
  assert.equal(
    parseArguments(['install', 'OPENCODE'], {}).installTarget,
    'opencode',
  )
})

test('rejects invalid install targets and misplaced flags', () => {
  assert.throws(() => parseArguments(['install'], {}), /缺少后台名称/)
  assert.throws(() => parseArguments(['install', '--yes'], {}), /缺少后台名称/)
  assert.throws(() => parseArguments(['install', 'none'], {}), /缺少后台名称/)
  assert.throws(() => parseArguments(['install', 'unknown'], {}), /不支持的后台/)
  assert.throws(() => parseArguments(['install', 'acp'], {}), /ACP_COMMAND/)
  assert.throws(
    () => parseArguments(['setup', '--yes'], {}),
    /--yes 只适用于 install/,
  )
})

test('rejects the removed backend mode option', () => {
  assert.throws(() => parseArguments([
    'gateway',
    '--backend', 'openclaw',
    '--backend-mode', 'compatible',
  ], {}), /未知参数：--backend-mode/)
})

test('parses supported backend permission modes', () => {
  const options = parseArguments([
    'gateway',
    '--backend', 'qoder',
    '--backend-permission-mode', 'full',
  ], {})
  assert.equal(options.backendPermissionMode, 'full')
  assert.throws(() => parseArguments([
    'gateway',
    '--backend', 'openclaw',
    '--backend-permission-mode', 'full',
  ], {}), /OpenClaw/)
})

test('parses foreground and service Gateway commands', () => {
  const env = { AGENT_PROTOCOL: 'openclaw' }
  assert.equal(parseArguments(['gateway'], env).gatewayAction, 'run')
  assert.equal(parseArguments(['gateway', 'run'], env).gatewayAction, 'run')
  assert.equal(
    parseArguments(['gateway', 'install'], {}).gatewayAction,
    'install',
  )
  assert.equal(parseArguments(['gateway', 'start'], {}).gatewayAction, 'start')
  assert.equal(parseArguments(['gateway', 'stop'], {}).gatewayAction, 'stop')
  assert.equal(
    parseArguments(['gateway', 'restart'], {}).gatewayAction,
    'restart',
  )
  assert.equal(
    parseArguments(['gateway', 'uninstall'], {}).gatewayAction,
    'uninstall',
  )
  assert.equal(parseArguments(['status'], {}).gatewayAction, 'status')
})

test('rejects client-only flags on unrelated commands', () => {
  assert.throws(
    () => parseArguments(['tui', '--audio-mode', 'invalid'], {}),
    /不支持的音频模式/,
  )
  assert.throws(
    () => parseArguments(['webui', '--audio-mode', 'full'], {}),
    /只适用于 tui/,
  )
  assert.throws(
    () => parseArguments(['tui', '--no-open'], {}),
    /只适用于 webui/,
  )
  assert.throws(
    () => parseArguments(['status', '--takeover'], {}),
    /只适用于 tui 或 webui/,
  )
  assert.throws(
    () => parseArguments(['gateway', 'install', '--backend', 'openclaw'], {}),
    /config\.env/,
  )
})

test('documents the service and client commands', () => {
  const text = helpText()
  assert.match(text, /^qwenaudio$/m)
  assert.match(text, /qwenaudio \[gateway\]/)
  assert.match(text, /gateway install/)
  assert.match(text, /gateway uninstall/)
  assert.match(text, /qwenaudio tui/)
  assert.match(text, /qwenaudio webui/)
  assert.match(text, /qwenaudio status/)
  assert.match(text, /qwenaudio config/)
  assert.match(text, /qwenaudio setup/)
  assert.match(text, /--json/)
  assert.match(text, /qwenaudio install NAME/)
  assert.match(text, /--yes, -y/)
  assert.doesNotMatch(text, /--attach-openclaw/)
  assert.doesNotMatch(text, /--backend-mode/)
  assert.match(text, /--backend-permission-mode MODE/)
  assert.match(text, /--audio-mode MODE/)
  assert.match(text, /x\s+半双工模式下手动打断当前回复/)
  assert.doesNotMatch(text, /--mode/)
})
