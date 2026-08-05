import assert from 'node:assert/strict'
import test from 'node:test'
import { AgentClient } from '../src/agent/agent-client.mjs'

function fakeAcpClient() {
  return {
    start: async () => ({
      agentCapabilities: { sessionCapabilities: { resume: {} } },
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
      content: '{"work_id":"one","state":"completed","mode":"respond","presentation":{"speech":"done","inline":null}}',
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
  const client = new AgentClient({
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
  assert.equal(client.describe().sessionModel, 'one-persistent-backend-agent')
})

test('opens the active OpenCode ACP coordinator Session directly', async () => {
  const client = new AgentClient({
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
  await client.runCoordinator('test', {
    ownerId: 'owner-one',
    coordinationRunId: 'one',
  })
  assert.equal(
    await client.uiUrl({ ownerId: 'owner-one' }),
    'http://opencode.test:4096/server/aHR0cDovL29wZW5jb2RlLnRlc3Q6NDA5Ng/session/ses-current',
  )
})

for (const protocol of [
  'openclaw',
  'qoder',
  'kimi',
  'hermes',
  'codebuddy',
  'codex',
  'claude',
  'acp',
]) {
  test(`selects ${protocol} through the same ACP adapter`, () => {
    const client = new AgentClient({
      protocol,
      backends: {
        openclaw: {
          directory: '/openclaw',
          baseUrl: 'http://openclaw.test:18789',
        },
        qoder: { directory: '/qoder' },
        kimi: { directory: '/kimi' },
        hermes: { directory: '/hermes' },
        codebuddy: { directory: '/codebuddy', model: 'qwen3.7-max' },
        codex: { directory: '/codex', model: 'qwen3.7-max' },
        claude: { directory: '/claude' },
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
    assert.equal(client.describe().capabilities.nativeSessionHistory, true)
  })
}
