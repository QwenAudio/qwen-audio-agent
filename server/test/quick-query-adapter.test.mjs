import assert from 'node:assert/strict'
import test from 'node:test'
import { AcpBackendAdapter } from '../src/agent/acp-backend-adapter.mjs'

function toolServer() {
  return {
    async register() {
      return {
        descriptor: {
          type: 'http',
          name: 'quick-query-test',
          url: 'http://127.0.0.1/mcp/quick-query-test',
          headers: [],
        },
        update() {},
        release() {},
      }
    },
    async close() {},
  }
}

function fakeClient(gate, startGate) {
  const prompts = []
  let sessionCount = 0
  let startCount = 0
  return {
    prompts,
    get startCount() { return startCount },
    ready: true,
    async start() {
      startCount += 1
      if (startCount > 1) await startGate.promise
      return {
        agentCapabilities: {
          mcpCapabilities: { http: true },
          sessionCapabilities: { resume: {}, close: {} },
        },
      }
    },
    async newSession(options) {
      sessionCount += 1
      return {
        sessionId: `coordinator-${sessionCount}`,
        cwd: options.cwd,
        response: {},
      }
    },
    async resumeSession(sessionId, options) {
      return {
        sessionId,
        cwd: options.cwd,
        response: {},
      }
    },
    async prompt(_sessionId, prompt) {
      prompts.push(String(prompt))
      if (prompt === 'ordinary-1') await gate.promise
      return {
        content: prompt.includes('<qwen_audio_agent_quick_query>')
          ? 'verified quick answer'
          : 'ordinary answer',
        response: { stopReason: 'end_turn' },
      }
    },
    async close() {},
  }
}

test('quick lookup uses the persistent coordinator session', async () => {
  const gate = Promise.withResolvers()
  const startGate = Promise.withResolvers()
  const client = fakeClient(gate, startGate)
  const adapter = new AcpBackendAdapter({
    protocol: 'opencode',
    directory: '/coordinator',
    client,
    sessionToolServer: toolServer(),
  })
  const quick = adapter.quickLookup('How is this configured?', {
    ownerId: 'owner',
  })
  startGate.resolve()
  gate.resolve()
  const quickResult = await quick
  assert.equal(quickResult.content, 'verified quick answer')
  assert.equal(client.prompts.length, 1)
  assert.equal(client.prompts[0].includes('<qwen_audio_agent_quick_query>'), true)
  assert.equal(adapter.describe().capabilities.quickQuery, true)
  await adapter.close()
})
