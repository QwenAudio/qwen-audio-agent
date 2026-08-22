import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import test from 'node:test'
import {
  AcpBackendAdapter,
  acpBackendProfile,
} from '../src/agent/acp-backend-adapter.mjs'

function completed(speech = '完成') {
  return JSON.stringify({
    work_id: 'work-one',
    state: 'completed',
    mode: 'respond',
    presentation: { speech, inline: null },
  })
}

function delegated(result) {
  return JSON.stringify({
    work_id: 'work-one',
    state: 'delegated',
    mode: 'delegate',
    delegation_id: result.delegation_id,
    target_session_id: result.session_id,
    presentation: { speech: '已经交给独立项目处理。', inline: null },
  })
}

function fakeToolServer() {
  return {
    context: null,
    registerCalls: 0,
    updateCalls: 0,
    releaseCalls: 0,
    registrations: [],
    async register(context) {
      this.context = context
      this.registerCalls += 1
      const registration = {
        context,
        released: false,
        descriptor: {
          type: 'http',
          name: 'test',
          url: `http://127.0.0.1/mcp/${this.registerCalls}`,
          headers: [],
        },
        update: nextContext => {
          if (registration.released) return false
          registration.context = nextContext
          this.context = nextContext
          this.updateCalls += 1
          return true
        },
        release: () => {
          if (registration.released) return false
          registration.released = true
          this.releaseCalls += 1
          return true
        },
        call: (name, input) => {
          if (registration.released) {
            throw new Error('Session MCP interface unavailable')
          }
          return registration.context[name](input)
        },
      }
      this.registrations.push(registration)
      return registration
    },
    async close() {},
  }
}

function fakeAcpClient({
  action = 'start',
  holdTarget = false,
  scopeListsByCwd = false,
} = {}) {
  const calls = []
  const sessions = new Map([
    ['previous-session', {
      sessionId: 'previous-session',
      cwd: '/previous',
      title: 'Previous project',
      updatedAt: '2026-01-01T00:00:00Z',
    }],
  ])
  let toolServer
  let nextId = 0
  const targetGate = holdTarget
    ? Promise.withResolvers()
    : { promise: Promise.resolve('third-layer-result') }
  return {
    calls,
    sessions,
    targetGate,
    bind(server) {
      toolServer = server
    },
    async start() {
      return {
        agentInfo: { name: 'fake-acp' },
        agentCapabilities: {
          loadSession: true,
          mcpCapabilities: { http: true },
          sessionCapabilities: { list: {}, resume: {}, close: {} },
        },
      }
    },
    async newSession(options) {
      const session = {
        sessionId: options.role === 'coordinator'
          ? 'coordinator-session'
          : `project-${++nextId}`,
        cwd: options.cwd,
        ...options,
      }
      calls.push(['new', session])
      sessions.set(session.sessionId, session)
      return session
    },
    async resumeSession(sessionId, options) {
      const session = {
        ...(sessions.get(sessionId) || {}),
        sessionId,
        ...options,
      }
      calls.push(['resume', sessionId, options])
      sessions.set(sessionId, session)
      return session
    },
    async listSessions(options = {}) {
      calls.push(['list', options])
      const values = [...sessions.values()]
      if (!scopeListsByCwd) return values
      const cwd = options.cwd || '/coordinator'
      return values.filter(session => session.cwd === cwd)
    },
    async prompt(sessionId, prompt, options = {}) {
      calls.push(['prompt', sessionId, prompt])
      if (sessionId !== 'coordinator-session') {
        if (options.signal?.aborted) throw options.signal.reason
        return new Promise((resolve, reject) => {
          const abort = () => reject(options.signal.reason)
          options.signal?.addEventListener('abort', abort, { once: true })
          targetGate.promise.then(content => {
            options.signal?.removeEventListener('abort', abort)
            resolve({
              content,
              response: { stopReason: 'end_turn' },
            })
          }, reject)
        })
      }
      if (prompt.includes('plain follow-up')) {
        return {
          content: completed('已同步取消事实'),
          response: { stopReason: 'end_turn' },
        }
      }
      if (prompt.includes('kind="cancel"')) {
        const record = [...sessions.values()].find(item => (
          item.role === 'project'
        ))
        await toolServer.context.cancelSession({
          session_id: record.sessionId,
        })
        return {
          content: completed('已取消'),
          response: { stopReason: 'end_turn' },
        }
      }
      if (prompt.includes('kind="status"')) {
        const status = await toolServer.context.sessionStatus({
          session_id: action === 'send'
            ? 'previous-session'
            : 'project-1',
        })
        return {
          content: completed(`当前状态：${status.status}`),
          response: { stopReason: 'end_turn' },
        }
      }
      if (prompt.includes('qwen_audio_agent_delegation_result')) {
        return {
          content: completed('第三层结果已整理'),
          response: { stopReason: 'end_turn' },
        }
      }
      const result = action === 'send'
        ? await toolServer.context.sendSession({
            session_id: 'previous-session',
            prompt: 'continue previous work',
          })
        : await toolServer.context.startSession({
            prompt: 'build project',
            title: 'Project',
          })
      return {
        content: delegated(result),
        response: { stopReason: 'end_turn' },
      }
    },
    async cancelSession(sessionId) {
      calls.push(['cancel', sessionId])
    },
    async setSessionConfigOption(sessionId, configId, value) {
      calls.push(['config', sessionId, configId, value])
      return { configOptions: [] }
    },
    async close() {},
  }
}

test('waits for the managed OpenClaw Gateway before starting its ACP bridge', async () => {
  const client = fakeAcpClient()
  let available = false
  let starts = 0
  const originalStart = client.start
  client.start = async () => {
    starts += 1
    return originalStart()
  }
  const adapter = new AcpBackendAdapter({
    protocol: 'openclaw',
    baseUrl: 'http://127.0.0.1:18789',
    clientFactory: () => client,
    backendAvailable: async () => available,
  })

  const starting = await adapter.health()
  assert.equal(starting.ok, false)
  assert.match(starting.error, /正在启动/)
  assert.equal(starts, 0)

  available = true
  const ready = await adapter.health()
  assert.equal(ready.ok, true)
  assert.equal(starts, 1)
})

test('waits for managed backend readiness before dispatching the first task', async () => {
  let available = false
  let starts = 0
  const expected = new Error('stop after readiness')
  const client = {
    ready: false,
    stderr: '',
    async start() {
      starts += 1
      throw expected
    },
    async close() {},
  }
  const adapter = new AcpBackendAdapter({
    protocol: 'openclaw',
    baseUrl: 'http://127.0.0.1:18789',
    clientFactory: () => client,
    backendAvailable: async () => available,
    readinessPollMs: 1,
    readinessTimeoutMs: 100,
  })

  const run = adapter.runCoordinator('first task', { ownerId: 'owner' })
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(starts, 0)
  assert.equal(adapter.status().code, 'BACKEND_STARTING')

  available = true
  await assert.rejects(run, expected)
  assert.equal(starts, 1)
})

test('backs off repeated health spawns after any local ACP startup failure', async () => {
  let starts = 0
  const missing = new Error('DeepSeek is not configured')
  const client = {
    stderr: '',
    async start() {
      starts += 1
      throw missing
    },
    async close() {},
  }
  const adapter = new AcpBackendAdapter({ protocol: 'deepseek', client })

  const first = await adapter.health()
  const second = await adapter.health()
  assert.equal(first.ok, false)
  // retryAfterMs 随真实时钟递减，两次调用跨毫秒边界时会差 1ms；
  // 对它断言范围，其余字段保持严格相等。
  assert.ok(second.retryAfterMs > 0 && second.retryAfterMs <= 30_000)
  assert.deepEqual(
    { ...second, retryAfterMs: 0 },
    { ...first, retryAfterMs: 0 },
  )
  assert.equal(starts, 1)

  adapter.lastHealthFailure.at -= 30_001
  await adapter.health()
  assert.equal(starts, 2)
})

test('reports backend status without starting the ACP process', () => {
  let starts = 0
  const adapter = new AcpBackendAdapter({
    protocol: 'deepseek',
    client: {
      stderr: '',
      async start() { starts += 1 },
      async close() {},
    },
  })
  assert.deepEqual(adapter.status(), {
    ok: false,
    status: 'stopped',
    code: 'NOT_STARTED',
    protocol: 'deepseek',
    ownership: 'owned',
    transport: 'acp',
    acpConnection: 'process',
  })
  assert.equal(starts, 0)
})

test('retries an empty ACP coordinator response in a fresh Session', async () => {
  const prompts = []
  let nextSession = 0
  const client = {
    async newSession(options) {
      return {
        sessionId: `coordinator-${++nextSession}`,
        cwd: options.cwd,
        response: {},
      }
    },
    async prompt(sessionId) {
      prompts.push(sessionId)
      return {
        content: prompts.length === 1 ? '' : completed('新 Session 已恢复'),
        response: { stopReason: 'end_turn' },
      }
    },
    async close() {},
  }
  const adapter = new AcpBackendAdapter({
    protocol: 'openclaw',
    baseUrl: 'http://127.0.0.1:18789',
    directory: '/coordinator',
    client,
  })

  const result = await adapter.runCoordinator('plain request', {
    ownerId: 'owner-one',
    coordinationRunId: 'work-one',
  })

  assert.deepEqual(prompts, ['coordinator-1', 'coordinator-2'])
  assert.equal(
    JSON.parse(result.content).presentation.speech,
    '新 Session 已恢复',
  )
  await adapter.close()
})

test('retries an OpenClaw reply initialization conflict in the same Session', async () => {
  const prompts = []
  let nextSession = 0
  const client = {
    async newSession(options) {
      return {
        sessionId: `coordinator-${++nextSession}`,
        cwd: options.cwd,
        response: {},
      }
    },
    async prompt(sessionId) {
      prompts.push(sessionId)
      if (prompts.length === 1) {
        const error = new Error(
          'OpenClaw ACP session/prompt 失败：Internal error',
        )
        error.body = 'reply session initialization conflicted for agent:main:test'
        throw error
      }
      return {
        content: completed('同一 Session 重试成功'),
        response: { stopReason: 'end_turn' },
      }
    },
    async close() {},
  }
  const adapter = new AcpBackendAdapter({
    protocol: 'openclaw',
    baseUrl: 'http://127.0.0.1:18789',
    directory: '/coordinator',
    client,
  })

  const result = await adapter.runCoordinator('plain request', {
    ownerId: 'owner-one',
    coordinationRunId: 'work-one',
  })

  assert.deepEqual(prompts, ['coordinator-1', 'coordinator-1'])
  assert.equal(nextSession, 1)
  assert.equal(
    JSON.parse(result.content).presentation.speech,
    '同一 Session 重试成功',
  )
  await adapter.close()
})

test('does not replay an OpenClaw conflict after response activity', async () => {
  let prompts = 0
  const client = {
    async newSession(options) {
      return {
        sessionId: 'coordinator-one',
        cwd: options.cwd,
        response: {},
      }
    },
    async prompt(_sessionId, _prompt, options) {
      prompts += 1
      options.onUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'partial' },
      })
      const error = new Error(
        'reply session initialization conflicted for agent:main:test',
      )
      throw error
    },
    async close() {},
  }
  const adapter = new AcpBackendAdapter({
    protocol: 'openclaw',
    baseUrl: 'http://127.0.0.1:18789',
    directory: '/coordinator',
    client,
  })

  await assert.rejects(
    adapter.runCoordinator('plain request', {
      ownerId: 'owner-one',
      coordinationRunId: 'work-one',
    }),
    /reply session initialization conflicted/,
  )
  assert.equal(prompts, 1)
  await adapter.close()
})

test('rejects repeated empty ACP coordinator responses', async () => {
  let nextSession = 0
  const client = {
    async newSession(options) {
      return {
        sessionId: `coordinator-${++nextSession}`,
        cwd: options.cwd,
        response: {},
      }
    },
    async prompt() {
      return {
        content: '',
        response: { stopReason: 'end_turn' },
      }
    },
    async close() {},
  }
  const adapter = new AcpBackendAdapter({
    protocol: 'openclaw',
    baseUrl: 'http://127.0.0.1:18789',
    directory: '/coordinator',
    client,
  })

  await assert.rejects(
    adapter.runCoordinator('plain request', {
      ownerId: 'owner-one',
      coordinationRunId: 'work-one',
    }),
    /未返回任何内容/,
  )
  assert.equal(nextSession, 2)
  await adapter.close()
})

test('continues a remembered project Session using only its Session ID', async () => {
  const client = fakeAcpClient({
    action: 'send',
    scopeListsByCwd: true,
  })
  const tools = fakeToolServer()
  client.bind(tools)
  const adapter = new AcpBackendAdapter({
    protocol: 'qoder',
    directory: '/coordinator',
    client,
    sessionToolServer: tools,
  })
  adapter.registry.setProject('qoder:previous-session', {
    sessionId: 'previous-session',
    cwd: '/previous',
    title: 'Previous project',
  })
  const result = await adapter.runCoordinator('delegate', {
    ownerId: 'owner-one',
    coordinationRunId: 'work-one',
  })
  assert.equal(
    JSON.parse(result.content).presentation.speech,
    '第三层结果已整理',
  )
  assert.ok(client.calls.some(call => (
    call[0] === 'resume'
    && call[1] === 'previous-session'
    && call[2].cwd === '/previous'
  )))
  assert.equal(client.calls.some(call => call[0] === 'list'), false)
  await adapter.close()
})

test('starts a new Session in the coordinator project by default', async () => {
  const client = fakeAcpClient()
  const tools = fakeToolServer()
  client.bind(tools)
  const adapter = new AcpBackendAdapter({
    protocol: 'qoder',
    directory: '/coordinator-project',
    client,
    sessionToolServer: tools,
  })

  await adapter.runCoordinator('delegate', {
    ownerId: 'owner-one',
    coordinationRunId: 'work-one',
  })

  const projectSession = client.calls.find(call => (
    call[0] === 'new' && call[1].role === 'project'
  ))?.[1]
  assert.equal(projectSession.cwd, '/coordinator-project')
  await adapter.close()
})

test('propagates original non-text input blocks into a delegated project Session', async () => {
  const client = fakeAcpClient()
  const tools = fakeToolServer()
  client.bind(tools)
  const adapter = new AcpBackendAdapter({
    protocol: 'qoder',
    directory: '/coordinator-project',
    client,
    sessionToolServer: tools,
  })
  const image = {
    type: 'image',
    mimeType: 'image/png',
    data: 'aGVsbG8=',
  }

  await adapter.runCoordinator([
    { type: 'text', text: 'delegate' },
    image,
  ], {
    ownerId: 'owner-one',
    coordinationRunId: 'work-one',
  })

  const projectPrompt = client.calls.find(call => (
    call[0] === 'prompt' && call[1] === 'project-1'
  ))?.[2]
  assert.equal(Array.isArray(projectPrompt), true)
  assert.deepEqual(projectPrompt.at(-1), image)
  await adapter.close()
})

test('recovers the original project before continuing an unremembered Session', async () => {
  const client = fakeAcpClient({ action: 'send' })
  const tools = fakeToolServer()
  client.bind(tools)
  const adapter = new AcpBackendAdapter({
    protocol: 'qoder',
    directory: '/coordinator-project',
    client,
    sessionToolServer: tools,
  })

  await adapter.runCoordinator('delegate', {
    ownerId: 'owner-one',
    coordinationRunId: 'work-one',
  })

  assert.ok(client.calls.some(call => call[0] === 'list'))
  assert.ok(client.calls.some(call => (
    call[0] === 'resume'
    && call[1] === 'previous-session'
    && call[2].cwd === '/previous'
  )))
  await adapter.close()
})

test('uses one ACP profile family while preserving backend differences', () => {
  const root = '/repo'
  const connection = profile => profile.acpConnection
  assert.deepEqual(
    connection(acpBackendProfile({
      protocol: 'opencode',
      root,
      directory: '/work',
      permissionMode: 'native',
    })).args,
    [resolve(root, 'scripts/opencode.mjs'), 'acp'],
  )
  assert.deepEqual(
    connection(acpBackendProfile({
      protocol: 'qoder',
      root,
      directory: '/work',
      permissionMode: 'full',
      model: 'qwen3.7-max',
    })).args,
    ['--acp', '--dangerously-skip-permissions'],
  )
  const qwen = acpBackendProfile({
    protocol: 'qwen',
    root,
    directory: '/work',
    cliPath: '/opt/qwen',
    permissionMode: 'full',
  })
  assert.equal(connection(qwen).command, '/opt/qwen')
  assert.deepEqual(connection(qwen).args, ['--acp'])
  assert.deepEqual(qwen.sessionConfigOptions, [])
  const openClaw = acpBackendProfile({
    protocol: 'openclaw',
    root,
    directory: '/work',
    baseUrl: 'http://127.0.0.1:18789',
    token: 'secret',
    tokenFile: '/state/gateway-token',
    coordinatorAgent: 'coordinator',
    permissionMode: 'native',
  })
  assert.equal(openClaw.externalMcp, false)
  assert.deepEqual(connection(openClaw).args, [
    resolve(root, 'scripts/openclaw.mjs'),
    'acp',
    '--url',
    'ws://127.0.0.1:18789',
    '--token-file',
    '/state/gateway-token',
    '--verbose',
  ])
  assert.equal(connection(openClaw).env.OPENCLAW_STATE_DIR, '/state')
  const openClawWithTokenFileOnly = acpBackendProfile({
    protocol: 'openclaw',
    root,
    directory: '/work',
    baseUrl: 'http://127.0.0.1:18789',
    token: '',
    tokenFile: '/state/gateway-token',
    permissionMode: 'native',
  })
  assert.ok(connection(openClawWithTokenFileOnly).args.includes('--token-file'))
  const generic = acpBackendProfile({
    protocol: 'acp',
    root,
    directory: '/work',
    cliPath: 'example-agent',
    args: ['--acp', '--profile', 'voice'],
    label: 'Example Agent',
    permissionMode: 'native',
  })
  assert.equal(generic.label, 'Example Agent')
  assert.equal(connection(generic).command, 'example-agent')
  assert.deepEqual(connection(generic).args, ['--acp', '--profile', 'voice'])
  assert.equal(generic.externalMcp, true)
  const hermes = acpBackendProfile({
    protocol: 'hermes',
    root,
    directory: '/work',
    cliPath: '/opt/hermes',
    permissionMode: 'native',
  })
  assert.equal(connection(hermes).command, '/opt/hermes')
  assert.deepEqual(connection(hermes).args, ['acp', '--accept-hooks'])
  const kimi = acpBackendProfile({
    protocol: 'kimi',
    root,
    directory: '/work',
    cliPath: '/opt/kimi',
    permissionMode: 'full',
  })
  assert.equal(connection(kimi).command, '/opt/kimi')
  assert.deepEqual(connection(kimi).args, ['acp'])
  assert.deepEqual(kimi.sessionConfigOptions, [
    { id: 'mode', value: 'auto' },
  ])
  const codeBuddy = acpBackendProfile({
    protocol: 'codebuddy',
    root,
    directory: '/work',
    model: 'qwen3.7-max',
    modelUrl: 'https://example.com/v1/chat/completions',
    permissionMode: 'full',
  })
  assert.deepEqual(connection(codeBuddy).args, [
    '--acp',
    '--model',
    'qwen3.7-max',
    '--dangerously-skip-permissions',
  ])
  assert.equal(
    connection(codeBuddy).env.CODEBUDDY_MODEL_URL,
    'https://example.com/v1/chat/completions',
  )
  const nativeCodeBuddy = acpBackendProfile({
    protocol: 'codebuddy',
    root,
    directory: '/work',
    permissionMode: 'native',
  })
  assert.deepEqual(connection(nativeCodeBuddy).args, ['--acp'])
  assert.equal(connection(nativeCodeBuddy).env.CODEBUDDY_MODEL_URL, undefined)
  const codex = acpBackendProfile({
    protocol: 'codex',
    root,
    directory: '/work',
    model: 'qwen3.7-max',
    modelUrl: 'https://example.com/compatible-mode/v1',
    permissionMode: 'full',
  })
  assert.equal(connection(codex).command, process.execPath)
  assert.equal(connection(codex).args[0], resolve(root, 'scripts/codex-acp.mjs'))
  assert.equal(connection(codex).env.INITIAL_AGENT_MODE, 'agent-full-access')
  const codexConfig = JSON.parse(connection(codex).env.CODEX_CONFIG)
  assert.equal(codexConfig.model, 'qwen3.7-max')
  assert.equal(
    codexConfig.model_providers['qwen-audio-agent'].base_url,
    'https://example.com/compatible-mode/v1',
  )
  const nativeCodex = acpBackendProfile({
    protocol: 'codex',
    root,
    directory: '/work',
    cliPath: '/opt/codex-acp',
    permissionMode: 'native',
  })
  assert.equal(connection(nativeCodex).command, process.execPath)
  assert.equal(connection(nativeCodex).args[0], resolve(root, 'scripts/codex-acp.mjs'))
  assert.equal(connection(nativeCodex).env.CODEX_ACP_BIN, '/opt/codex-acp')
  assert.equal(connection(nativeCodex).env.CODEX_CONFIG, undefined)
  assert.equal(connection(nativeCodex).env.MODEL_PROVIDER, undefined)
  const claude = acpBackendProfile({
    protocol: 'claude',
    root,
    directory: '/work',
    cliPath: '/opt/claude-code-acp',
    claudeExecutable: '/opt/claude',
    permissionMode: 'full',
  })
  assert.equal(connection(claude).command, process.execPath)
  assert.equal(connection(claude).args[0], resolve(root, 'scripts/claude-code-acp.mjs'))
  assert.equal(connection(claude).cwd, '/work')
  assert.equal(connection(claude).env.CLAUDE_CODE_ACP_BIN, '/opt/claude-code-acp')
  assert.equal(connection(claude).env.CLAUDE_CODE_EXECUTABLE, '/opt/claude')
  assert.equal(connection(claude).env.CLAUDE_CONFIG_DIR, undefined)
  assert.equal(claude.externalMcp, true)
  const pi = acpBackendProfile({
    protocol: 'pi',
    root,
    directory: '/work',
    cliPath: '/opt/pi-acp',
    permissionMode: 'full',
  })
  assert.equal(connection(pi).command, process.execPath)
  assert.equal(connection(pi).args[0], resolve(root, 'scripts/pi-acp.mjs'))
  assert.equal(connection(pi).cwd, '/work')
  assert.equal(connection(pi).env.PI_ACP_BIN, '/opt/pi-acp')
  assert.equal(pi.externalMcp, false)
  assert.equal(pi.sessionMcp, false)
  assert.equal(pi.delegation, false)
  assert.equal(pi.permissions, false)
  assert.match(pi.sessionInstructions, /does not expose Gateway Session tools/)
})

test('lets the official OpenClaw bridge diagnose external Gateway failures', () => {
  const external = acpBackendProfile({
    protocol: 'openclaw',
    root: '/repo',
    ownership: 'external',
    directory: '/work',
    baseUrl: 'wss://agent.example.com',
    tokenFile: '/state/gateway-token',
    permissionMode: 'native',
  })
  assert.equal(external.readinessMessage, '')
  assert.ok(external.acpConnection.args.includes('wss://agent.example.com'))

  const owned = acpBackendProfile({
    protocol: 'openclaw',
    root: '/repo',
    ownership: 'owned',
    directory: '/work',
    baseUrl: 'http://127.0.0.1:18789',
    permissionMode: 'native',
  })
  assert.match(owned.readinessMessage, /正在启动/)
})

test('can launch a trusted OpenClaw ACP bridge executable directly', () => {
  const profile = acpBackendProfile({
    protocol: 'openclaw',
    root: '/repo',
    ownership: 'external',
    directory: '/work',
    cliPath: '/opt/openclaw',
    baseUrl: 'wss://agent.example.com',
    tokenFile: '/state/gateway-token',
    permissionMode: 'native',
  })
  assert.equal(profile.acpConnection.command, '/opt/openclaw')
  assert.deepEqual(profile.acpConnection.args, [
    'acp',
    '--url',
    'wss://agent.example.com',
    '--token-file',
    '/state/gateway-token',
    '--verbose',
  ])
})

test('direct OpenClaw bridge prepares a private explicit-token file', () => {
  const profile = acpBackendProfile({
    protocol: 'openclaw',
    root: '/repo',
    ownership: 'external',
    directory: '/work',
    cliPath: '/opt/openclaw',
    baseUrl: 'wss://agent.example.com',
    token: 'remote-token',
    tokenFile: '/state/not-materialized',
    permissionMode: 'native',
  })
  assert.equal(
    profile.acpConnection.env.OPENCLAW_GATEWAY_TOKEN,
    'remote-token',
  )
  assert.equal(profile.acpConnection.args.includes('--token-file'), true)
  assert.equal(typeof profile.acpConnection.prepare, 'function')
})

test('Kimi full permission mode configures coordinator and project Sessions', async () => {
  const calls = []
  const client = {
    async start() {
      return { agentCapabilities: { mcpCapabilities: { http: true } } }
    },
    async newSession(options) {
      return {
        sessionId: 'kimi-coordinator',
        cwd: options.cwd,
        response: {
          configOptions: [{
            type: 'select',
            id: 'mode',
            currentValue: 'default',
            options: [
              { value: 'default', name: 'Default' },
              { value: 'auto', name: 'Auto' },
            ],
          }],
        },
      }
    },
    async setSessionConfigOption(sessionId, configId, value) {
      calls.push([sessionId, configId, value])
      return {
        configOptions: [{
          type: 'select',
          id: 'mode',
          currentValue: value,
          options: [{ value: 'auto', name: 'Auto' }],
        }],
      }
    },
    async prompt() {
      return {
        content: completed('Kimi ready'),
        response: { stopReason: 'end_turn' },
      }
    },
    async close() {},
  }
  const adapter = new AcpBackendAdapter({
    protocol: 'kimi',
    root: '/repo',
    directory: '/kimi',
    permissionMode: 'full',
    client,
    sessionToolServer: fakeToolServer(),
  })

  await adapter.runCoordinator('plain request', {
    ownerId: 'owner-one',
    coordinationRunId: 'work-one',
  })
  await adapter.configureSession({
    sessionId: 'kimi-project',
    response: {
      configOptions: [{
        type: 'select',
        id: 'mode',
        currentValue: 'default',
        options: [{ value: 'auto', name: 'Auto' }],
      }],
    },
  }, 'project')

  assert.deepEqual(calls, [
    ['kimi-coordinator', 'mode', 'auto'],
    ['kimi-project', 'mode', 'auto'],
  ])
  await adapter.close()
})

test('Kimi full permission mode rejects an ACP server without Auto mode', async () => {
  const client = {
    async start() {
      return { agentCapabilities: { mcpCapabilities: { http: true } } }
    },
    async newSession(options) {
      return {
        sessionId: 'old-kimi',
        cwd: options.cwd,
        response: { configOptions: [] },
      }
    },
    async close() {},
  }
  const adapter = new AcpBackendAdapter({
    protocol: 'kimi',
    root: '/repo',
    directory: '/kimi',
    permissionMode: 'full',
    client,
    sessionToolServer: fakeToolServer(),
  })

  await assert.rejects(
    adapter.runCoordinator('plain request', {
      ownerId: 'owner-one',
      coordinationRunId: 'work-one',
    }),
    /必要的 Session 配置 mode=auto/,
  )
  await adapter.close()
})

test('keeps a cached coordinator MCP connection valid across turns', async () => {
  const tools = fakeToolServer()
  let cachedDescriptor
  let coordinatorPrompts = 0
  const resumedDescriptors = []
  const client = {
    async newSession(options) {
      if (options.role === 'coordinator') {
        cachedDescriptor = options.mcpServers[0]
        return {
          sessionId: 'coordinator-session',
          cwd: options.cwd,
          response: {},
        }
      }
      return {
        sessionId: 'project-session',
        cwd: options.cwd,
        response: {},
      }
    },
    async resumeSession(sessionId, options) {
      resumedDescriptors.push(options.mcpServers[0])
      return { sessionId, cwd: options.cwd, response: {} }
    },
    async prompt(sessionId) {
      if (sessionId === 'project-session') {
        return {
          content: 'project complete',
          response: { stopReason: 'end_turn' },
        }
      }
      coordinatorPrompts += 1
      if (coordinatorPrompts === 2) {
        const cached = tools.registrations.find(registration => (
          registration.descriptor.url === cachedDescriptor.url
        ))
        await cached.call('startSession', {
          prompt: 'inspect the project',
        })
      }
      return {
        content: completed(`coordinator turn ${coordinatorPrompts}`),
        response: { stopReason: 'end_turn' },
      }
    },
    async close() {},
  }
  const adapter = new AcpBackendAdapter({
    protocol: 'qoder',
    directory: '/coordinator',
    client,
    sessionToolServer: tools,
  })

  await adapter.coordinatorTurn('first turn', {
    ownerId: 'owner-one',
    coordinationRunId: 'work-one',
  })
  const second = await adapter.coordinatorTurn('second turn', {
    ownerId: 'owner-one',
    coordinationRunId: 'work-two',
  })

  assert.equal(tools.registerCalls, 1)
  assert.equal(tools.updateCalls, 1)
  assert.equal(tools.releaseCalls, 0)
  assert.equal(resumedDescriptors[0].url, cachedDescriptor.url)
  assert.equal(second.run.delegation.workId, 'work-two')
  assert.equal(second.run.delegation.ownerId, 'owner-one')
  await second.run.delegation.promise
  await adapter.close()
  assert.equal(tools.releaseCalls, 1)
})

test('isolates coordinator MCP registrations by owner and releases them', async () => {
  const tools = fakeToolServer()
  let projectId = 0
  const client = {
    async newSession(options) {
      return {
        sessionId: options.role === 'coordinator'
          ? `coordinator-${options.ownerId}`
          : `project-${++projectId}`,
        cwd: options.cwd,
        response: {},
      }
    },
    async prompt() {
      return {
        content: completed(),
        response: { stopReason: 'end_turn' },
      }
    },
    async close() {},
  }
  const adapter = new AcpBackendAdapter({
    protocol: 'qoder',
    directory: '/coordinator',
    client,
    sessionToolServer: tools,
  })

  await adapter.coordinatorTurn('owner one turn', {
    ownerId: 'owner-one',
    coordinationRunId: 'work-owner-one',
  })
  await adapter.coordinatorTurn('owner two turn', {
    ownerId: 'owner-two',
    coordinationRunId: 'work-owner-two',
  })
  await tools.registrations[0].call('startSession', {
    prompt: 'owner one project',
  })
  await tools.registrations[1].call('startSession', {
    prompt: 'owner two project',
  })

  assert.equal(tools.registerCalls, 2)
  assert.notEqual(
    tools.registrations[0].descriptor.url,
    tools.registrations[1].descriptor.url,
  )
  assert.equal(
    adapter.delegatedWorkRuns.get('work-owner-one').delegation.ownerId,
    'owner-one',
  )
  assert.equal(
    adapter.delegatedWorkRuns.get('work-owner-two').delegation.ownerId,
    'owner-two',
  )
  assert.equal(
    adapter.delegatedWorkRuns.get('work-owner-one').delegation.directory,
    '/coordinator',
  )
  assert.equal(
    adapter.delegatedWorkRuns.get('work-owner-two').delegation.directory,
    '/coordinator',
  )
  await Promise.all([
    adapter.delegatedWorkRuns.get('work-owner-one').delegation.promise,
    adapter.delegatedWorkRuns.get('work-owner-two').delegation.promise,
  ])
  await adapter.close()
  assert.equal(tools.releaseCalls, 2)
  assert.equal(tools.registrations.every(item => item.released), true)
})

for (const action of ['start', 'send']) {
  test(`ACP coordinator can ${action} a third-layer Session and finalize through the coordinator`, async () => {
    const client = fakeAcpClient({ action })
    const tools = fakeToolServer()
    client.bind(tools)
    const adapter = new AcpBackendAdapter({
      protocol: 'opencode',
      root: '/repo',
      directory: '/coordinator',
      client,
      sessionToolServer: tools,
    })
    const events = []
    const result = await adapter.runCoordinator('delegate', {
      ownerId: 'owner-one',
      coordinationRunId: 'work-one',
      onEvent: event => events.push(event),
    })
    assert.equal(JSON.parse(result.content).presentation.speech, '第三层结果已整理')
    assert.ok(events.some(event => event.type === 'backend.delegated'))
    assert.ok(events.some(
      event => event.type === 'backend.delegation.completed',
    ))
    if (action === 'send') {
      assert.ok(client.calls.some(call => (
        call[0] === 'resume'
        && call[1] === 'previous-session'
        && call[2].cwd === '/previous'
      )))
    } else {
      assert.ok(client.calls.some(call => (
        call[0] === 'new' && call[1].role === 'project'
      )))
    }
    const coordinatorPrompts = client.calls.filter(call => (
      call[0] === 'prompt' && call[1] === 'coordinator-session'
    ))
    assert.equal(coordinatorPrompts.length, 2)
    assert.equal(
      client.calls.some(call => call[0] === 'config'),
      false,
    )
    await adapter.close()
  })
}

test('ACP permissions expose permanent allow and reject semantics', async () => {
  const client = fakeAcpClient()
  const adapter = new AcpBackendAdapter({
    protocol: 'opencode',
    client,
    sessionToolServer: fakeToolServer(),
  })
  const options = [
    { optionId: 'once', name: 'Allow', kind: 'allow_once' },
    { optionId: 'always', name: 'Always', kind: 'allow_always' },
    { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
  ]
  const events = []
  client.sessions.set('coordinator-session', {
    sessionId: 'coordinator-session',
    ownerId: 'owner-one',
    coordinationRunId: 'work-one',
    onEvent: event => events.push(event),
  })
  const pending = adapter.handlePermission({
    sessionId: 'coordinator-session',
    toolCall: {
      toolCallId: 'tool-one',
      name: 'write',
      rawInput: { path: '/tmp/file' },
    },
    options,
  }, {
    session: client.sessions.get('coordinator-session'),
  })
  const requested = events.find(event => (
    event.type === 'backend.permission.requested'
  ))
  await adapter.respondPermission(requested.permission.id, 'always', {
    ownerId: 'owner-one',
  })
  assert.deepEqual(await pending, {
    outcome: { outcome: 'selected', optionId: 'once' },
  })
  assert.ok(events.some(event => (
    event.type === 'backend.permission.resolved'
  )))
  assert.deepEqual(
    await adapter.respondPermission(requested.permission.id, 'always', {
      ownerId: 'owner-one',
    }),
    events.find(event => event.type === 'backend.permission.resolved').permission,
  )
  const repeated = adapter.handlePermission({
    sessionId: 'coordinator-session',
    toolCall: {
      toolCallId: 'tool-two',
      name: 'write',
      rawInput: { path: '/tmp/file' },
    },
    options,
  }, {
    session: client.sessions.get('coordinator-session'),
  })
  const repeatedRequest = events.filter(event => (
    event.type === 'backend.permission.requested'
  )).at(-1)
  assert.notEqual(repeatedRequest.permission.id, requested.permission.id)
  await adapter.respondPermission(repeatedRequest.permission.id, 'reject', {
    ownerId: 'owner-one',
  })
  assert.deepEqual(await repeated, {
    outcome: { outcome: 'selected', optionId: 'reject' },
  })
  await adapter.close()
})

test('permission cleanup is isolated to the ACP prompt that requested it', async () => {
  const adapter = new AcpBackendAdapter({
    protocol: 'opencode',
    client: fakeAcpClient(),
    sessionToolServer: fakeToolServer(),
  })
  const options = [
    { optionId: 'always', kind: 'allow_always' },
    { optionId: 'reject', kind: 'reject_once' },
  ]
  const coordinatorEvents = []
  const coordinator = adapter.handlePermission({
    toolCall: { name: 'read', rawInput: { path: '/coordinator' } },
    options,
  }, {
    session: {
      sessionId: 'coordinator',
      ownerId: 'owner-one',
      coordinationRunId: 'work-one',
      permissionScopeId: 'coordinator-prompt',
      onEvent: event => coordinatorEvents.push(event),
    },
  })
  const project = adapter.handlePermission({
    toolCall: { name: 'write', rawInput: { path: '/project' } },
    options,
  }, {
    session: {
      sessionId: 'project',
      ownerId: 'owner-one',
      coordinationRunId: 'work-one',
      permissionScopeId: 'project-prompt',
    },
  })
  const projectPermission = [...adapter.pendingPermissions.values()]
    .find(record => record.sessionId === 'project')

  adapter.cancelPermissionsForScope('coordinator-prompt')
  assert.deepEqual(await coordinator, {
    outcome: { outcome: 'cancelled' },
  })
  assert.equal(
    coordinatorEvents.at(-1).type,
    'backend.permission.resolved',
  )
  assert.equal(coordinatorEvents.at(-1).permission.status, 'cancelled')
  assert.equal(adapter.pendingPermissions.has(projectPermission.id), true)
  await adapter.respondPermission(projectPermission.id, 'always', {
    ownerId: 'owner-one',
  })
  assert.deepEqual(await project, {
    outcome: { outcome: 'selected', optionId: 'always' },
  })
  await adapter.close()
})

test('automatically allows only the Gateway-owned Session MCP tools', async () => {
  const adapter = new AcpBackendAdapter({
    protocol: 'qoder',
    client: fakeAcpClient(),
    sessionToolServer: fakeToolServer(),
  })
  const result = await adapter.handlePermission({
    toolCall: {
      toolCallId: 'session-tool',
      title: 'qwen_audio_agent_session_start (qwen_audio_agent)',
    },
    options: [
      { optionId: 'once', name: 'Allow', kind: 'allow_once' },
    ],
  })
  assert.deepEqual(result, {
    outcome: { outcome: 'selected', optionId: 'once' },
  })
  assert.equal(adapter.pendingPermissions.size, 0)
  await adapter.close()
})

test('delegated status queries go through the coordinator and cancellation does too when idle', async () => {
  const client = fakeAcpClient({ holdTarget: true })
  const tools = fakeToolServer()
  client.bind(tools)
  const adapter = new AcpBackendAdapter({
    protocol: 'opencode',
    root: '/repo',
    directory: '/coordinator',
    client,
    sessionToolServer: tools,
  })
  const running = adapter.runCoordinator('delegate', {
    ownerId: 'owner-one',
    coordinationRunId: 'work-one',
  })
  while (!adapter.delegatedWorkRuns.has('work-one')) {
    await new Promise(resolve => setImmediate(resolve))
  }
  const status = await adapter.queryDelegatedWork(
    'work-one',
    '做到哪了',
    { ownerId: 'owner-one' },
  )
  assert.equal(JSON.parse(status.content).presentation.speech, '当前状态：running')
  const cancelled = await adapter.cancelDelegatedWork('work-one', {
    ownerId: 'owner-one',
  })
  assert.equal(cancelled.route, 'coordinator')
  await assert.rejects(running, /取消/)
  assert.ok(client.calls.some(call => (
    call[0] === 'prompt' && call[2].includes('kind="status"')
  )))
  assert.ok(client.calls.some(call => (
    call[0] === 'prompt' && call[2].includes('kind="cancel"')
  )))
  await adapter.close()
})

test('busy-coordinator cancellation uses ACP directly and reconciles on the next turn', async () => {
  const client = fakeAcpClient({ holdTarget: true })
  const tools = fakeToolServer()
  client.bind(tools)
  const adapter = new AcpBackendAdapter({
    protocol: 'opencode',
    root: '/repo',
    directory: '/coordinator',
    client,
    sessionToolServer: tools,
  })
  const running = adapter.runCoordinator('delegate', {
    ownerId: 'owner-one',
    coordinationRunId: 'work-one',
  })
  while (!adapter.delegatedWorkRuns.has('work-one')) {
    await new Promise(resolve => setImmediate(resolve))
  }
  adapter.activeCoordinatorTurns.add('coordinator-session')
  const cancellation = await adapter.cancelDelegatedWork('work-one', {
    ownerId: 'owner-one',
  })
  adapter.activeCoordinatorTurns.delete('coordinator-session')
  assert.equal(cancellation.route, 'adapter')
  await assert.rejects(running, /取消/)
  await adapter.coordinatorTurn('plain follow-up', {
    ownerId: 'owner-one',
    coordinationRunId: 'work-two',
  })
  const followUp = client.calls.findLast(call => (
    call[0] === 'prompt' && call[2].includes('plain follow-up')
  ))
  assert.match(followUp[2], /qwen_audio_agent_reconciliation/)
  assert.match(followUp[2], /delegated_session_cancelled/)
  assert.equal(adapter.pendingCoordinatorFacts.has('owner-one'), false)
  await adapter.close()
})

test('selects supported ACP Session mode and model config options', async () => {
  const client = fakeAcpClient()
  const configured = []
  client.setSessionConfigOption = async (...args) => {
    configured.push(args)
    if (args[1] !== 'llm-selector') return {}
    return {
      configOptions: [{
        id: 'llm-selector',
        category: 'model',
        type: 'select',
        currentValue: args[2],
        options: [{ value: 'provider/model' }],
      }],
    }
  }
  client.newSession = async options => ({
    sessionId: 'coordinator-session',
    cwd: options.cwd,
    response: {
      configOptions: [
        {
          id: 'mode',
          type: 'select',
          currentValue: 'build',
          options: [{ value: 'voice-coordinator' }],
        },
        {
          id: 'llm-selector',
          category: 'model',
          type: 'select',
          currentValue: 'default',
          options: [{ value: 'provider/model' }],
        },
      ],
    },
  })
  const adapter = new AcpBackendAdapter({
    protocol: 'opencode',
    coordinatorAgent: 'voice-coordinator',
    model: 'provider/model',
    client,
    sessionToolServer: fakeToolServer(),
  })
  await adapter.ensureCoordinatorSession('owner-one')
  assert.deepEqual(configured, [
    ['coordinator-session', 'mode', 'voice-coordinator'],
    ['coordinator-session', 'llm-selector', 'provider/model'],
  ])
  await adapter.close()
})

test('matches Qoder ACP model names case-insensitively and sends the opaque ID', async () => {
  const client = fakeAcpClient()
  const configured = []
  client.setSessionConfigOption = async (...args) => {
    configured.push(args)
    return {
      configOptions: [{
        id: 'model',
        category: 'model',
        type: 'select',
        currentValue: args[2],
        options: [{ value: 'qmodel_latest', name: 'Qwen3.7-Max' }],
      }],
    }
  }
  const adapter = new AcpBackendAdapter({
    protocol: 'qoder',
    model: 'qwen3.7-max',
    client,
  })
  await adapter.configureSession({
    sessionId: 'qoder-session',
    response: {
      configOptions: [{
        id: 'model',
        category: 'model',
        type: 'select',
        currentValue: 'qmodel',
        options: [
          { value: 'qmodel', name: 'Qwen3.7-Plus' },
          { value: 'qmodel_latest', name: 'Qwen3.7-Max' },
        ],
      }],
    },
  }, 'project')
  assert.deepEqual(configured, [
    ['qoder-session', 'model', 'qmodel_latest'],
  ])
  await adapter.close()
})

test('does not reset a Qoder model already selected by its opaque ID', async () => {
  const client = fakeAcpClient()
  const configured = []
  client.setSessionConfigOption = async (...args) => configured.push(args)
  const adapter = new AcpBackendAdapter({
    protocol: 'qoder',
    model: 'qwen3.7-max',
    client,
  })
  await adapter.configureSession({
    sessionId: 'qoder-session',
    response: {
      configOptions: [{
        id: 'model',
        category: 'model',
        type: 'select',
        currentValue: 'qmodel_latest',
        options: [{ value: 'qmodel_latest', name: 'Qwen3.7-Max' }],
      }],
    },
  }, 'project')
  assert.deepEqual(configured, [])
  await adapter.close()
})

test('never calls ACP model configuration without an explicit model', async () => {
  for (const model of ['', 'auto']) {
    const client = fakeAcpClient()
    const configured = []
    client.setSessionConfigOption = async (...args) => configured.push(args)
    const adapter = new AcpBackendAdapter({
      protocol: 'opencode',
      model,
      client,
    })
    assert.equal(adapter.describe().model, null)
    await adapter.configureSession({
      sessionId: 'session-one',
      response: {
        configOptions: [{
          id: 'models',
          category: 'model',
          type: 'select',
          currentValue: 'user-default',
          options: [{ value: 'user-default' }, { value: 'forced-model' }],
        }],
      },
    }, 'project')
    assert.deepEqual(configured, [])
    await adapter.close()
  }
})

test('replaces a restored OpenCode coordinator with a stale mode', async () => {
  const client = fakeAcpClient()
  client.resumeSession = async () => ({
    sessionId: 'old-coordinator',
    response: {
      configOptions: [{
        id: 'mode',
        type: 'select',
        currentValue: 'qwen-audio-agent-backend',
        options: [{ value: 'build' }, { value: 'plan' }],
      }],
    },
  })
  client.newSession = async options => ({
    sessionId: 'new-coordinator',
    cwd: options.cwd,
    response: {
      configOptions: [{
        id: 'mode',
        type: 'select',
        currentValue: 'build',
        options: [{ value: 'build' }, { value: 'plan' }],
      }],
    },
  })
  const adapter = new AcpBackendAdapter({
    protocol: 'opencode',
    client,
  })
  adapter.registry.get = () => ({
    sessionId: 'old-coordinator',
    cwd: '/old-workspace',
  })
  const deleted = []
  const saved = []
  adapter.registry.delete = key => deleted.push(key)
  adapter.registry.set = (key, session) => saved.push([key, session.sessionId])

  const session = await adapter.ensureCoordinatorSession('owner-one')
  assert.equal(session.sessionId, 'new-coordinator')
  assert.equal(session.isNew, true)
  assert.equal(deleted.length, 1)
  assert.deepEqual(saved, [[deleted[0], 'new-coordinator']])
  await adapter.close()
})

test('supports legacy ACP Session model selection', async () => {
  const client = fakeAcpClient()
  const configured = []
  client.setLegacySessionModel = async (...args) => configured.push(args)
  const adapter = new AcpBackendAdapter({
    protocol: 'claude',
    model: 'claude-sonnet',
    client,
  })
  const session = {
    sessionId: 'legacy-session',
    response: {
      models: {
        currentModelId: 'claude-default',
        availableModels: [
          { modelId: 'claude-default' },
          { modelId: 'claude-sonnet' },
        ],
      },
    },
  }
  await adapter.configureSession(session, 'project')
  assert.deepEqual(configured, [
    ['legacy-session', 'claude-sonnet'],
  ])
  assert.equal(session.response.models.currentModelId, 'claude-sonnet')
  await adapter.close()
})

test('matches legacy ACP model IDs case-insensitively', async () => {
  const client = fakeAcpClient()
  const configured = []
  client.setLegacySessionModel = async (...args) => configured.push(args)
  const adapter = new AcpBackendAdapter({
    protocol: 'claude',
    model: 'claude-sonnet',
    client,
  })
  const session = {
    sessionId: 'legacy-session',
    response: {
      models: {
        currentModelId: 'Claude-Default',
        availableModels: [
          { modelId: 'Claude-Default' },
          { modelId: 'Claude-Sonnet' },
        ],
      },
    },
  }
  await adapter.configureSession(session, 'project')
  assert.deepEqual(configured, [
    ['legacy-session', 'Claude-Sonnet'],
  ])
  assert.equal(session.response.models.currentModelId, 'Claude-Sonnet')
  await adapter.close()
})

test('uses OpenClaw Gateway model override when ACP omits model options', async () => {
  const client = fakeAcpClient()
  const configured = []
  const adapter = new AcpBackendAdapter({
    protocol: 'openclaw',
    baseUrl: 'http://127.0.0.1:18789',
    directory: '/coordinator',
    model: 'bailian/qwen3.7-plus',
    client,
    nativeDelegationAdapter: {
      async setSessionModel(input) {
        configured.push(input)
      },
    },
  })
  await adapter.configureSession({
    sessionId: 'openclaw-session',
    meta: { sessionKey: 'agent:voice:coordinator' },
    response: { configOptions: [] },
  }, 'coordinator')
  assert.deepEqual(configured, [{
    sessionKey: 'agent:voice:coordinator',
    model: 'bailian/qwen3.7-plus',
  }])
  await adapter.close()
})

test('rejects explicit models that ACP cannot apply', async () => {
  const client = fakeAcpClient()
  const adapter = new AcpBackendAdapter({
    protocol: 'opencode',
    model: 'forced-model',
    client,
  })
  await assert.rejects(
    adapter.configureSession({
      sessionId: 'missing-option',
      response: { configOptions: [] },
    }, 'project'),
    /没有通过 ACP 提供 Session 模型配置/,
  )
  await assert.rejects(
    adapter.configureSession({
      sessionId: 'unsupported-model',
      response: {
        configOptions: [{
          id: 'model',
          type: 'select',
          currentValue: 'user-default',
          options: [{ value: 'user-default' }],
        }],
      },
    }, 'project'),
    /不支持模型 forced-model.*user-default/,
  )
  await adapter.close()
})

test('verifies that an explicit ACP model override took effect', async () => {
  const client = fakeAcpClient()
  client.setSessionConfigOption = async () => ({
    configOptions: [{
      id: 'models',
      category: 'model',
      type: 'select',
      currentValue: 'different-model',
      options: [
        {
          group: 'Models',
          options: [{ value: 'forced-model' }, { value: 'different-model' }],
        },
      ],
    }],
  })
  const adapter = new AcpBackendAdapter({
    protocol: 'opencode',
    model: 'forced-model',
    client,
  })
  await assert.rejects(
    adapter.configureSession({
      sessionId: 'session-one',
      response: {
        configOptions: [{
          id: 'models',
          category: 'model',
          type: 'select',
          currentValue: 'user-default',
          options: [{
            group: 'Models',
            options: [
              { value: 'forced-model' },
              { value: 'different-model' },
            ],
          }],
        }],
      },
    }, 'project'),
    /未确认模型覆盖生效/,
  )
  await adapter.close()
})

test('reports ACP model-setting and unverifiable-response failures', async () => {
  const session = {
    sessionId: 'session-one',
    response: {
      configOptions: [{
        id: 'llm',
        category: 'MODEL',
        type: 'select',
        currentValue: 'user-default',
        options: [{ value: 'forced-model' }],
      }],
    },
  }
  const failingClient = fakeAcpClient()
  failingClient.setSessionConfigOption = async () => {
    throw new Error('backend rejected the request')
  }
  const failingAdapter = new AcpBackendAdapter({
    protocol: 'opencode',
    model: 'forced-model',
    client: failingClient,
  })
  await assert.rejects(
    failingAdapter.configureSession(session, 'project'),
    /无法把 Session 模型设置为 forced-model：backend rejected the request/,
  )
  await failingAdapter.close()

  const unverifiableClient = fakeAcpClient()
  unverifiableClient.setSessionConfigOption = async () => ({})
  const unverifiableAdapter = new AcpBackendAdapter({
    protocol: 'opencode',
    model: 'forced-model',
    client: unverifiableClient,
  })
  await assert.rejects(
    unverifiableAdapter.configureSession(session, 'project'),
    /没有返回 ACP configOptions/,
  )
  await unverifiableAdapter.close()
})

test('OpenClaw maps native Session tool updates into the shared delegation lifecycle', async () => {
  const calls = []
  const nativeCalls = []
  let promptCount = 0
  const client = {
    async start() {
      return {
        agentCapabilities: {
          sessionCapabilities: { list: {}, resume: {} },
        },
      }
    },
    async newSession(options) {
      return {
        sessionId: 'openclaw-coordinator',
        cwd: options.cwd,
        response: {},
      }
    },
    async resumeSession(sessionId, options) {
      return { sessionId, cwd: options.cwd, response: {} }
    },
    async listSessions() {
      return [{
        sessionId: 'agent:child:one',
        cwd: '/project',
        updatedAt: '2026-01-01T00:00:00Z',
      }]
    },
    async prompt(sessionId, prompt, options = {}) {
      calls.push(prompt)
      promptCount += 1
      if (promptCount === 1) {
        options.onUpdate({
          sessionUpdate: 'tool_call',
          toolCallId: 'spawn-one',
          name: 'sessions_spawn',
          title: 'Spawn project Session',
          status: 'completed',
          rawInput: { task: 'build project', cwd: '/project' },
          rawOutput: {
            content: [{
              type: 'text',
              text: JSON.stringify({
                status: 'accepted',
                runId: 'run-one',
                childSessionKey: 'agent:child:one',
              }),
            }],
          },
        })
        return {
          content: JSON.stringify({
            work_id: 'work-one',
            state: 'delegated',
            mode: 'delegate',
            delegation_id: 'run-one',
            target_session_id: 'agent:child:one',
            presentation: { speech: 'OpenClaw 已开始执行。', inline: null },
          }),
          response: { stopReason: 'end_turn' },
        }
      }
      return {
        content: completed('OpenClaw 第三层结果已整理'),
        response: { stopReason: 'end_turn' },
      }
    },
    async cancelSession() {},
    async close() {},
  }
  const adapter = new AcpBackendAdapter({
    protocol: 'openclaw',
    root: '/repo',
    directory: '/coordinator',
    baseUrl: 'http://127.0.0.1:18789',
    client,
    nativeDelegationAdapter: {
      async wait(input) {
        nativeCalls.push(['wait', input.runId, input.sessionId])
        return { content: 'child completed successfully' }
      },
      async cancel(input) {
        nativeCalls.push(['cancel', input.runId, input.sessionId])
      },
    },
  })
  const events = []
  const running = adapter.runCoordinator('delegate', {
    ownerId: 'owner-one',
    coordinationRunId: 'work-one',
    onEvent: event => events.push(event),
  })
  const result = await running
  assert.equal(
    JSON.parse(result.content).presentation.speech,
    'OpenClaw 第三层结果已整理',
  )
  assert.deepEqual(nativeCalls, [[
    'wait',
    'run-one',
    'agent:child:one',
  ]])
  assert.ok(calls[1].includes('child completed successfully'))
  assert.ok(events.some(event => event.type === 'backend.delegated'))
  assert.ok(events.some(
    event => event.type === 'backend.delegation.completed',
  ))
  await adapter.close()
})

test('OpenClaw routes each owner to the configured coordinator Agent through ACP metadata', () => {
  const adapter = new AcpBackendAdapter({
    protocol: 'openclaw',
    root: '/repo',
    baseUrl: 'http://127.0.0.1:18789',
    coordinatorAgent: 'voice-coordinator',
    client: fakeAcpClient(),
  })
  assert.deepEqual(adapter.coordinatorMeta('Owner One'), {
    sessionKey: 'agent:voice-coordinator:qwen-audio-agent:owner%20one:backend',
  })
})

test('OpenClaw reattaches a persisted native delegation after Gateway restart', async () => {
  const events = []
  const client = fakeAcpClient()
  client.prompt = async (_sessionId, prompt) => ({
    content: completed(
      prompt.includes('recovered child result')
        ? '恢复结果已整理'
        : 'unexpected',
    ),
    response: { stopReason: 'end_turn' },
  })
  const adapter = new AcpBackendAdapter({
    protocol: 'openclaw',
    root: '/repo',
    directory: '/coordinator',
    baseUrl: 'http://127.0.0.1:18789',
    client,
    nativeDelegationAdapter: {
      async wait({ runId, sessionId }) {
        assert.equal(runId, 'run-recovered')
        assert.equal(sessionId, 'agent:child:recovered')
        return { content: 'recovered child result' }
      },
    },
  })

  const result = await adapter.recoverDelegatedWork({
    id: 'work-one',
    ownerId: 'owner-one',
    objective: '恢复项目任务',
    delegation: {
      id: 'run-recovered',
      sessionId: 'agent:child:recovered',
      directory: '/project',
      title: '恢复项目',
    },
  }, {
    onEvent: event => events.push(event),
  })

  assert.equal(
    JSON.parse(result.content).presentation.speech,
    '恢复结果已整理',
  )
  assert.ok(events.some(event => event.type === 'backend.delegated'))
  assert.ok(events.some(
    event => event.type === 'backend.delegation.completed',
  ))
  await adapter.close()
})

test('releases completed ACP tool-call state instead of retaining it globally', () => {
  const adapter = new AcpBackendAdapter({
    protocol: 'qoder',
    client: fakeAcpClient(),
    sessionToolServer: fakeToolServer(),
  })
  const run = {
    toolCalls: new Map(),
    nativeToolCalls: new Map(),
    onEvent: () => {},
  }

  adapter.onSessionUpdate(run, {
    sessionUpdate: 'tool_call',
    toolCallId: 'tool-one',
    name: 'Read',
    status: 'in_progress',
    rawInput: { path: '/project/file.js' },
  })
  assert.equal(run.toolCalls.size, 1)

  adapter.onSessionUpdate(run, {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'tool-one',
    status: 'completed',
  })
  assert.equal(run.toolCalls.size, 0)
  assert.equal(Object.hasOwn(adapter, 'toolCalls'), false)
})

test('injects builtin MCP servers into coordinator and project sessions', async () => {
  const builtin = {
    name: 'open-computer-use',
    command: process.execPath,
    args: ['/repo/node_modules/open-computer-use/bin', 'mcp'],
    env: [{ name: 'ELECTRON_RUN_AS_NODE', value: '1' }],
  }
  const tools = fakeToolServer()
  const sessionMcp = new Map()
  let prompted = false
  const client = {
    async newSession(options) {
      const sessionId = options.role === 'coordinator'
        ? 'coordinator-session'
        : 'project-session'
      sessionMcp.set(sessionId, options.mcpServers)
      return { sessionId, cwd: options.cwd, response: {} }
    },
    async resumeSession(sessionId, options) {
      sessionMcp.set(`resume:${sessionId}`, options.mcpServers)
      return { sessionId, cwd: options.cwd, response: {} }
    },
    async prompt(sessionId) {
      if (sessionId === 'project-session') {
        return {
          content: 'project complete',
          response: { stopReason: 'end_turn' },
        }
      }
      if (!prompted) {
        prompted = true
        await tools.registrations[0].call('startSession', {
          prompt: 'inspect the project',
        })
      }
      return {
        content: completed('coordinator done'),
        response: { stopReason: 'end_turn' },
      }
    },
    async close() {},
  }
  const adapter = new AcpBackendAdapter({
    protocol: 'qoder',
    directory: '/coordinator',
    client,
    sessionToolServer: tools,
    builtinMcp: [builtin],
  })

  const result = await adapter.coordinatorTurn('first turn', {
    ownerId: 'owner-one',
    coordinationRunId: 'work-one',
  })
  await result.run.delegation?.promise

  const coordinator = sessionMcp.get('coordinator-session')
  assert.equal(coordinator.length, 2)
  assert.equal(coordinator[0].type, 'http')
  assert.equal(coordinator[1], builtin)

  const project = sessionMcp.get('project-session')
  assert.deepEqual(project, [builtin])
  await adapter.close()
})

test('builtinMcp defaults keep sessions working when disabled', async () => {
  const tools = fakeToolServer()
  const sessionMcp = new Map()
  const client = {
    async newSession(options) {
      sessionMcp.set('coordinator-session', options.mcpServers)
      return {
        sessionId: 'coordinator-session',
        cwd: options.cwd,
        response: {},
      }
    },
    async resumeSession(sessionId, options) {
      return { sessionId, cwd: options.cwd, response: {} }
    },
    async prompt() {
      return {
        content: completed('done'),
        response: { stopReason: 'end_turn' },
      }
    },
    async close() {},
  }
  const adapter = new AcpBackendAdapter({
    protocol: 'qoder',
    directory: '/coordinator',
    client,
    sessionToolServer: tools,
    builtinMcp: [],
  })

  await adapter.coordinatorTurn('turn', {
    ownerId: 'owner-one',
    coordinationRunId: 'work-one',
  })
  const coordinator = sessionMcp.get('coordinator-session')
  assert.equal(coordinator.length, 1)
  assert.equal(coordinator[0].type, 'http')
  await adapter.close()
})
