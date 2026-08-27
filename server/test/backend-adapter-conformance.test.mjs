import test from 'node:test'
import { AcpBackendAdapter } from '../src/agent/acp-backend-adapter.mjs'
import {
  verifyBackendAdapterConformance,
} from '../src/backend/backend-adapter-conformance.mjs'

function work(index) {
  return {
    id: `task_${index}`,
    ownerId: 'owner-one',
    originalRequest: `完成请求 ${index}`,
    objective: `完成请求 ${index}`,
  }
}

function fakeClient({ hold }) {
  const started = Promise.withResolvers()
  return {
    ready: false,
    started: started.promise,
    async start() {
      this.ready = true
      return {
        agentCapabilities: { sessionCapabilities: { resume: {} } },
      }
    },
    async newSession(options) {
      return { sessionId: 'coordinator-one', cwd: options.cwd, response: {} }
    },
    async resumeSession(sessionId, options) {
      return { sessionId, cwd: options.cwd, response: {} }
    },
    async prompt(_sessionId, _prompt, options = {}) {
      options.onUpdate?.({
        sessionUpdate: 'tool_call',
        toolCallId: 'tool-one',
        name: 'Read',
        status: 'in_progress',
        rawInput: { path: '/project/package.json' },
      })
      started.resolve()
      if (hold) {
        await new Promise((resolve, reject) => {
          if (options.signal?.aborted) {
            reject(options.signal.reason)
            return
          }
          options.signal?.addEventListener(
            'abort',
            () => reject(options.signal.reason),
            { once: true },
          )
        })
      }
      return {
        content: JSON.stringify({
          task_id: 'job',
          state: 'completed',
          mode: 'respond',
          result: '已经完成。',
        }),
        response: { stopReason: 'end_turn' },
      }
    },
    async close() {},
  }
}

function createFixture({ hold }) {
  const client = fakeClient({ hold })
  return {
    name: 'ACP',
    backend: new AcpBackendAdapter({
      protocol: 'acp',
      directory: '/project',
      sessionStatePath: null,
      builtinMcp: [],
      client,
      profile: {
        label: 'Test ACP',
        capabilities: {},
        acpConnection: { kind: 'process' },
        externalMcp: false,
        sessionMcp: false,
      },
    }),
    work: work(1),
    nextWork: work(2),
    started: client.started,
  }
}

test('ACP adapter passes the reusable BackendPort conformance suite', async () => {
  await verifyBackendAdapterConformance({ createFixture })
})
