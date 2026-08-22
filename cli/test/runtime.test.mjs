import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { resolve } from 'node:path'
import test from 'node:test'
import {
  assertGatewayCompatibility,
  assertRealtimeGatewayCompatibility,
  ensureRuntime,
  ManagedRuntime,
  resolveBackend,
  waitForGateway,
} from '../src/runtime.mjs'
import {
  resolveRealtimeFrontendConfiguration,
} from '../../shared/realtime-provider-catalog.mjs'

const DEFAULT_FRONTEND_ENV = { DASHSCOPE_API_KEY: 'key' }
const DEFAULT_FRONTEND = resolveRealtimeFrontendConfiguration(
  DEFAULT_FRONTEND_ENV,
)

function childProcess() {
  const child = new EventEmitter()
  child.exitCode = null
  child.signalCode = null
  child.kill = signal => {
    child.signalCode = signal
  }
  return child
}

function health(overrides = {}, frontendOverrides = {}) {
  return {
    ok: true,
    voiceConfigured: true,
    realtimeProvider: DEFAULT_FRONTEND.provider,
    realtimeConfigurationSignature: DEFAULT_FRONTEND.signature,
    ...frontendOverrides,
    backend: {
      kind: 'opencode',
      ownership: 'owned',
      baseUrl: 'http://127.0.0.1:4096',
      ok: true,
      ...overrides,
    },
  }
}

const options = {
  url: 'http://127.0.0.1:3101',
  backend: 'opencode',
  backendUrl: 'http://127.0.0.1:4096',
}

const root = resolve('/repo')

function dependencies(overrides = {}) {
  return {
    root,
    env: { ...DEFAULT_FRONTEND_ENV },
    loadEnvironment: () => {},
    requireCredential: () => {},
    ...overrides,
  }
}

test('reuses one healthy Gateway without starting processes', async () => {
  const calls = []
  const runtime = await ensureRuntime(options, {
    ...dependencies(),
    fetchImpl: async () => ({ json: async () => health() }),
    spawnImpl: (...args) => {
      calls.push(args)
      return childProcess()
    },
  })
  assert.equal(runtime.ownsProcesses, false)
  assert.deepEqual(calls, [])
})

test('compares an explicitly requested model with health profile identity', () => {
  assert.throws(() => assertRealtimeGatewayCompatibility({
    realtimeProvider: 'dashscope',
    realtimeConfigurationSignature: DEFAULT_FRONTEND.signature,
    realtimeModelProfile: { id: 'qwen3.5-omni-plus-realtime' },
  }, { ...DEFAULT_FRONTEND_ENV, QWEN_AUDIO_REALTIME_MODEL: 'qwen3.5-omni-flash-realtime' }), /Realtime 模型.*不一致/)
  assert.doesNotThrow(() => assertRealtimeGatewayCompatibility({
    realtimeProvider: 'dashscope',
    realtimeConfigurationSignature: DEFAULT_FRONTEND.signature,
    realtimeModelProfile: { id: DEFAULT_FRONTEND.dashscopeModel },
  }, DEFAULT_FRONTEND_ENV))
})

test('rejects an existing Gateway using a different realtime frontend', async () => {
  await assert.rejects(
    ensureRuntime(options, {
      ...dependencies({
        env: {
          QWEN_AUDIO_REALTIME_PROVIDER: 'speech-to-speech',
        },
      }),
      fetchImpl: async () => ({ json: async () => health() }),
    }),
    /Realtime 前台.*不一致/,
  )
})

test('reuses an existing Gateway with the same speech-to-speech endpoint', async () => {
  const env = {
    QWEN_AUDIO_REALTIME_PROVIDER: 'speech-to-speech',
    SPEECH_TO_SPEECH_REALTIME_URL: 'ws://127.0.0.1:8765/v1/realtime',
  }
  const frontend = resolveRealtimeFrontendConfiguration(env)
  const runtime = await ensureRuntime(options, {
    ...dependencies({ env }),
    fetchImpl: async () => ({
      json: async () => health({}, {
        realtimeProvider: frontend.provider,
        realtimeConfigurationSignature: frontend.signature,
      }),
    }),
  })
  assert.equal(runtime.ownsProcesses, false)
  assert.doesNotThrow(() => assertRealtimeGatewayCompatibility({
    realtimeProvider: frontend.provider,
    realtimeConfigurationSignature: frontend.signature,
  }, env))
})

test('rejects an existing Gateway using a stale speech-to-speech endpoint', () => {
  const runningEnv = {
    QWEN_AUDIO_REALTIME_PROVIDER: 'speech-to-speech',
    SPEECH_TO_SPEECH_REALTIME_URL: 'ws://127.0.0.1:8765/v1/realtime',
  }
  const requestedEnv = {
    ...runningEnv,
    SPEECH_TO_SPEECH_REALTIME_URL: 'ws://127.0.0.1:9876/v1/realtime',
  }
  const running = resolveRealtimeFrontendConfiguration(runningEnv)

  assert.throws(() => assertRealtimeGatewayCompatibility({
    realtimeProvider: running.provider,
    realtimeConfigurationSignature: running.signature,
  }, requestedEnv), /前台参数.*不一致/)
})

test('does not reuse an older Gateway without a realtime configuration signature', () => {
  assert.throws(() => assertRealtimeGatewayCompatibility({
    realtimeProvider: 'dashscope',
  }, DEFAULT_FRONTEND_ENV), /未报告完整/)
})

test('realtime configuration signature changes with Gateway-owned credentials', () => {
  const first = resolveRealtimeFrontendConfiguration({
    DASHSCOPE_API_KEY: 'first-key',
  })
  const second = resolveRealtimeFrontendConfiguration({
    DASHSCOPE_API_KEY: 'second-key',
  })

  assert.notEqual(first.signature, second.signature)
})

test('reuses a managed Gateway after it selected a private free backend port', async () => {
  const runtime = await ensureRuntime(options, {
    ...dependencies(),
    fetchImpl: async () => ({
      json: async () => health({
        baseUrl: 'http://127.0.0.1:45123',
      }),
    }),
  })
  assert.equal(runtime.ownsProcesses, false)
})

test('starts only the Gateway and waits for its managed backend', async () => {
  const calls = []
  let reads = 0
  const gateway = childProcess()
  const runtime = await ensureRuntime(options, {
    ...dependencies(),
    fetchImpl: async () => {
      reads += 1
      if (reads === 1) throw new Error('offline')
      return {
        json: async () => health({
          baseUrl: 'http://127.0.0.1:45123',
        }),
      }
    },
    spawnImpl: (command, args, spawnOptions) => {
      calls.push([command, args, spawnOptions])
      return gateway
    },
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], process.execPath)
  assert.deepEqual(calls[0][1], [resolve(root, 'server/src/index.mjs')])
  assert.equal(calls[0][2].env.OPENCODE_BASE_URL, 'http://127.0.0.1:4096')
  assert.deepEqual(
    calls[0][2].stdio,
    ['inherit', 'inherit', 'inherit', 'ipc'],
  )
  assert.equal(runtime.ownsProcesses, true)
})

test('starts only qwen-audio-agent Gateway for an external OpenClaw Gateway', async () => {
  const calls = []
  let reads = 0
  const externalOptions = {
    url: 'http://127.0.0.1:3101',
    backend: 'openclaw',
    backendUrl: '',
  }
  const env = {
    ...DEFAULT_FRONTEND_ENV,
    AGENT_PROTOCOL: 'openclaw',
    OPENCLAW_BASE_URL: 'wss://openclaw.example.test',
    OPENCLAW_GATEWAY_TOKEN: 'existing-token',
  }
  const runtime = await ensureRuntime(externalOptions, {
    ...dependencies({ env }),
    fetchImpl: async () => {
      reads += 1
      if (reads === 1) throw new Error('offline')
      return {
        json: async () => health({
          kind: 'openclaw',
          ownership: 'external',
          baseUrl: 'wss://openclaw.example.test',
        }),
      }
    },
    spawnImpl: (...args) => {
      calls.push(args)
      return childProcess()
    },
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0][2].env.AGENT_PROTOCOL, 'openclaw')
  assert.equal(
    calls[0][2].env.QWEN_AUDIO_AGENT_BACKEND_OWNERSHIP,
    'external',
  )
  assert.equal(
    calls[0][2].env.OPENCLAW_BASE_URL,
    'wss://openclaw.example.test',
  )
  assert.equal(calls[0][2].env.OPENCLAW_PORT, '443')
  assert.equal(runtime.ownsProcesses, true)
})

test('reports the last backend error when startup times out', async () => {
  await assert.rejects(
    waitForGateway('http://127.0.0.1:3101', {
      fetchImpl: async () => ({
        json: async () => health({
          ok: false,
          error: 'OpenClaw ACP connection closed',
        }),
      }),
      requireBackend: true,
      timeoutMs: 5,
      intervalMs: 1,
    }),
    /OpenClaw ACP connection closed/,
  )
})

test('never starts a backend beside an existing Gateway', async () => {
  await assert.rejects(
    ensureRuntime(options, {
      ...dependencies(),
      fetchImpl: async () => ({
        json: async () => health({ ok: false }),
      }),
    }),
    /Gateway 启动的后台 Agent 未就绪/,
  )
})

test('rejects an existing Gateway with different ownership settings', async () => {
  await assert.rejects(
    ensureRuntime(options, {
      ...dependencies(),
      fetchImpl: async () => ({
        json: async () => health({
          kind: 'openclaw',
          baseUrl: 'http://127.0.0.1:18789',
        }),
      }),
    }),
    /与当前配置.*不一致/,
  )
})

test('resolves an empty backend as frontend-only mode', () => {
  assert.deepEqual(resolveBackend({}, {}), {
    enabled: false,
    protocol: null,
    ownership: null,
    permissionMode: null,
    agentId: '',
    baseUrl: null,
  })
  assert.deepEqual(
    resolveBackend({ backend: 'none' }, {}),
    resolveBackend({}, {}),
  )
  assert.deepEqual(
    resolveBackend({}, { AGENT_PROTOCOL: 'none' }),
    resolveBackend({}, {}),
  )
})

test('starts and reuses a frontend-only Gateway without a backend', async () => {
  const frontendOnlyOptions = {
    url: 'http://127.0.0.1:3101',
    backend: '',
  }
  const frontendOnlyHealth = {
    ok: true,
    voiceConfigured: true,
    realtimeProvider: DEFAULT_FRONTEND.provider,
    realtimeConfigurationSignature: DEFAULT_FRONTEND.signature,
    backend: {
      enabled: false,
      ok: true,
      status: 'not_configured',
    },
  }
  const runtime = await ensureRuntime(frontendOnlyOptions, {
    ...dependencies(),
    fetchImpl: async () => ({
      json: async () => frontendOnlyHealth,
    }),
  })
  assert.equal(runtime.ownsProcesses, false)
  assert.doesNotThrow(() => assertGatewayCompatibility(
    frontendOnlyHealth,
    resolveBackend(frontendOnlyOptions, {}),
  ))
})

test('keeps frontend-only mode explicit when spawning the Gateway', async () => {
  const calls = []
  let reads = 0
  const runtime = await ensureRuntime({
    url: 'http://127.0.0.1:3101',
    backend: '',
  }, {
    ...dependencies({
      env: {
        AGENT_PROTOCOL: '',
        DASHSCOPE_API_KEY: 'key',
      },
      loadEnvironment: () => {},
    }),
    fetchImpl: async () => {
      reads += 1
      if (reads === 1) throw new Error('offline')
      return {
        json: async () => ({
          ok: true,
          voiceConfigured: true,
          realtimeProvider: DEFAULT_FRONTEND.provider,
          realtimeConfigurationSignature: DEFAULT_FRONTEND.signature,
          backend: {
            enabled: false,
            ok: true,
            status: 'not_configured',
          },
        }),
      }
    },
    spawnImpl: (command, args, spawnOptions) => {
      calls.push([command, args, spawnOptions])
      return childProcess()
    },
  })
  assert.equal(runtime.ownsProcesses, true)
  assert.equal(calls[0][2].env.AGENT_PROTOCOL, '')
  runtime.close()
})

test('derives selected backend configuration', () => {
  assert.deepEqual(resolveBackend({
    backend: 'openclaw',
    backendAgent: 'build',
    backendUrl: 'http://localhost:18789/path',
  }, {}), {
    protocol: 'openclaw',
    ownership: 'external',
    permissionMode: 'native',
    agentId: 'build',
    baseUrl: 'http://localhost:18789',
  })
})

test('owns OpenClaw only when no Gateway address is explicitly configured', () => {
  assert.deepEqual(resolveBackend({
    backend: 'openclaw',
    backendUrl: 'http://127.0.0.1:18789',
    backendUrlSpecified: false,
  }, {}), {
    protocol: 'openclaw',
    ownership: 'owned',
    permissionMode: 'native',
    agentId: '',
    baseUrl: 'http://127.0.0.1:18789',
  })
  assert.equal(resolveBackend({}, {
    AGENT_PROTOCOL: 'openclaw',
    OPENCLAW_BASE_URL: 'http://127.0.0.1:18789',
  }).ownership, 'external')
})

test('derives Qoder without an HTTP backend', () => {
  assert.deepEqual(resolveBackend({
    backend: 'qoder',
  }, {}), {
    protocol: 'qoder',
    ownership: 'owned',
    permissionMode: 'native',
    agentId: '',
    baseUrl: null,
  })
})

test('derives generic ACP without an HTTP backend', () => {
  assert.deepEqual(resolveBackend({
    backend: 'acp',
  }, {}), {
    protocol: 'acp',
    ownership: 'owned',
    permissionMode: 'native',
    agentId: '',
    baseUrl: null,
  })
})

test('derives named local ACP backends without an HTTP URL', () => {
  for (const backend of ['kimi', 'hermes', 'codebuddy', 'codex', 'claude']) {
    assert.deepEqual(resolveBackend({
      backend,
    }, {}), {
      protocol: backend,
      ownership: 'owned',
      permissionMode: 'native',
      agentId: '',
      baseUrl: null,
    })
  }
})

test('Pi always resolves to its effective full permission mode', () => {
  // Pi 没有权限审批机制，CLI 解析必须与健康状态一致地上报 full。
  for (const configured of [undefined, 'native', 'full']) {
    assert.deepEqual(resolveBackend({
      backend: 'pi',
      ...(configured
        ? { backendPermissionMode: configured }
        : {}),
    }, {}), {
      protocol: 'pi',
      ownership: 'owned',
      permissionMode: 'full',
      agentId: '',
      baseUrl: null,
    })
  }
})

test('requires complete identity before reusing a Gateway', () => {
  assert.throws(
    () => assertGatewayCompatibility({ backend: { ok: true } }, {
      protocol: 'opencode',
      baseUrl: 'http://127.0.0.1:4096',
    }),
    /未报告完整/,
  )
})

test('reports a Qoder versus OpenCode mismatch instead of incomplete identity', () => {
  assert.throws(
    () => assertGatewayCompatibility({
      backend: {
        ok: true,
        kind: 'qoder',
        ownership: 'owned',
        permissionMode: 'native',
        baseUrl: null,
      },
    }, {
      protocol: 'opencode',
      ownership: 'owned',
      permissionMode: 'native',
      baseUrl: 'http://127.0.0.1:4096',
    }),
    /使用 qoder.*与当前配置 opencode.*不一致/,
  )
})

test('stops the complete POSIX process group for the Gateway', () => {
  const child = childProcess()
  child.pid = 4321
  const signals = []
  const runtime = new ManagedRuntime([child], {
    platform: 'darwin',
    killImpl: (pid, signal) => signals.push([pid, signal]),
  })
  runtime.close('SIGINT')
  assert.deepEqual(signals, [[-4321, 'SIGINT']])
})

test('uses direct child termination on Windows', () => {
  const child = childProcess()
  child.pid = 4321
  const runtime = new ManagedRuntime([child], { platform: 'win32' })
  runtime.close()
  assert.equal(child.signalCode, 'SIGTERM')
})
