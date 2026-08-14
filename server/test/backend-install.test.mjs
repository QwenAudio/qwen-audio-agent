import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { backendNames } from '../../shared/backend-catalog.mjs'
import {
  authenticationSupport,
  installBackend,
  installSupport,
  withInstallSupport,
} from '../../shared/backend-install.mjs'

function fakeChild(code = 0, { stdout = [], stderr = [] } = {}) {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  process.nextTick(() => {
    for (const chunk of stdout) child.stdout.emit('data', chunk)
    for (const chunk of stderr) child.stderr.emit('data', chunk)
    child.emit('close', code)
  })
  return child
}

function fakeSpawn(calls, results = [0]) {
  let index = 0
  return (command, args) => {
    calls.push([command, args])
    const result = results[Math.min(index, results.length - 1)]
    index += 1
    return typeof result === 'object' ? result : fakeChild(result)
  }
}

const readyReport = id => ({
  selected: '',
  backends: [{ id, label: id, ready: true, selected: false, issues: [] }],
})

function installOptions(overrides = {}) {
  const calls = []
  return {
    calls,
    options: {
      env: {},
      platform: 'darwin',
      spawnImpl: fakeSpawn(calls),
      find: () => '/usr/local/bin/npm',
      inspect: async () => readyReport('opencode'),
      ...overrides,
    },
  }
}

test('every catalog backend has an explicit install spec', () => {
  for (const id of backendNames()) {
    const support = installSupport(id, { env: {}, platform: 'darwin' })
    if (id === 'acp') {
      assert.equal(support.supported, false, 'acp 不提供一键安装')
      assert.match(support.reason, /ACP_COMMAND/)
    } else {
      assert.equal(support.supported, true, `${id} 应支持一键安装`)
      assert.ok(support.steps.length >= 1, `${id} 至少一个安装步骤`)
    }
  }
  assert.equal(installSupport('unknown', { env: {} }).supported, false)
})

test('npm steps report locked packages and honor package overrides', () => {
  const support = installSupport('opencode', { env: {}, platform: 'linux' })
  assert.equal(support.requiresConfirmation, false)
  assert.deepEqual(
    support.steps.map(step => step.display),
    ['npm install -g opencode-ai@1.18.5'],
  )
  const overridden = installSupport('opencode', {
    env: { OPENCODE_PACKAGE: 'opencode-ai@9.9.9' },
    platform: 'linux',
  })
  assert.equal(overridden.steps[0].display, 'npm install -g opencode-ai@9.9.9')

  const codex = installSupport('codex', { env: {}, platform: 'linux' })
  assert.equal(codex.steps.length, 2)
  assert.match(codex.steps[1].display, /@agentclientprotocol\/codex-acp@/)

  const qwen = installSupport('qwen', { env: {}, platform: 'linux' })
  assert.deepEqual(
    qwen.steps.map(step => step.display),
    ['npm install -g @qwen-code/qwen-code@0.21.6'],
  )

  const harness = installSupport('deepseek', {
    env: {},
    platform: 'linux',
  })
  assert.equal(harness.steps.length, 11)
  assert.match(harness.steps[0].display, /--registry=https:\/\/registry\.npmjs\.org\//)
  assert.match(harness.steps[0].display, /@deepseek-ai\/dsh@0\.1\.0-rc\.6/)
  assert.match(harness.steps[1].display, /@deepseek-ai\/dsh-llm-deepseek@0\.1\.0-rc\.6/)
  assert.match(harness.steps.at(-1).display, /@deepseek-ai\/dsh-acp-demo@0\.1\.0-rc\.6/)
})

test('Qwen Code authentication launches the CLI without a removed auth subcommand', () => {
  const support = authenticationSupport('qwen', {
    env: {},
    platform: 'darwin',
  })
  assert.equal(support.supported, true)
  assert.equal(support.command, 'qwen')
  assert.doesNotMatch(support.command, /\bauth\b/)
})

test('script steps require confirmation and follow platform availability', () => {
  const darwin = installSupport('hermes', { env: {}, platform: 'darwin' })
  assert.equal(darwin.supported, true)
  assert.equal(darwin.requiresConfirmation, true)
  assert.match(darwin.steps[0].display, /^curl -fsSL /)

  const win32 = installSupport('hermes', { env: {}, platform: 'win32' })
  assert.equal(win32.supported, true)
  assert.match(win32.steps[0].display, /iex \(irm /)
})

test('withInstallSupport annotates every reported backend', () => {
  const report = withInstallSupport({
    selected: '',
    backends: [
      { id: 'opencode', ready: false, issues: [] },
      { id: 'acp', ready: false, issues: [] },
    ],
  }, { env: {}, platform: 'darwin' })
  assert.equal(report.backends[0].install.supported, true)
  assert.equal(report.backends[1].install.supported, false)
})

test('preserves observed authentication instead of guessing from installation', () => {
  const report = withInstallSupport({
    selected: '',
    backends: [{
      id: 'opencode',
      ready: true,
      authentication: { status: 'authenticated' },
    }],
  }, { env: {}, platform: 'darwin' })
  assert.equal(report.backends[0].authentication.status, 'authenticated')
  assert.equal(report.backends[0].authentication.required, false)
  assert.equal(report.backends[0].authentication.actionAvailable, false)
  assert.equal(report.backends[0].lifecycle.state, 'installed')
})

test('installs npm packages globally and verifies readiness', async () => {
  const { calls, options } = installOptions()
  const events = []
  const result = await installBackend('opencode', {
    ...options,
    onProgress: event => events.push(event),
  })
  assert.equal(result.ok, true)
  assert.match(result.loginHint, /OpenCode/)
  assert.equal(result.authentication.status, 'unknown')
  assert.equal(result.authentication.required, false)
  assert.deepEqual(calls, [[
    '/usr/local/bin/npm',
    ['install', '-g', 'opencode-ai@1.18.5'],
  ]])
  assert.deepEqual(
    events.map(event => event.phase),
    ['start', 'done'],
  )
  assert.equal(events[0].display, 'npm install -g opencode-ai@1.18.5')
})

test('describes backend-owned authentication actions', () => {
  assert.deepEqual(authenticationSupport('qoder', {
    env: {},
    platform: 'darwin',
  }), {
    required: true,
    supported: true,
    command: 'qodercli login',
  })
  assert.deepEqual(authenticationSupport('codebuddy', {
    env: {},
    platform: 'darwin',
  }), {
    required: true,
    supported: true,
    command: 'codebuddy',
  })
  assert.equal(authenticationSupport('opencode', {
    env: {
      DASHSCOPE_API_KEY: 'key',
      QWEN_AUDIO_AGENT_BACKEND_MODEL: 'qwen3.7-max',
    },
    platform: 'darwin',
  }).required, false)
  assert.deepEqual(authenticationSupport('deepseek', {
    env: {},
    platform: 'darwin',
  }), {
    required: true,
    supported: true,
    command: 'dsh web',
  })
})

test('installs the DeepSeek Harness CLI and ACP components', async () => {
  const calls = []
  const result = await installBackend('deepseek', {
    env: { DEEPSEEK_API_KEY: 'test-key' },
    platform: 'darwin',
    spawnImpl: fakeSpawn(calls),
    find: () => '/usr/local/bin/npm',
    inspect: async () => readyReport('deepseek'),
  })
  assert.equal(result.ok, true)
  assert.equal(calls.length, 11)
  assert.deepEqual(calls[0][1], [
    'install', '-g', '--registry=https://registry.npmjs.org/',
    '@deepseek-ai/dsh@0.1.0-rc.6',
  ])
  assert.deepEqual(calls.at(-1)[1], [
    'install', '-g', '--registry=https://registry.npmjs.org/',
    '@deepseek-ai/dsh-acp-demo@0.1.0-rc.6',
  ])
})

test('adds only the missing DeepSeek Harness CLI after an ACP-only install', async () => {
  const calls = []
  let inspection = 0
  const result = await installBackend('deepseek', {
    env: { DEEPSEEK_API_KEY: 'test-key' },
    platform: 'darwin',
    spawnImpl: fakeSpawn(calls),
    find: () => '/usr/local/bin/npm',
    inspect: async () => {
      inspection += 1
      return {
        backends: [{
          id: 'deepseek',
          ready: inspection > 1,
          backend: { ready: inspection > 1 },
          adapter: { ready: true },
          issues: [],
        }],
      }
    },
  })
  assert.equal(result.ok, true)
  assert.deepEqual(calls, [[
    '/usr/local/bin/npm',
    [
      'install', '-g', '--registry=https://registry.npmjs.org/',
      '@deepseek-ai/dsh@0.1.0-rc.6',
    ],
  ]])
})

test('runs multi-step installs in order and stops on failure', async () => {
  const calls = []
  const failed = await installBackend('codex', {
    env: {},
    platform: 'darwin',
    spawnImpl: fakeSpawn(calls, [1]),
    find: () => '/usr/local/bin/npm',
    inspect: async () => readyReport('codex'),
  })
  assert.equal(failed.ok, false)
  assert.equal(failed.error.code, 'STEP_FAILED')
  assert.equal(failed.error.exitCode, 1)
  assert.equal(calls.length, 1, '失败后不再执行后续步骤')

  const succeeded = await installBackend('codex', {
    env: {},
    platform: 'darwin',
    spawnImpl: fakeSpawn(calls, [0, 0]),
    find: () => '/usr/local/bin/npm',
    inspect: async () => readyReport('codex'),
  })
  assert.equal(succeeded.ok, true)
  assert.deepEqual(calls.slice(1), [
    ['/usr/local/bin/npm', ['install', '-g', '@openai/codex@0.146.0']],
    ['/usr/local/bin/npm', ['install', '-g', '@agentclientprotocol/codex-acp@1.1.7']],
  ])
})

test('streams output chunks through the progress callback', async () => {
  const calls = []
  const events = []
  await installBackend('opencode', {
    env: {},
    platform: 'darwin',
    spawnImpl: (command, args) => {
      calls.push([command, args])
      return fakeChild(0, { stdout: ['added 1 package\n'], stderr: ['warn\n'] })
    },
    find: () => '/usr/local/bin/npm',
    inspect: async () => readyReport('opencode'),
    onProgress: event => events.push(event),
  })
  const output = events.filter(event => event.phase === 'output')
  assert.deepEqual(
    output.map(event => [event.stream, event.chunk]),
    [['stdout', 'added 1 package\n'], ['stderr', 'warn\n']],
  )
})

test('script steps run only after confirmation', async () => {
  const calls = []
  const declined = await installBackend('hermes', {
    env: {},
    platform: 'darwin',
    spawnImpl: fakeSpawn(calls),
    confirmStep: async () => false,
    inspect: async () => readyReport('hermes'),
  })
  assert.equal(declined.ok, false)
  assert.equal(declined.error.code, 'DECLINED')
  assert.equal(calls.length, 0, '未确认前不得执行任何命令')

  const confirmed = []
  const accepted = await installBackend('hermes', {
    env: {},
    platform: 'darwin',
    spawnImpl: fakeSpawn(calls),
    confirmStep: async step => {
      confirmed.push(step)
      return true
    },
    inspect: async () => readyReport('hermes'),
  })
  assert.equal(accepted.ok, true)
  assert.match(confirmed[0].command, /hermes-agent\.nousresearch\.com/)
  assert.equal(calls[0][0], '/bin/sh')
  assert.deepEqual(calls[0][1][0], '-c')
})

test('reports a structured error when npm is missing', async () => {
  const calls = []
  const result = await installBackend('opencode', {
    env: {},
    platform: 'darwin',
    spawnImpl: fakeSpawn(calls),
    find: () => '',
    inspect: async () => readyReport('opencode'),
  })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'NPM_MISSING')
  assert.equal(calls.length, 0)
})

test('resolves npm.cmd on Windows', async () => {
  const found = []
  const result = await installBackend('opencode', {
    env: {},
    platform: 'win32',
    spawnImpl: fakeSpawn([]),
    find: command => {
      found.push(command)
      return command === 'npm.cmd' ? 'C:\\nodejs\\npm.cmd' : ''
    },
    inspect: async () => readyReport('opencode'),
  })
  assert.equal(result.ok, true)
  assert.equal(found[0], 'npm.cmd')
})

test('fails verification when the backend stays unavailable', async () => {
  const report = {
    selected: '',
    backends: [{
      id: 'opencode',
      ready: false,
      issues: ['PATH 中未找到 OpenCode'],
    }],
  }
  const result = await installBackend('opencode', {
    env: {},
    platform: 'darwin',
    spawnImpl: fakeSpawn([]),
    find: () => '/usr/local/bin/npm',
    inspect: async () => report,
  })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'VERIFY_FAILED')
  assert.equal(result.error.message, 'PATH 中未找到 OpenCode')
  assert.equal(result.report, report)
})

test('skips ready components and installs only the missing adapter', async () => {
  const calls = []
  const events = []
  let inspection = 0
  const result = await installBackend('codex', {
    env: {},
    platform: 'darwin',
    spawnImpl: fakeSpawn(calls),
    find: () => '/usr/local/bin/npm',
    inspect: async () => {
      inspection += 1
      return {
        selected: '',
        backends: [{
          id: 'codex',
          label: 'Codex',
          ready: inspection > 1,
          selected: false,
          issues: [],
          backend: { ready: true, source: 'installed' },
          adapter: inspection > 1
            ? { ready: true, source: 'installed' }
            : { ready: false, source: 'adapter' },
        }],
      }
    },
    onProgress: event => events.push(event),
  })
  assert.equal(result.ok, true)
  assert.deepEqual(calls, [[
    '/usr/local/bin/npm',
    ['install', '-g', '@agentclientprotocol/codex-acp@1.1.7'],
  ]])
  assert.deepEqual(
    events.map(event => event.phase),
    ['skip', 'start', 'done'],
  )
})

test('reports alreadyInstalled when every component is ready', async () => {
  const calls = []
  let inspections = 0
  const result = await installBackend('opencode', {
    env: {},
    platform: 'darwin',
    spawnImpl: fakeSpawn(calls),
    find: () => '/usr/local/bin/npm',
    inspect: async () => {
      inspections += 1
      return {
        selected: '',
        backends: [{
          id: 'opencode',
          ready: true,
          issues: [],
          backend: { ready: true, source: 'installed' },
          adapter: { ready: true, source: 'native' },
        }],
      }
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.alreadyInstalled, true)
  assert.equal(calls.length, 0, '已就绪时不执行任何安装命令')
  assert.equal(inspections, 1, '已就绪时不再重复检测')
})

test('locates the target backend inside a full re-inspection report', async () => {
  const result = await installBackend('kimi', {
    env: {},
    platform: 'darwin',
    spawnImpl: fakeSpawn([]),
    find: () => '/usr/local/bin/npm',
    inspect: async () => ({
      selected: '',
      backends: [
        { id: 'opencode', ready: false, issues: ['未安装'] },
        { id: 'kimi', ready: true, issues: [] },
      ],
    }),
  })
  assert.equal(result.ok, true)
})

test('rejects unsupported backends without running commands', async () => {
  const calls = []
  const result = await installBackend('acp', {
    env: {},
    platform: 'darwin',
    spawnImpl: fakeSpawn(calls),
  })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'UNSUPPORTED')
  assert.equal(calls.length, 0)
})
