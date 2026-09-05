import assert from 'node:assert/strict'
import test from 'node:test'
import { AcpBackendAdapter } from '../src/agent/acp-backend-adapter.mjs'
import { assertBackendPort } from '../src/backend/backend-port.mjs'

function fakeClient({
  hold = false,
  content = '已经完成。',
  contentBlocks = [],
  stopReason = 'end_turn',
} = {}) {
  const gate = Promise.withResolvers()
  return {
    ready: false,
    gate,
    prompts: [],
    sessions: [],
    closedSessions: [],
    async start() {
      this.ready = true
      return {
        agentCapabilities: { sessionCapabilities: { resume: {} } },
      }
    },
    async newSession(options) {
      const sessionId = `session-${this.sessions.length + 1}`
      this.sessions.push({ sessionId, options })
      return { sessionId, cwd: options.cwd, response: {} }
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
        content,
        contentBlocks,
        response: { stopReason },
      }
    },
    async close() {},
    async closeSession(sessionId) {
      this.closedSessions.push(sessionId)
    },
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
    taskId: 'job_1',
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
    taskId: 'work-one',
    state: 'working',
    activity: [],
  })
  assert.equal(events[0].type, 'backend.activity')
  assert.equal(events[0].taskId, 'work-one')
  assert.equal(events[0].ownerId, 'owner-one')
  assert.equal(client.prompts[0][0].type, 'text')
  assert.doesNotMatch(client.prompts[0][0].text, /reference\.png|work-one|job_1/u)
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
  })
  assert.equal('metadata' in outcome, false)
  assert.equal('sessionId' in outcome, false)
  assert.equal(backend.status('work-one').state, 'not_found')
  unsubscribe()
  await backend.close()
})

test('ACP submit preserves non-text output as standard artifacts', async () => {
  const backend = adapter({
    client: fakeClient({
      content: '',
      contentBlocks: [{
        type: 'image',
        mimeType: 'image/png',
        data: 'aGVsbG8=',
        uri: 'https://example.com/result.png',
      }],
    }),
  })

  const outcome = await backend.submit({
    id: 'work-image',
    ownerId: 'owner-one',
    message: '生成图片',
  })

  assert.equal(outcome.content, '')
  assert.equal('presentation' in outcome, false)
  assert.deepEqual(outcome.artifacts, [{
    artifactId: 'acp_content_1',
    name: 'result.png',
    parts: [{
      raw: 'aGVsbG8=',
      mediaType: 'image/png',
      filename: 'result.png',
    }],
  }])
  await backend.close()
})

test('ACP submit accepts only a successful protocol turn as completed work', async () => {
  const backend = adapter({
    client: fakeClient({
      content: '尚未完成的部分结果',
      stopReason: 'max_tokens',
    }),
  })

  await assert.rejects(backend.submit({
    id: 'work-incomplete',
    ownerId: 'owner-one',
    message: '完成一项工作',
  }), /达到最大输出长度，未能完成当前回合/u)
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
  assert.equal(authorization.taskId, 'work-one')
  assert.equal(authorization.status, 'approved')
  assert.deepEqual(await requested, {
    outcome: { outcome: 'selected', optionId: 'allow' },
  })
  await backend.close()
})

test('ACP isolated work uses a fresh one-shot Session without coordinator instructions', async () => {
  const client = fakeClient()
  const backend = adapter({ client })
  const outcome = await backend.submit({
    id: 'ingest-one',
    ownerId: 'owner-one',
    instruction: '把文件转换成 Markdown。',
    continuity: 'isolated',
  })

  assert.equal(client.sessions.length, 1)
  assert.equal(client.sessions[0].options.role, 'utility')
  assert.equal(client.prompts.length, 1)
  const prompt = Array.isArray(client.prompts[0])
    ? client.prompts[0][0].text
    : client.prompts[0]
  assert.equal(prompt, '把文件转换成 Markdown。')
  assert.doesNotMatch(prompt, /协调|session_start/u)
  assert.deepEqual(client.closedSessions, ['session-1'])
  assert.equal(outcome.metadata.backendRef.role, 'utility')
  assert.equal(backend.coordinatorSessions.size, 0)
  await backend.close()
})

test('ACP isolated work closes its Session when configuration fails', async () => {
  const client = fakeClient()
  const backend = adapter({
    client,
    profile: {
      label: 'Test ACP',
      capabilities: {},
      acpConnection: { kind: 'process' },
      externalMcp: false,
      sessionMcp: false,
      sessionConfigOptions: [{ id: 'approval-mode', value: 'strict' }],
    },
  })

  await assert.rejects(backend.submit({
    id: 'ingest-config-failure',
    ownerId: 'owner-one',
    instruction: '把文件转换成 Markdown。',
    continuity: 'isolated',
  }), /没有通过 ACP 提供必要的 Session 配置/u)

  assert.deepEqual(client.closedSessions, ['session-1'])
  assert.equal(client.prompts.length, 0)
  await backend.close()
})
