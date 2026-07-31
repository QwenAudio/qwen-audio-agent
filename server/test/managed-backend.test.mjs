import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'
import {
  resolveOpenClawGatewayToken,
  syncOpenClawGatewayTokenFile,
  writeIsolatedOpenClawConfig,
} from '../src/process/backend-drivers/openclaw-auth.mjs'
import {
  applyBackendPermissionMode,
  resolveManagedBackend,
  startManagedBackend,
} from '../src/process/managed-backend.mjs'

function childProcess() {
  const child = new EventEmitter()
  child.exitCode = null
  child.signalCode = null
  child.pid = 4242
  child.kill = signal => {
    child.signalCode = signal
  }
  return child
}

function openClawFixture() {
  const root = mkdtempSync(resolve(tmpdir(), 'qwaudio-openclaw-'))
  const stateDirectory = resolve(root, '.openclaw')
  mkdirSync(stateDirectory, { recursive: true })
  return {
    root,
    configPath: resolve(stateDirectory, 'openclaw.json'),
    tokenPath: resolve(root, 'qwaudio', 'gateway-secret'),
  }
}

function assertPrivateMode(filePath) {
  // Windows secures files through ACLs and does not expose POSIX mode bits.
  if (process.platform !== 'win32') {
    assert.equal(statSync(filePath).mode & 0o777, 0o600)
  }
}

test('reads the configured OpenClaw Gateway credential', () => {
  const fixture = openClawFixture()
  writeFileSync(fixture.configPath, `{
    gateway: { auth: { token: 'configured-value' } },
  }`)
  assert.equal(resolveOpenClawGatewayToken({
    env: {},
    homeDirectory: fixture.root,
  }), 'configured-value')
})

test('writes the resolved credential to the private ACP file', () => {
  const fixture = openClawFixture()
  writeFileSync(fixture.configPath, JSON.stringify({
    gateway: { auth: { token: '${PRIVATE_VALUE}' } },
  }))
  assert.equal(syncOpenClawGatewayTokenFile({
    env: { PRIVATE_VALUE: 'resolved-value' },
    homeDirectory: fixture.root,
    targetPath: fixture.tokenPath,
  }), true)
  assert.equal(readFileSync(fixture.tokenPath, 'utf8'), 'resolved-value\n')
  assertPrivateMode(fixture.tokenPath)
})

test('prefers an explicit OpenClaw Gateway credential', () => {
  assert.equal(resolveOpenClawGatewayToken({
    env: { OPENCLAW_GATEWAY_TOKEN: 'explicit-value' },
  }), 'explicit-value')
})

test('copies OpenClaw capabilities without external message channels', () => {
  const fixture = openClawFixture()
  const isolatedPath = resolve(fixture.root, 'isolated', 'openclaw.json')
  writeFileSync(fixture.configPath, `{
    models: { providers: { user: { models: [] } } },
    agents: { defaults: { model: 'user/default' } },
    plugins: { allow: ['example'] },
    channels: { dingtalk: { enabled: true } },
  }`)
  assert.equal(writeIsolatedOpenClawConfig({
    sourcePath: fixture.configPath,
    targetPath: isolatedPath,
  }), true)
  const isolated = JSON.parse(readFileSync(isolatedPath, 'utf8'))
  assert.deepEqual(isolated.models, {
    providers: { user: { models: [] } },
  })
  assert.equal(isolated.agents.defaults.model, 'user/default')
  assert.deepEqual(isolated.plugins.allow, ['example'])
  assert.equal('channels' in isolated, false)
  assertPrivateMode(isolatedPath)
})

test('Gateway-owned backend moves away from occupied ports', async () => {
  const env = {
    AGENT_PROTOCOL: 'openclaw',
    OPENCLAW_BASE_URL: 'http://127.0.0.1:18789',
    DASHSCOPE_API_KEY: 'test-key',
    QWEN_AUDIO_AGENT_BACKEND_MODEL: 'qwen-plus',
  }
  const calls = []
  const child = childProcess()
  const signals = []
  const runtime = await startManagedBackend({
    root: '/repo',
    env,
    platform: 'darwin',
    isAddressInUse: async () => true,
    findFreeAddress: async () => 'http://127.0.0.1:45678',
    spawnImpl: (...args) => {
      calls.push(args)
      return child
    },
  })
  runtime.killImpl = (pid, signal) => signals.push([pid, signal])
  assert.equal(env.OPENCLAW_BASE_URL, 'http://127.0.0.1:45678')
  assert.equal(env.OPENCLAW_PORT, '45678')
  assert.equal(calls[0][0], resolve('/repo', 'scripts/openclaw-gateway'))
  assert.equal(calls[0][2].env.QWEN_AUDIO_AGENT_ENV_LOADED, '1')
  runtime.close()
  assert.deepEqual(signals, [[-4242, 'SIGTERM']])
})

test('force-stops a managed backend that ignores graceful shutdown', async () => {
  const env = {
    AGENT_PROTOCOL: 'openclaw',
    OPENCLAW_BASE_URL: 'http://127.0.0.1:18789',
  }
  const child = childProcess()
  const signals = []
  const runtime = await startManagedBackend({
    root: '/repo',
    env,
    platform: 'darwin',
    isAddressInUse: async () => false,
    spawnImpl: () => child,
  })
  runtime.killImpl = (pid, signal) => signals.push([pid, signal])
  await runtime.stop('SIGTERM', 1)
  assert.deepEqual(signals, [
    [-4242, 'SIGTERM'],
    [-4242, 'SIGKILL'],
  ])
})

test('runs without a managed process when no backend is selected', async () => {
  assert.equal(resolveManagedBackend({}), null)
  assert.equal(resolveManagedBackend({ AGENT_PROTOCOL: 'none' }), null)
  const runtime = await startManagedBackend({
    root: '/repo',
    env: {},
    spawnImpl: () => {
      throw new Error('frontend-only mode must not spawn a backend')
    },
  })
  assert.equal(runtime.ownsProcess, false)
})

test('normalizes the selected backend', () => {
  assert.deepEqual(resolveManagedBackend({
    AGENT_PROTOCOL: 'opencode',
    OPENCODE_BASE_URL: 'http://localhost:4096/path',
  }), {
    protocol: 'opencode',
    ownership: 'owned',
    permissionMode: 'native',
    baseUrl: 'http://localhost:4096',
  })
})

test('Qoder is managed inside the Gateway without a separate server', async () => {
  assert.deepEqual(resolveManagedBackend({
    AGENT_PROTOCOL: 'qoder',
  }), {
    protocol: 'qoder',
    ownership: 'owned',
    permissionMode: 'native',
    baseUrl: null,
  })
  const runtime = await startManagedBackend({
    root: '/repo',
    env: { AGENT_PROTOCOL: 'qoder' },
    spawnImpl: () => {
      throw new Error('Qoder must not spawn a separate backend server')
    },
  })
  assert.equal(runtime.ownsProcess, false)
})

test('generic ACP is managed as a Gateway child without a separate server', async () => {
  assert.deepEqual(resolveManagedBackend({
    AGENT_PROTOCOL: 'acp',
  }), {
    protocol: 'acp',
    ownership: 'owned',
    permissionMode: 'native',
    baseUrl: null,
  })
  const runtime = await startManagedBackend({
    root: '/repo',
    env: {
      AGENT_PROTOCOL: 'acp',
      ACP_COMMAND: 'example-agent',
    },
    spawnImpl: () => {
      throw new Error('generic ACP must not spawn a separate backend server')
    },
  })
  assert.equal(runtime.ownsProcess, false)
})

test('additional ACP backends run inside the Gateway without an HTTP server', async () => {
  for (const protocol of ['kimi', 'hermes', 'codebuddy', 'codex', 'claude']) {
    assert.deepEqual(resolveManagedBackend({
      AGENT_PROTOCOL: protocol,
    }), {
      protocol,
      ownership: 'owned',
      permissionMode: 'native',
      baseUrl: null,
    })
    const runtime = await startManagedBackend({
      root: '/repo',
      env: { AGENT_PROTOCOL: protocol },
      spawnImpl: () => {
        throw new Error(`${protocol} must not spawn an HTTP backend server`)
      },
    })
    assert.equal(runtime.ownsProcess, false)
  }
})

test('full permission mode configures managed OpenCode without discarding inline config', () => {
  const env = {
    AGENT_PROTOCOL: 'opencode',
    QWEN_AUDIO_AGENT_BACKEND_PERMISSION_MODE: 'full',
    OPENCODE_COORDINATOR_AGENT: 'custom-coordinator',
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      theme: 'system',
      agent: {
        build: { model: 'provider/model', permission: 'ask' },
      },
    }),
  }
  const backend = resolveManagedBackend(env)
  applyBackendPermissionMode(env, backend)
  const inline = JSON.parse(env.OPENCODE_CONFIG_CONTENT)
  assert.equal(backend.permissionMode, 'full')
  assert.equal(inline.theme, 'system')
  assert.equal(inline.permission, 'allow')
  assert.equal(inline.agent.build.model, 'provider/model')
  assert.equal(inline.agent.build.permission, 'allow')
  assert.equal(
    inline.agent['custom-coordinator'].permission,
    'allow',
  )
  assert.equal(inline.agent['qwen-audio-agent-backend'], undefined)
})

test('full permission mode rejects backends that cannot support it safely', () => {
  assert.throws(() => resolveManagedBackend({
    AGENT_PROTOCOL: 'openclaw',
    QWEN_AUDIO_AGENT_BACKEND_PERMISSION_MODE: 'full',
  }), /OpenClaw/)
})
