import assert from 'node:assert/strict'
import test from 'node:test'
import { AcpBackendAdapter } from '../src/agent/acp-backend-adapter.mjs'
import { assertBackendPort } from '../src/backend/backend-port.mjs'

function fakeClient({ hold = false } = {}) {
  const gate = Promise.withResolvers()
  return {
    ready: false,
    gate,
    prompts: [],
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
    async prompt(_sessionId, prompt, options = {}) {
      this.prompts.push(prompt)
      options.onUpdate?.({
        sessionUpdate: 'tool_call',
        toolCallId: 'tool-one',
        name: 'Read',
        status: 'in_progress',
        rawInput: { path: '/project/package.json' },
      })
      if (hold) await gate.promise
      return {
        content: JSON.stringify({
          job_id: 'job_1',
          state: 'completed',
          mode: 'respond',
          presentation: { speech: '已经完成。', inline: null },
        }),
        response: { stopReason: 'end_turn' },
      }
    },
    async close() {},
  }
}

function adapter(options = {}) {
  return new AcpBackendAdapter({
    protocol: 'acp',
    directory: '/project',
    sessionStatePath: null,
    builtinMcp: [],
    profile: {
      label: 'Test ACP',
      capabilities: {},
      acpConnection: { kind: 'process' },
      externalMcp: false,
      sessionMcp: false,
    },
    ...options,
  })
}

test('ACP adapter implements the complete BackendPort surface', () => {
  const backend = adapter({ client: fakeClient() })
  assert.equal(assertBackendPort(backend), backend)
})

test('ACP submit exposes Work values while Session details stay private', async () => {
  const client = fakeClient({ hold: true })
  const backend = adapter({ client })
  const events = []
  const unsubscribe = backend.subscribe(event => events.push(event))

  const pending = backend.submit({
    id: 'work-one',
    jobId: 'job_1',
    ownerId: 'owner-one',
    message: '完成请求',
    inputParts: [{
      type: 'file',
      mime: 'image/png',
      filename: 'reference.png',
      url: 'data:image/png;base64,aGVsbG8=',
    }],
  })
  await new Promise(resolve => setImmediate(resolve))

  assert.deepEqual(backend.status('work-one', {
    ownerId: 'owner-one',
  }), {
    workId: 'work-one',
    state: 'working',
    activity: [],
  })
  assert.equal(events[0].type, 'backend.activity')
  assert.equal(events[0].workId, 'work-one')
  assert.equal(events[0].ownerId, 'owner-one')
  assert.equal(client.prompts[0][0].type, 'text')
  assert.match(client.prompts[0][0].text, /reference\.png/)
  assert.deepEqual(client.prompts[0][1], {
    type: 'image',
    mimeType: 'image/png',
    data: 'aGVsbG8=',
    uri: 'qwen-audio-agent://input/reference.png',
  })

  client.gate.resolve()
  const outcome = await pending
  assert.deepEqual(outcome, {
    content: '已经完成。',
    artifacts: [],
    presentation: { speech: '已经完成。', inline: null },
  })
  assert.equal('metadata' in outcome, false)
  assert.equal('sessionId' in outcome, false)
  assert.equal(backend.status('work-one').state, 'not_found')
  unsubscribe()
  await backend.close()
})

test('ACP authorization decisions remain bound to their Work', async () => {
  const backend = adapter({ client: fakeClient() })
  const requested = backend.handlePermission({
    toolCall: { name: 'write', rawInput: { path: '/project/file' } },
    options: [
      { optionId: 'allow', kind: 'allow_once' },
      { optionId: 'reject', kind: 'reject_once' },
    ],
  }, {
    session: {
      sessionId: 'coordinator-one',
      ownerId: 'owner-one',
      coordinationRunId: 'work-one',
      permissionScopeId: 'prompt-one',
    },
  })
  const authorizationId = [...backend.pendingPermissions.keys()][0]

  await assert.rejects(
    backend.respondAuthorization(
      'work-two',
      authorizationId,
      'always',
      { ownerId: 'owner-one' },
    ),
    /不属于这项工作/,
  )
  const authorization = await backend.respondAuthorization(
    'work-one',
    authorizationId,
    'always',
    { ownerId: 'owner-one' },
  )
  assert.equal(authorization.workId, 'work-one')
  assert.equal(authorization.status, 'approved')
  assert.deepEqual(await requested, {
    outcome: { outcome: 'selected', optionId: 'allow' },
  })
  await backend.close()
})
