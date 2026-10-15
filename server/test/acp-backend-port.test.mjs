import assert from 'node:assert/strict'
import test from 'node:test'
import { AcpBackendAdapter } from '../src/backend/adapters/acp/backend-adapter.mjs'
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

test('active delegated updates target the project Session, not the shared coordinator', async () => {
  const client = fakeClient()
  const backend = adapter({ client })
  const prompts = []
  const cancels = []
  const firstProject = Promise.withResolvers()
  let initial = true
  let projectTurns = 0
  client.prompt = async (sessionId, prompt) => {
    prompts.push({ sessionId, prompt })
    if (sessionId === 'session-1' && initial) {
      initial = false
      await backend.startProjectSession(backend.coordinationRuns.get('task_1'), { prompt: 'initial project' })
      return { content: 'started', response: { stopReason: 'end_turn' } }
    }
    if (sessionId === 'session-2') {
      if (projectTurns++ === 0) return firstProject.promise
      return { content: 'updated project result', response: { stopReason: 'end_turn' } }
    }
    assert.match(JSON.stringify(prompt), /updated project result/u)
    return { content: 'final updated result', response: { stopReason: 'end_turn' } }
  }
  client.cancelSession = async sessionId => {
    cancels.push(sessionId)
    firstProject.resolve({ content: 'old result', response: { stopReason: 'cancelled' } })
  }
  try {
    const done = backend.submit({ id: 'task_1', ownerId: 'owner', objective: 'independent project' })
    await new Promise(resolve => setImmediate(resolve))
    const receipt = backend.update('task_1', { instruction: 'change project' }, { ownerId: 'owner' })
    await receipt.completion
    assert.equal((await done).content, 'final updated result')
    assert.deepEqual(cancels, ['session-2'])
    assert.deepEqual(prompts.map(call => call.sessionId), ['session-1', 'session-2', 'session-2', 'session-1'])
    assert.match(JSON.stringify(prompts[2].prompt), /change project/u)
  } finally { await backend.close() }
})

test('continuation never silently switches to a different coordinator Session', async () => {
  const client = fakeClient()
  const backend = adapter({ client })
  try {
    await assert.rejects(backend.submit({
      id: 'task_1', ownerId: 'owner', objective: 'continue',
      resumeContext: { adapter: 'acp', token: 'unavailable-original' },
    }), { code: 'context_unavailable' })
    assert.equal(client.prompts.length, 0)
  } finally { await backend.close() }
})

test('cancel confirms settlement before the same task can resume and receive updates', async () => {
  const client = fakeClient()
  const backend = adapter({ client, maxConcurrentTasks: 1 })
  const stopping = Promise.withResolvers()
  const resumed = Promise.withResolvers()
  const calls = []
  const steers = []
  client.prompt = async (sessionId, prompt, options) => {
    calls.push({ sessionId, prompt, signal: options.signal })
    if (calls.length === 2) return stopping.promise
    if (calls.length === 3) return resumed.promise
    return { content: 'initial result', response: { stopReason: 'end_turn' } }
  }
  client.steeringMode = () => 'extension'
  client.steerSession = async (sessionId, prompt) => {
    steers.push({ sessionId, prompt })
    return { outcome: 'injected' }
  }
  const work = { id: 'same-task', ownerId: 'owner', objective: 'initial' }
  try {
    const initial = await backend.submit(work)
    const continuation = { ...work, objective: 'continue', resumeContext: initial.continuation }
    const running = backend.submit(continuation)
    const stopped = assert.rejects(running, /用户已取消/u)
    await new Promise(resolve => setImmediate(resolve))
    let confirmed = false
    const cancellation = backend.cancel(work.id, { ownerId: work.ownerId })
      .then(result => { confirmed = true; return result })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(calls[1].signal.aborted, true)
    assert.equal(confirmed, false)
    assert.equal(backend.workControllers.has(work.id), true)
    await assert.rejects(backend.submit(continuation), /already active/u)
    assert.throws(() => backend.update(work.id, { instruction: 'too soon' }, {
      ownerId: work.ownerId,
    }), { code: 'task_cancelling' })
    assert.equal(calls.length, 2)

    stopping.resolve({ content: '', response: { stopReason: 'cancelled' } })
    await stopped
    assert.deepEqual(await cancellation, { taskId: work.id, state: 'cancelled' })
    assert.equal(backend.workControllers.has(work.id), false)
    const next = backend.submit({ ...continuation, objective: 'resume after cancellation' })
    await new Promise(resolve => setImmediate(resolve))
    const receipt = backend.update(work.id, { instruction: 'new requirements' }, {
      ownerId: work.ownerId,
    })
    await receipt.completion
    resumed.resolve({ content: 'resumed and updated', response: { stopReason: 'end_turn' } })
    assert.equal((await next).content, 'resumed and updated')
    assert.deepEqual(calls.map(call => call.sessionId), ['session-1', 'session-1', 'session-1'])
    assert.equal(steers[0].sessionId, 'session-1')
    assert.match(JSON.stringify(steers[0].prompt), /new requirements/u)
  } finally {
    stopping.resolve({ content: '', response: { stopReason: 'cancelled' } })
    resumed.resolve({ content: 'cleanup', response: { stopReason: 'end_turn' } })
    await backend.close()
  }
})

test('unresponsive cancellation is bounded and does not release the active Session', async () => {
  const client = fakeClient()
  const backend = adapter({ client, maxConcurrentTasks: 1, cancelTimeoutMs: 20 })
  const stopping = Promise.withResolvers()
  let calls = 0
  client.prompt = async () => {
    if (++calls === 1) return stopping.promise
    return { content: 'safe after settlement', response: { stopReason: 'end_turn' } }
  }
  const work = { id: 'same-task', ownerId: 'owner', objective: 'request' }
  const running = backend.submit(work)
  const stopped = assert.rejects(running, /用户已取消/u)
  try {
    await new Promise(resolve => setImmediate(resolve))
    await assert.rejects(backend.cancel(work.id, { ownerId: work.ownerId }), {
      code: 'cancellation_unconfirmed',
    })
    assert.equal(backend.workControllers.has(work.id), true)
    await assert.rejects(backend.submit(work), /already active/u)
    const queued = backend.submit({ ...work, id: 'next-task' })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(calls, 1)
    stopping.resolve({ content: '', response: { stopReason: 'cancelled' } })
    await stopped
    assert.equal((await queued).content, 'safe after settlement')
    assert.equal((await backend.submit(work)).content, 'safe after settlement')
  } finally {
    stopping.resolve({ content: '', response: { stopReason: 'cancelled' } })
    await backend.close()
  }
})

test('cancel preserves remote-stop uncertainty and prevents continuation on that Session', async () => {
  const client = fakeClient()
  const backend = adapter({ client })
  const uncertain = Object.assign(new Error('remote stop was not confirmed'), { contextUncertain: true })
  let calls = 0
  client.prompt = async (_sessionId, _prompt, { signal }) => {
    if (++calls === 1) return { content: 'initial', response: { stopReason: 'end_turn' } }
    return new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(uncertain), { once: true })
    })
  }
  const work = { id: 'same-task', ownerId: 'owner', objective: 'initial' }
  try {
    const initial = await backend.submit(work)
    const continuation = { ...work, objective: 'continue', resumeContext: initial.continuation }
    const running = backend.submit(continuation)
    const failed = assert.rejects(running, error => error === uncertain)
    await new Promise(resolve => setImmediate(resolve))
    await assert.rejects(backend.cancel(work.id, { ownerId: work.ownerId }), error => error === uncertain)
    await failed
    assert.equal(backend.workControllers.has(work.id), false)
    assert.equal(backend.uncertainUpdateSessions.has('session-1'), true)
    await assert.rejects(backend.submit(continuation), { code: 'context_unavailable' })
    assert.equal(calls, 2)
  } finally { await backend.close() }
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
    continuation: { adapter: 'acp', token: 'session-1' },
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
