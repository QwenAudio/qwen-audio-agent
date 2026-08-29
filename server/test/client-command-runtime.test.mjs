import assert from 'node:assert/strict'
import test from 'node:test'
import {
  GatewayClientProtocolEvent,
} from '../../shared/gateway-client-protocol.mjs'
import {
  GatewayClientCommandRuntime,
  RuntimeCommandError,
} from '../src/client/client-command-runtime.mjs'

function task(overrides = {}) {
  return {
    id: 'task_1',
    workState: 'working',
    status: 'running',
    kind: 'work',
    objective: '查询本机内存',
    ownerId: 'owner-1',
    sessionId: 'voice-1',
    createdAt: 1,
    startedAt: 2,
    completedAt: null,
    elapsedMs: 3,
    ...overrides,
  }
}

function harness(overrides = {}) {
  const records = new Map([['task_1', task()]])
  const calls = { created: [], cancelled: [], backend: [], inputs: [] }
  const taskManager = {
    create(options) {
      calls.created.push(options)
      const created = task({
        id: `task_${records.size + 1}`,
        objective: options.objective,
        sessionId: options.sessionId,
      })
      records.set(created.id, created)
      return created
    },
    get(id, { ownerId } = {}) {
      const value = records.get(id)
      return value?.ownerId === ownerId ? value : null
    },
    list({ ownerId, sessionId, active } = {}) {
      return [...records.values()].filter(item => (
        item.ownerId === ownerId
        && (!sessionId || item.sessionId === sessionId)
        && (!active || ['queued', 'running', 'cancelling'].includes(item.status))
      ))
    },
    async cancel(id) {
      calls.cancelled.push(id)
      const value = records.get(id)
      Object.assign(value, {
        status: 'cancelled',
        workState: 'cancelled',
        completedAt: 4,
      })
      return value
    },
  }
  const runtime = new GatewayClientCommandRuntime({
    taskManager,
    backendRuntime: {
      run: async (...args) => {
        calls.backend.push(args)
        return { content: 'ok' }
      },
      cancel: async () => ({ status: 'cancelled' }),
    },
    conversationHistory: {
      messages: ({ ownerId, sessionId }) => [{ role: 'user', text: `${ownerId}:${sessionId}` }],
    },
    respondAuthorization: async () => ({ status: 'approved' }),
    respondInput: async (...args) => {
      calls.inputs.push(args)
      return { status: 'accepted' }
    },
    permissionPolicy: null,
    ...overrides,
  })
  return { runtime, records, calls }
}

test('executes correlated task and conversation runtime commands', async () => {
  const { runtime, calls } = harness()
  const created = await runtime.execute({
    type: GatewayClientProtocolEvent.TASK_CREATE,
    event_id: 'evt-create-1',
    message: {
      parts: [
        { type: 'text', text: '查询硬盘' },
        {
          type: 'file',
          mime: 'text/plain',
          url: 'data:text/plain;base64,YQ==',
          filename: 'a.txt',
        },
      ],
    },
  }, { ownerId: 'owner-1', sessionId: 'voice-1' })
  assert.equal(created.type, GatewayClientProtocolEvent.TASK_CREATE_RESULT)
  assert.equal(created.request_event_id, 'evt-create-1')
  assert.equal(created.task.objective, '查询硬盘')
  assert.equal(calls.created[0].submissionKey, 'evt-create-1')

  const listed = await runtime.execute({
    type: GatewayClientProtocolEvent.TASK_LIST,
    event_id: 'evt-list-1',
    active: true,
  }, { ownerId: 'owner-1', sessionId: 'voice-1' })
  assert.equal(listed.tasks.length, 2)

  const history = await runtime.execute({
    type: GatewayClientProtocolEvent.CONVERSATION_HISTORY,
    event_id: 'evt-history-1',
  }, { ownerId: 'owner-1', sessionId: 'voice-1' })
  assert.deepEqual(history.messages, [{ role: 'user', text: 'owner-1:voice-1' }])
})

test('cancels active tasks asynchronously and rejects terminal tasks', async () => {
  const { runtime, records, calls } = harness()
  const result = await runtime.execute({
    type: GatewayClientProtocolEvent.TASK_CANCEL,
    event_id: 'evt-cancel-1',
    task_id: 'task_1',
  }, { ownerId: 'owner-1' })
  assert.equal(result.request_event_id, 'evt-cancel-1')
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(calls.cancelled, ['task_1'])

  records.set('task_2', task({
    id: 'task_2',
    status: 'completed',
    workState: 'completed',
  }))
  await assert.rejects(
    runtime.cancelTask('task_2', { ownerId: 'owner-1' }),
    error => error instanceof RuntimeCommandError
      && error.code === 'task_not_cancellable',
  )
})

test('responds to a pending backend input on the same task', async () => {
  const { runtime, records, calls } = harness()
  records.set('task_1', task({
    workState: 'input_required',
    inputRequest: {
      id: 'input-1',
      status: 'pending',
      prompt: '选择语言',
    },
  }))
  const result = await runtime.execute({
    type: GatewayClientProtocolEvent.INPUT_RESPOND,
    event_id: 'evt-input-1',
    task_id: 'task_1',
    input_request_id: 'input-1',
    action: 'accept',
    text: '中文',
  }, { ownerId: 'owner-1' })
  assert.equal(result.type, GatewayClientProtocolEvent.INPUT_RESPOND_RESULT)
  assert.equal(result.input.status, 'accepted')
  assert.deepEqual(calls.inputs[0].slice(0, 3), [
    'task_1',
    'input-1',
    { action: 'accept', text: '中文', values: undefined },
  ])
})

test('applies the shared attachment safety policy to explicit Task commands', async () => {
  const { runtime } = harness()
  await assert.rejects(runtime.execute({
    type: GatewayClientProtocolEvent.TASK_CREATE,
    event_id: 'evt-create-local-file',
    message: {
      parts: [{
        type: 'file',
        mime: 'text/plain',
        filename: 'secret.txt',
        url: 'file:///etc/passwd',
      }],
    },
  }, { ownerId: 'owner-1', sessionId: 'voice-1' }), error => (
    error instanceof RuntimeCommandError
    && error.code === 'bad_event'
    && /不支持的附件 URL 协议/u.test(error.message)
  ))
})

test('rolls back session permission policy when the adapter rejects a response', async () => {
  const permissionTask = task({
    authorization: { id: 'permission-1' },
  })
  const taskManager = {
    create: () => permissionTask,
    get: () => permissionTask,
    list: () => [permissionTask],
    cancel: async () => permissionTask,
  }
  const changes = []
  const runtime = new GatewayClientCommandRuntime({
    taskManager,
    backendRuntime: { run: async () => ({}), cancel: async () => ({}) },
    conversationHistory: { messages: () => [] },
    respondAuthorization: async () => {
      throw new Error('adapter unavailable')
    },
    permissionPolicy: {
      mode: () => 'ask',
      applyDecision: (...args) => changes.push(['apply', ...args]),
      setMode: (...args) => changes.push(['restore', ...args]),
    },
  })
  await assert.rejects(runtime.execute({
    type: GatewayClientProtocolEvent.PERMISSION_RESPOND,
    event_id: 'evt-permission-1',
    permission_id: 'permission-1',
    decision: 'always',
  }, { ownerId: 'owner-1' }), /adapter unavailable/u)
  assert.deepEqual(changes.map(change => change[0]), ['apply', 'restore'])
})
