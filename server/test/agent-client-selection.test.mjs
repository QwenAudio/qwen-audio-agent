import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AgentClient,
  createAgentClient,
} from '../src/agent/agent-client.mjs'

function fakeAcpClient() {
  return {
    start: async () => ({
      agentCapabilities: {
        sessionCapabilities: { resume: {} },
        mcpCapabilities: { http: true },
      },
    }),
    newSession: async options => ({
      sessionId: 'ses-current',
      cwd: options.cwd,
      response: {},
    }),
    resumeSession: async (sessionId, options) => ({
      sessionId,
      cwd: options.cwd,
      response: {},
    }),
    prompt: async () => ({
      content: 'done',
      response: { stopReason: 'end_turn' },
    }),
    close: async () => {},
  }
}

function fakeToolServer() {
  return {
    register: async () => ({
      descriptor: {
        type: 'http',
        name: 'test',
        url: 'http://127.0.0.1/mcp',
        headers: [],
      },
      release() {},
    }),
    close: async () => {},
  }
}

test('selects one shared ACP adapter for OpenCode', () => {
  const client = createAgentClient({
    protocol: 'opencode',
    backends: {
      opencode: {
        baseUrl: 'http://opencode.test',
        directory: '/workspace',
      },
    },
    coordinatorAgent: 'custom-coordinator',
    sessionStatePath: null,
    acpClient: fakeAcpClient(),
    sessionToolServer: fakeToolServer(),
  })
  assert.equal(client.protocol, 'opencode')
  assert.equal(client.describe().transport, 'acp')
  assert.equal(client.describe().acpConnection, 'process')
  assert.equal(client.describe().sessionModel, 'one-persistent-backend-agent')
})

test('opens the active OpenCode ACP coordinator Session directly', async () => {
  const client = createAgentClient({
    protocol: 'opencode',
    model: '',
    backends: {
      opencode: {
        baseUrl: 'http://opencode.test:4096',
        directory: '/workspace',
      },
    },
    sessionStatePath: null,
    acpClient: fakeAcpClient(),
    sessionToolServer: fakeToolServer(),
  })
  await client.submit({
    id: 'one',
    taskId: 'one',
    ownerId: 'owner-one',
    originalRequest: 'test',
    objective: 'test',
  })
  assert.equal(
    await client.uiUrl({ ownerId: 'owner-one' }),
    'http://opencode.test:4096/server/aHR0cDovL29wZW5jb2RlLnRlc3Q6NDA5Ng/session/ses-current',
  )
})

for (const protocol of [
  'openclaw',
  'qoder',
  'qwen',
  'kimi',
  'hermes',
  'codebuddy',
  'codex',
  'claude',
  'pi',
  'acp',
]) {
  test(`selects ${protocol} through the same ACP adapter`, () => {
    const client = createAgentClient({
      protocol,
      backends: {
        openclaw: {
          directory: '/openclaw',
          baseUrl: 'http://openclaw.test:18789',
        },
        qoder: { directory: '/qoder' },
        qwen: { directory: '/qwen' },
        kimi: { directory: '/kimi' },
        hermes: { directory: '/hermes' },
        codebuddy: { directory: '/codebuddy', model: 'qwen3.7-max' },
        codex: { directory: '/codex', model: 'qwen3.7-max' },
        claude: { directory: '/claude' },
        pi: { directory: '/pi' },
        acp: {
          cliPath: 'example-agent',
          args: ['--acp'],
          label: 'Example Agent',
          directory: '/acp',
        },
      },
      sessionStatePath: null,
      acpClient: fakeAcpClient(),
      sessionToolServer: fakeToolServer(),
    })
    assert.equal(client.protocol, protocol)
    assert.equal(client.describe().transport, 'acp')
    assert.equal(client.describe().acpConnection, 'process')
    assert.equal(client.describe().capabilities.nativeSessionHistory, true)
  })
}

test('does not leak opencode coordinatorAgent to drivers without a coordinatorAgent', () => {
  const client = createAgentClient({
    protocol: 'qoder',
    backends: {
      opencode: { coordinatorAgent: 'opencode-coordinator' },
      qoder: { directory: '/qoder' },
    },
    sessionStatePath: null,
    acpClient: fakeAcpClient(),
    sessionToolServer: fakeToolServer(),
  })
  assert.equal(client.adapter.coordinatorAgent, '')
})

test('handles null backends option gracefully', () => {
  const client = createAgentClient({
    protocol: 'opencode',
    backends: null,
    sessionStatePath: null,
    acpClient: fakeAcpClient(),
    sessionToolServer: fakeToolServer(),
  })
  assert.equal(client.protocol, 'opencode')
})

test('AgentClient owns exactly one injected backend instance', () => {
  const adapter = {
    protocol: 'test',
    label: 'Test',
    describe: () => ({ protocol: 'test' }),
    start: async () => {},
    health: async () => ({ ok: true }),
    submit: async () => ({}),
    status: () => ({ ok: true }),
    cancel: async () => ({}),
    respondAuthorization: async () => ({}),
    respondInput: async () => ({}),
    subscribe: () => () => {},
    close: async () => {},
  }
  const client = new AgentClient({ adapter })
  assert.equal(client.adapter, adapter)
  assert.equal(client.protocol, 'test')
  assert.deepEqual(client.describe(), { protocol: 'test' })
  assert.throws(
    () => new AgentClient(),
    /AgentClient adapter must be an object/,
  )
})
