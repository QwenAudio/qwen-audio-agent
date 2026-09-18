import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'
import {
  A2ABackendAdapter,
  A2ARole,
  A2ATaskState,
  createA2ABackendAdapter,
} from '../src/backend/adapters/a2a/backend-adapter.mjs'
import {
  verifyBackendAdapterConformance,
} from '../src/backend/backend-adapter-conformance.mjs'

function textPart(text, mediaType = 'text/plain') {
  return {
    content: { $case: 'text', value: text },
    metadata: undefined,
    filename: '',
    mediaType,
  }
}

function message(text, options = {}) {
  return {
    messageId: options.messageId || 'message-one',
    contextId: options.contextId || 'context-one',
    taskId: options.taskId || '',
    role: options.role ?? A2ARole.ROLE_AGENT,
    parts: options.parts || [textPart(text)],
    metadata: options.metadata,
    extensions: [],
    referenceTaskIds: [],
  }
}

function task(state, options = {}) {
  return {
    id: options.id || 'a2a-task-one',
    contextId: options.contextId || 'context-one',
    status: {
      state,
      message: options.statusText
        ? message(options.statusText, { taskId: options.id || 'a2a-task-one', metadata: options.statusMetadata })
        : undefined,
      timestamp: new Date().toISOString(),
    },
    artifacts: options.artifacts || [],
    history: options.history || [],
    metadata: undefined,
  }
}

function work(index = 1) {
  return {
    id: `task_${index}`,
    ownerId: 'owner-one',
    objective: `完成请求 ${index}`,
  }
}

function fakeClient({ hold = false, result = null } = {}) {
  const started = Promise.withResolvers()
  const cancelled = new Set()
  const sent = []
  return {
    protocolVersion: '1.0',
    transport: { protocolName: 'HTTP+JSON' },
    started: started.promise,
    sent,
    async sendMessage(request) {
      sent.push(request)
      started.resolve()
      if (result) return result
      return task(A2ATaskState.TASK_STATE_WORKING)
    },
    async getTask({ id }, { signal } = {}) {
      if (hold && !cancelled.has(id)) {
        await new Promise((resolve, reject) => {
          if (signal?.aborted) return reject(signal.reason)
          signal?.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          })
        })
      }
      if (cancelled.has(id)) {
        return task(A2ATaskState.TASK_STATE_CANCELED, { id })
      }
      return task(A2ATaskState.TASK_STATE_COMPLETED, {
        id,
        statusText: '已经完成。',
      })
    },
    async cancelTask({ id }) {
      cancelled.add(id)
      return task(A2ATaskState.TASK_STATE_CANCELED, { id })
    },
  }
}

function fixture({ hold }) {
  const client = fakeClient({ hold })
  return {
    name: 'A2A',
    backend: createA2ABackendAdapter({
      agentCard: {
        name: 'Fixture Agent',
        version: '1.0.0',
        defaultInputModes: ['text/plain'],
        defaultOutputModes: ['text/plain'],
        capabilities: { streaming: false },
      },
      pollIntervalMs: 10,
      clientFactory: async () => ({
        client,
        agentCard: {
          name: 'Fixture Agent',
          version: '1.0.0',
          defaultInputModes: ['text/plain'],
          defaultOutputModes: ['text/plain'],
          capabilities: { streaming: false },
        },
      }),
    }),
    work: work(1),
    nextWork: work(2),
    started: client.started,
  }
}

test('A2A adapter passes the reusable BackendPort conformance suite', async () => {
  await verifyBackendAdapterConformance({ createFixture: fixture })
})

test('A2A conversation continuity is opt-in, owner-scoped, and bypassed for isolated work', async t => {
  for (const reuseContext of [false, true]) {
    const client = fakeClient()
    client.sendMessage = async request => {
      client.sent.push(request)
      return message('完成', { contextId: request.message.contextId || `server-context-${client.sent.length}` })
    }
    const adapter = new A2ABackendAdapter({
      agentCard: { name: 'History test' },
      clientFactory: async () => ({ client }),
      reuseContext,
    })
    t.after(() => adapter.close())
    await adapter.submit(work(1))
    await adapter.submit(work(2))
    await adapter.submit({ ...work(3), ownerId: 'owner-two' })
    await adapter.submit({ ...work(4), continuity: 'isolated' })
    await adapter.submit(work(5))
    const sent = client.sent.map(request => request.message)
    assert.ok(sent.every(item => item.taskId === ''))
    assert.equal(new Set(sent.map(item => item.messageId)).size, 5)
    assert.equal(sent[0].contextId, '')
    assert.equal(sent[2].contextId, '')
    assert.equal(sent[3].contextId, '')
    if (reuseContext) {
      assert.equal(sent[1].contextId, 'server-context-1')
      assert.equal(sent[4].contextId, 'server-context-1')
      assert.equal(adapter.contexts.get('owner-two').id, 'server-context-3')
    } else {
      assert.ok(sent.every(item => item.contextId === ''))
    }
  }
})

test('concurrent submissions wait for server context discovery, not task completion', async t => {
  const firstSent = Promise.withResolvers()
  const secondSent = Promise.withResolvers()
  const discover = Promise.withResolvers()
  const finish = Promise.withResolvers()
  const sent = []
  const client = {
    async sendMessage() { throw new Error('Expected streaming') },
    async *sendMessageStream(request) {
      sent.push(request.message)
      if (sent.length === 1) {
        firstSent.resolve()
        await discover.promise
        yield task(A2ATaskState.TASK_STATE_WORKING, { contextId: 'opaque-server-context' })
        await finish.promise
      } else secondSent.resolve()
      yield task(A2ATaskState.TASK_STATE_COMPLETED, { contextId: 'opaque-server-context' })
    },
  }
  const card = { name: 'Context test', capabilities: { streaming: true } }
  const adapter = new A2ABackendAdapter({ agentCard: card, clientFactory: async () => ({ client, agentCard: card }), reuseContext: true })
  t.after(() => adapter.close())
  const first = adapter.submit(work(1))
  await firstSent.promise
  const second = adapter.submit(work(2))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(sent.length, 1)
  discover.resolve()
  await secondSent.promise
  await second
  assert.equal(adapter.active.has('task_1'), true)
  assert.equal(sent[0].contextId, '')
  assert.equal(sent[1].contextId, 'opaque-server-context')
  finish.resolve()
  await first
})

test('failed context discovery releases waiters; cancelling a waiter never sends a request', async t => {
  const firstSent = Promise.withResolvers()
  const fail = Promise.withResolvers()
  const sent = []
  const client = { async sendMessage(request) {
    sent.push(request.message)
    if (sent.length === 1) {
      firstSent.resolve()
      await fail.promise
      throw new Error('connection failed')
    }
    return message('done', { contextId: 'retry-context' })
  } }
  const adapter = new A2ABackendAdapter({ agentCard: { name: 'Context test' }, clientFactory: async () => ({ client }), reuseContext: true })
  t.after(() => adapter.close())
  const first = assert.rejects(adapter.submit(work(1)), /connection failed/u)
  await firstSent.promise
  const controller = new AbortController()
  const cancelled = assert.rejects(adapter.submit(work(2), { signal: controller.signal }), { code: 'WORK_CANCELLED' })
  const next = adapter.submit(work(3))
  await new Promise(resolve => setImmediate(resolve))
  controller.abort()
  await cancelled
  assert.equal(sent.length, 1)
  fail.resolve()
  await first
  await next
  assert.equal(sent[1].contextId, '')
  await adapter.submit(work(4))
  assert.equal(sent[2].contextId, 'retry-context')
})

test('absent context IDs stay optional; unexpected changes cannot replace an established context', async t => {
  const sent = []
  const replies = ['', 'original', 'unexpected', 'original']
  const client = { async sendMessage(request) {
    sent.push(request.message)
    return { ...message('done'), contextId: replies.shift() }
  } }
  const adapter = new A2ABackendAdapter({ agentCard: { name: 'Context test' }, clientFactory: async () => ({ client }), reuseContext: true })
  t.after(() => adapter.close())
  await adapter.submit(work(1))
  await adapter.submit(work(2))
  await assert.rejects(adapter.submit(work(3)), { code: 'A2A_CONTEXT_MISMATCH' })
  await adapter.submit(work(4))
  assert.deepEqual(sent.map(item => item.contextId), ['', '', 'original', 'original'])
})

test('context reuse bounds inactive owners and discards the mapping on close', async () => {
  const client = { async sendMessage(request) { return message('done', { contextId: request.message.contextId || `context-${request.message.messageId}` }) } }
  const adapter = new A2ABackendAdapter({ agentCard: { name: 'Context test' }, clientFactory: async () => ({ client }), reuseContext: true })
  for (let i = 0; i < 105; i++) await adapter.submit({ ...work(i), ownerId: `owner-${i}` })
  assert.equal(adapter.contexts.size, 100)
  assert.equal(adapter.contexts.has('owner-0'), false)
  assert.equal(adapter.contexts.has('owner-104'), true)
  await adapter.close()
  assert.equal(adapter.contexts.size, 0)
})

test('leaves Task duration unbounded by default and supports an explicit deadline', async () => {
  const unbounded = new A2ABackendAdapter({
    agentCard: { name: 'Long-running Agent' },
    clientFactory: async () => ({
      client: fakeClient({ result: message('完成。') }),
    }),
  })
  assert.equal(unbounded.timeoutMs, 0)
  await unbounded.close()

  const timed = new A2ABackendAdapter({
    agentCard: { name: 'Bounded Agent' },
    pollIntervalMs: 10,
    timeoutMs: 20,
    clientFactory: async () => ({ client: fakeClient({ hold: true }) }),
  })
  await assert.rejects(
    timed.submit(work()),
    error => error.code === 'A2A_TIMEOUT',
  )
  await timed.close()
})

test('discovers identity without exposing credentials', async () => {
  let configured
  let requestHeaders
  const client = fakeClient({
    result: message('直接回复。'),
  })
  const backend = new A2ABackendAdapter({
    agentCardUrl: 'https://agent.example/.well-known/agent-card.json',
    token: 'secret-token',
    headers: { 'X-Tenant': 'tenant-one' },
    fetchImpl: async (_input, init) => {
      requestHeaders = new Headers(init?.headers)
      return new Response('{}', { status: 200 })
    },
    clientFactory: async options => {
      configured = options
      return {
        client,
        agentCard: {
          name: 'Remote Agent',
          version: '2.0.0',
          capabilities: { streaming: true },
          defaultInputModes: ['text/plain', 'image/png'],
          defaultOutputModes: ['text/plain'],
        },
      }
    },
  })

  await backend.start()
  const description = backend.describe()
  assert.equal(description.label, 'Remote Agent')
  assert.equal(description.transport, 'HTTP+JSON')
  assert.equal(description.protocolVersion, '1.0')
  assert.equal(description.capabilities.streaming, true)
  assert.equal(JSON.stringify(description).includes('secret-token'), false)

  await configured.fetchImpl('https://agent.example/rpc', {
    headers: { Accept: 'application/json' },
  })
  assert.equal(requestHeaders.get('authorization'), 'Bearer secret-token')
  assert.equal(requestHeaders.get('x-tenant'), 'tenant-one')
  assert.equal(requestHeaders.get('accept'), 'application/json')
  await backend.close()
})

test('projects A2A messages and task artifacts into public outcomes', async () => {
  const completed = task(A2ATaskState.TASK_STATE_COMPLETED, {
    statusText: '报告已经完成。',
    history: [message('分析过程。')],
    artifacts: [{
      artifactId: 'report',
      name: '报告',
      description: '最终报告',
      parts: [
        textPart('# 结果', 'text/markdown'),
        {
          content: { $case: 'url', value: 'https://example.com/report.pdf' },
          metadata: undefined,
          filename: 'report.pdf',
          mediaType: 'application/pdf',
        },
      ],
    }],
  })
  const client = fakeClient({ result: completed })
  const backend = new A2ABackendAdapter({
    agentCard: { name: 'Artifact Agent' },
    clientFactory: async () => ({ client }),
  })

  const outcome = await backend.submit(work())
  assert.equal(outcome.presentation, undefined)
  assert.doesNotMatch(outcome.content, /分析过程/)
  assert.match(outcome.content, /# 结果/)
  assert.deepEqual(outcome.artifacts, [{
    artifactId: 'report',
    name: '报告',
    description: '最终报告',
    parts: [
      { text: '# 结果', mediaType: 'text/markdown' },
      {
        url: 'https://example.com/report.pdf',
        mediaType: 'application/pdf',
        filename: 'report.pdf',
      },
    ],
  }])
  await backend.close()
})

test('sends objective and attachments as standard A2A message parts', async () => {
  const client = fakeClient({ result: message('收到。') })
  const backend = new A2ABackendAdapter({
    agentCard: { name: 'Multimodal Agent' },
    clientFactory: async () => ({ client }),
  })
  await backend.submit({
    ...work(),
    inputParts: [{
      type: 'file',
      mime: 'image/png',
      filename: 'reference.png',
      url: 'data:image/png;base64,aGVsbG8=',
    }, {
      type: 'file',
      mime: 'text/plain',
      filename: 'guide.txt',
      url: 'https://example.com/guide.txt',
    }],
  })

  const request = client.sent[0]
  assert.equal(request.configuration.returnImmediately, true)
  assert.equal(request.message.role, A2ARole.ROLE_USER)
  assert.equal(request.message.parts[0].content.value, '完成请求 1')
  assert.equal(request.message.parts[1].content.$case, 'raw')
  assert.equal(
    request.message.parts[1].content.value.toString(),
    'hello',
  )
  assert.equal(request.message.parts[2].content.$case, 'url')
  assert.equal(request.message.metadata, undefined)
  assert.equal(request.metadata, undefined)
  await backend.close()
})

test('normalizes A2A streaming status messages and artifacts into Task updates', async () => {
  const requests = []
  const client = {
    async sendMessage() {
      throw new Error('streaming path expected')
    },
    async *sendMessageStream(request) {
      requests.push(request)
      yield {
        payload: {
          $case: 'statusUpdate',
          value: {
            taskId: 'remote-stream-task',
            contextId: 'remote-context',
            status: {
              state: A2ATaskState.TASK_STATE_WORKING,
              message: message('正在整理资料。', {
                taskId: 'remote-stream-task',
              }),
            },
          },
        },
      }
      yield {
        payload: {
          $case: 'artifactUpdate',
          value: {
            taskId: 'remote-stream-task',
            contextId: 'remote-context',
            append: false,
            lastChunk: true,
            artifact: {
              artifactId: 'stream-report',
              name: '报告',
              description: '流式产物',
              parts: [textPart('# 结果', 'text/markdown')],
            },
          },
        },
      }
      yield {
        payload: {
          $case: 'statusUpdate',
          value: {
            taskId: 'remote-stream-task',
            contextId: 'remote-context',
            status: {
              state: A2ATaskState.TASK_STATE_COMPLETED,
              message: message('已经完成。', {
                taskId: 'remote-stream-task',
              }),
            },
          },
        },
      }
    },
  }
  const backend = new A2ABackendAdapter({
    agentCard: {
      name: 'Streaming Agent',
      capabilities: { streaming: true },
    },
    clientFactory: async () => ({ client }),
  })
  const events = []
  backend.subscribe(event => events.push(event))

  const outcome = await backend.submit(work())

  assert.equal(requests[0].configuration.returnImmediately, false)
  assert.match(outcome.content, /已经完成/)
  assert.equal(outcome.presentation, undefined)
  assert.equal(outcome.artifacts[0].artifactId, 'stream-report')
  assert.ok(events.some(event => (
    event.type === 'backend.message'
    && event.message === '正在整理资料。'
    && event.taskId === 'task_1'
  )))
  assert.ok(events.some(event => (
    event.type === 'backend.artifact'
    && event.artifact.artifactId === 'stream-report'
    && event.taskId === 'task_1'
  )))
  await backend.close()
})

test('resumes the same A2A task after input is supplied', async () => {
  const client = fakeClient()
  let calls = 0
  client.sendMessage = async request => {
    client.sent.push(request)
    calls += 1
    return calls === 1
      ? task(A2ATaskState.TASK_STATE_INPUT_REQUIRED, {
          statusText: '请选择输出格式。',
        })
      : task(A2ATaskState.TASK_STATE_COMPLETED, {
          statusText: '已经按 Markdown 输出。',
        })
  }
  const backend = new A2ABackendAdapter({
    agentCard: { name: 'Interactive Agent' },
    clientFactory: async () => ({ client }),
  })
  const events = []
  backend.subscribe(event => events.push(event))
  const pending = backend.submit(work())
  await new Promise(resolve => setImmediate(resolve))
  const requested = events.find(event => event.type === 'backend.input.requested')
  assert.equal(requested.input.prompt, '请选择输出格式。')
  assert.equal(backend.status('task_1').state, 'input_required')
  await backend.respondInput('task_1', requested.input.id, {
    action: 'accept',
    text: 'Markdown',
  }, { ownerId: 'owner-one' })
  const outcome = await pending
  assert.match(outcome.content, /Markdown/)
  assert.equal(client.sent[1].message.taskId, 'a2a-task-one')
  assert.equal(client.sent[1].message.contextId, 'context-one')
  assert.equal(client.sent[1].message.parts[0].content.value, 'Markdown')
  assert.ok(events.some(event => event.type === 'backend.input.resolved'))
  await backend.close()
})

test('authorization requires an explicit valid decision and final output excludes old prompts', async () => {
  const client = fakeClient()
  client.sendMessage = async request => {
    client.sent.push(request)
    return client.sent.length === 1
      ? task(A2ATaskState.TASK_STATE_AUTH_REQUIRED, { statusText: '请确认取消。' })
      : task(A2ATaskState.TASK_STATE_COMPLETED, {
          statusText: '已取消。', history: [message('请确认取消。'), message('正在执行工具')],
        })
  }
  const backend = new A2ABackendAdapter({
    agentCard: { name: 'Authorization Agent' }, clientFactory: async () => ({ client }),
  })
  const events = []
  backend.subscribe(event => events.push(event))
  const pending = backend.submit(work())
  await new Promise(resolve => setImmediate(resolve))
  const input = events.find(event => event.type === 'backend.input.requested').input
  for (const response of [{}, { action: 'oops' }, { text: '同意' }]) {
    await assert.rejects(backend.respondInput('task_1', input.id, response), {
      code: 'INPUT_ACTION_REQUIRED',
    })
  }
  await backend.respondInput('task_1', input.id, { action: 'accept' })
  assert.equal((await pending).content, '已取消。')
  assert.deepEqual(client.sent[1].message.metadata.qwenAudioInputResponse, {
    kind: 'authorization', action: 'accept',
  })
  await backend.close()
})

test('expired authorization resolves the frontend input and ends the task without an answer', async () => {
  const client = fakeClient()
  client.sendMessage = async () => task(A2ATaskState.TASK_STATE_AUTH_REQUIRED, {
    statusText: '请确认。', statusMetadata: { qwenAudioApprovalExpiresAt: Date.now() + 30 },
  })
  let cancellations = 0
  const cancel = client.cancelTask.bind(client)
  client.cancelTask = async request => { cancellations += 1; return cancel(request) }
  const backend = new A2ABackendAdapter({
    agentCard: { name: 'Expiring Agent' }, clientFactory: async () => ({ client }),
  })
  const events = []
  backend.subscribe(event => events.push(event))
  await assert.rejects(backend.submit(work()), { code: 'INPUT_EXPIRED' })
  assert.equal(cancellations, 1)
  assert.ok(events.some(e => e.type === 'backend.input.resolved' && e.input.status === 'cancelled'))
  await backend.close()
})

test('rejects credential-bearing and non-HTTP Agent Card URLs', () => {
  assert.throws(
    () => new A2ABackendAdapter({
      agentCardUrl: 'https://user:password@agent.example/card.json',
    }),
    /must not contain credentials/,
  )
  assert.throws(
    () => new A2ABackendAdapter({ agentCardUrl: 'file:///tmp/card.json' }),
    /must use HTTP or HTTPS/,
  )
})

test('interoperates with an A2A 1.0 HTTP+JSON agent through official discovery', async () => {
  let received
  const server = http.createServer(async (request, response) => {
    if (request.url === '/.well-known/agent-card.json') {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({
        name: 'Loopback Agent',
        description: 'A2A integration fixture',
        version: '1.0.0',
        supportedInterfaces: [{
          url: `http://127.0.0.1:${server.address().port}`,
          protocolBinding: 'HTTP+JSON',
          protocolVersion: '1.0',
          tenant: '',
        }],
        capabilities: { streaming: false, extensions: [] },
        securitySchemes: {},
        securityRequirements: [],
        defaultInputModes: ['text/plain'],
        defaultOutputModes: ['text/plain'],
        skills: [],
        signatures: [],
      }))
      return
    }
    if (request.url === '/message:send' && request.method === 'POST') {
      let body = ''
      for await (const chunk of request) body += chunk
      received = JSON.parse(body)
      response.setHeader('content-type', 'application/a2a+json')
      response.end(JSON.stringify({
        task: {
          id: 'remote-task',
          contextId: 'remote-context',
          status: {
            state: 'TASK_STATE_COMPLETED',
            message: {
              messageId: 'remote-message',
              contextId: 'remote-context',
              taskId: 'remote-task',
              role: 'ROLE_AGENT',
              parts: [{ text: '回环任务已经完成。', mediaType: 'text/plain' }],
              extensions: [],
              referenceTaskIds: [],
            },
            timestamp: new Date().toISOString(),
          },
          artifacts: [],
          history: [],
        },
      }))
      return
    }
    response.statusCode = 404
    response.end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const backend = new A2ABackendAdapter({
    agentCardUrl: `http://127.0.0.1:${server.address().port}/.well-known/agent-card.json`,
  })
  try {
    const outcome = await backend.submit({ ...work(), objective: '回环测试' })
    assert.equal(backend.describe().transport, 'HTTP+JSON')
    assert.equal(received.message.parts[0].text, '回环测试')
    assert.equal(received.configuration.returnImmediately, true)
    assert.equal(outcome.content, '回环任务已经完成。')
    assert.equal(outcome.presentation, undefined)
  } finally {
    await backend.close()
    await new Promise(resolve => server.close(resolve))
  }
})
