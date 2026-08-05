import assert from 'node:assert/strict'
import test from 'node:test'
import { TaskManager } from '../src/task/task-manager.mjs'
import { ToolCallHandler } from '../src/voice/tools/tool-call-handler.mjs'
import { FrontendNotesStore } from '../src/conversation/frontend-notes.mjs'
import { SessionPermissionPolicy } from '../src/voice/session-permission-policy.mjs'
import { TurnTranscripts } from '../src/voice/tools/turn-transcripts.mjs'

function harness({
  coordinator,
  manager = new TaskManager(),
  memoryStore = null,
  notesStore = null,
  onMemoryChanged = () => {},
  coordinatorAvailable = async () => true,
  respondPermission,
  permissionPolicy,
  clientContext = {},
  requestClientState,
} = {}) {
  const outputs = []
  const transcripts = new TurnTranscripts({ waitMs: 5 })
  const handler = new ToolCallHandler({
    taskManager: manager,
    ownerId: 'owner',
    sessionId: 'voice',
    transcripts,
    getFrontend: () => ({
      sendFunctionOutput: async (...args) => outputs.push(args),
    }),
    getTurnId: () => 'turn-one',
    getTurnGeneration: () => 1,
    coordinator: coordinator || {
      run: async () => ({ content: '完成', metadata: {} }),
    },
    coordinatorAvailable,
    memoryStore,
    notesStore,
    onMemoryChanged,
    respondPermission,
    permissionPolicy,
    getClientContext: () => clientContext,
    requestClientState,
    getConversationContext: () => [
      { role: 'user', content: '之前在改首页' },
    ],
  })
  return { outputs, manager, transcripts, handler }
}

test('asks a capable client to enter sleep without creating another response', async () => {
  const states = []
  const kit = harness({
    clientContext: { states: ['sleeping'] },
    requestClientState: state => states.push(state),
  })

  await kit.handler.handle({
    call_id: 'call-hide',
    name: 'enter_sleep',
    arguments: '{}',
  }, { turnId: 'turn-one', turnGeneration: 1 })

  assert.deepEqual(states, ['sleeping'])
  assert.equal(kit.outputs[0][1].status, 'sleeping')
  assert.equal(kit.outputs[0][3].createResponse, false)
})

test('rejects sleep when the client did not advertise that state', async () => {
  const kit = harness()

  await kit.handler.handle({
    call_id: 'call-hide-unsupported',
    name: 'enter_sleep',
    arguments: '{}',
  }, { turnId: 'turn-one', turnGeneration: 1 })

  assert.equal(kit.outputs[0][1].error_code, 'unsupported_client_state')
})

async function permissionHarness({
  answer,
  authorizationId = 'auth-one',
  respondPermission,
  permissionPolicy,
}) {
  const manager = new TaskManager()
  let release
  const task = manager.create({
    objective: '执行等待授权的操作',
    ownerId: 'owner',
    sessionId: 'voice',
    runner: async (_objective, { onEvent }) => {
      onEvent({
        type: 'backend.permission.requested',
        permission: {
          id: authorizationId,
          status: 'pending',
          category: 'read',
          summary: '查看项目目录',
        },
      })
      return new Promise(resolve => { release = resolve })
    },
  })
  await new Promise(resolve => setImmediate(resolve))
  const kit = harness({ manager, respondPermission, permissionPolicy })
  kit.transcripts.record('turn-one', answer)
  return {
    ...kit,
    task,
    finish: async () => {
      release({ content: '完成' })
      await manager.wait(task.id)
    },
  }
}

test('submits one nonblocking coordinator work item with organized intent', async () => {
  let received
  const kit = harness({
    coordinator: {
      run: async input => {
        received = input
        return { content: '完成', metadata: {} }
      },
    },
  })
  kit.transcripts.record('turn-one', '继续改刚才那个页面')
  await kit.handler.handle({
    call_id: 'call-one',
    name: 'spawn_thinking',
    arguments: JSON.stringify({ objective: '继续修改此前讨论的页面' }),
  }, { turnId: 'turn-one', turnGeneration: 1 })

  assert.equal(kit.outputs[0][1].status, 'accepted')
  assert.match(
    kit.outputs[0][3].response.instructions,
    /如果此前已经说明正在处理.*直接结束本次响应/,
  )
  assert.match(
    kit.outputs[0][3].response.instructions,
    /accepted 或 duplicate 只代表任务已经提交/,
  )
  assert.equal(kit.manager.list({ ownerId: 'owner' }).length, 1)
  await kit.manager.wait(kit.outputs[0][1].work_id)
  assert.equal(received.originalRequest, '继续改刚才那个页面')
  assert.equal(received.objective, '继续修改此前讨论的页面')
  assert.equal(received.conversationContext[0].content, '之前在改首页')
})

test('lets realtime avoid a repeated acknowledgement after speaking before delegation', async () => {
  const kit = harness()
  kit.transcripts.record('turn-one', '给项目添加特殊食物')
  await kit.handler.handle({
    call_id: 'call-spoken-before-tool',
    name: 'spawn_thinking',
    arguments: '{"objective":"给项目添加特殊食物"}',
  }, {
    turnId: 'turn-one',
    turnGeneration: 1,
    hasAudio: true,
  })

  assert.equal(kit.outputs[0][1].status, 'accepted')
  assert.equal(kit.outputs[0][3].createResponse, undefined)
  assert.match(
    kit.outputs[0][3].response.instructions,
    /不要重复、改写或补充确认/,
  )
  await kit.manager.wait(kit.outputs[0][1].work_id)
})

test('deduplicates repeated tool calls from one realtime turn', async () => {
  const kit = harness()
  kit.transcripts.record('turn-one', '执行一次')
  await kit.handler.handle({
    call_id: 'call-one',
    name: 'spawn_thinking',
    arguments: '{"objective":"执行一次"}',
  })
  await kit.handler.handle({
    call_id: 'call-two',
    name: 'spawn_thinking',
    arguments: '{"objective":"再执行一次"}',
  })
  assert.equal(kit.manager.list({ ownerId: 'owner' }).length, 1)
  assert.equal(kit.outputs.at(-1)[1].status, 'duplicate')
  assert.equal(kit.outputs.at(-1)[3].createResponse, undefined)
  assert.match(
    kit.outputs.at(-1)[3].response.instructions,
    /不要再次调用工具/,
  )
})

test('rejects delegated work immediately when the backend Agent is disconnected', async () => {
  const kit = harness({
    coordinatorAvailable: async () => false,
  })
  kit.transcripts.record('turn-one', '帮我修改项目')
  await kit.handler.handle({
    call_id: 'call-offline',
    name: 'spawn_thinking',
    arguments: '{"objective":"修改项目"}',
  })

  assert.equal(kit.outputs[0][1].error_code, 'backend_unavailable')
  assert.equal(kit.outputs[0][1].retryable, true)
  assert.match(kit.outputs[0][1].user_message, /当前未连接/)
  assert.equal(kit.manager.list({ ownerId: 'owner' }).length, 0)
})

test('explains that background work is unavailable without a configured backend', async () => {
  const kit = harness({
    coordinatorAvailable: async () => ({ enabled: false, ok: false }),
  })
  kit.transcripts.record('turn-one', '帮我修改项目')
  await kit.handler.handle({
    call_id: 'call-unconfigured',
    name: 'spawn_thinking',
    arguments: '{"objective":"修改项目"}',
  })

  assert.equal(kit.outputs[0][1].error_code, 'backend_unavailable')
  assert.equal(kit.outputs[0][1].retryable, false)
  assert.match(kit.outputs[0][1].user_message, /未配置后台 Agent/)
  assert.match(
    kit.outputs[0][3].response.instructions,
    /未配置后台 Agent/,
  )
  assert.equal(kit.manager.list({ ownerId: 'owner' }).length, 0)
})

test('does not turn a permission answer into a new background task', async () => {
  const kit = await permissionHarness({
    answer: '可以',
    respondPermission: async () => ({
      id: 'auth-one',
      workId: 'work-one',
      status: 'approved',
    }),
  })

  await kit.handler.handle({
    call_id: 'wrongly-delegated-permission-answer',
    name: 'spawn_thinking',
    arguments: JSON.stringify({ objective: '可以' }),
  }, { turnId: 'turn-one', turnGeneration: 1 })

  const output = kit.outputs.at(-1)
  assert.equal(output[1].error_code, 'permission_decision_required')
  assert.equal(output[1].authorization_id, 'auth-one')
  assert.match(
    output[3].response.instructions,
    /respond_agent_permission/,
  )
  assert.equal(
    kit.manager.list({ ownerId: 'owner' }).filter(task => (
      task.objective === '可以'
    )).length,
    0,
  )
  await kit.finish()
})

test('deduplicates the same turn after a realtime handler reconnect', async () => {
  const manager = new TaskManager()
  let runs = 0
  const coordinator = {
    run: async () => {
      runs += 1
      return { content: '完成', metadata: {} }
    },
  }
  const first = harness({ coordinator, manager })
  first.transcripts.record('turn-one', '执行一次')
  await first.handler.handle({
    call_id: 'call-before-reconnect',
    name: 'spawn_thinking',
    arguments: '{"objective":"执行一次"}',
  })

  const second = harness({ coordinator, manager })
  second.transcripts.record('turn-one', '执行一次')
  await second.handler.handle({
    call_id: 'call-after-reconnect',
    name: 'spawn_thinking',
    arguments: '{"objective":"执行一次"}',
  })
  await manager.wait(first.outputs[0][1].work_id)
  assert.equal(manager.list({ ownerId: 'owner' }).length, 1)
  assert.equal(second.outputs[0][1].status, 'duplicate')
  assert.equal(runs, 1)
})

test('cancels the most recently submitted active work', async () => {
  const kit = harness()
  let release
  kit.handler.coordinator = {
    run: async (_input, { signal }) => new Promise((resolve, reject) => {
      release = resolve
      signal.addEventListener('abort', () => reject(signal.reason), {
        once: true,
      })
    }),
  }
  kit.transcripts.record('turn-one', '执行一次')
  await kit.handler.handle({
    call_id: 'call-one',
    name: 'spawn_thinking',
    arguments: '{"objective":"执行一次"}',
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(kit.manager.list({ active: true }).length, 1)
  await kit.handler.handle({
    call_id: 'call-two',
    name: 'cancel_agent_task',
    arguments: '{}',
  })
  assert.equal(kit.outputs.at(-1)[1].status, 'cancelled')
  assert.equal(kit.manager.list({ active: true }).length, 0)
  assert.equal(kit.manager.list()[0].status, 'cancelled')
  release?.()
})

test('queries the latest work directly from the realtime task ledger', async () => {
  const kit = harness()
  kit.transcripts.record('turn-one', '执行一次')
  await kit.handler.handle({
    call_id: 'call-submit',
    name: 'spawn_thinking',
    arguments: '{"objective":"执行一次"}',
  })
  const workId = kit.outputs.at(-1)[1].work_id
  await kit.manager.wait(workId)

  await kit.handler.handle({
    call_id: 'call-status',
    name: 'get_agent_task_status',
    arguments: '{}',
  })

  assert.equal(kit.outputs.at(-1)[1].status, 'ok')
  assert.equal(kit.outputs.at(-1)[1].work_id, workId)
  assert.equal(kit.outputs.at(-1)[1].work_status, 'completed')
  assert.equal(kit.outputs.at(-1)[1].result, '完成')
  assert.deepEqual(kit.outputs.at(-1)[2], {
    turnId: 'turn-one',
    taskId: workId,
    consumesTaskNotification: true,
  })
  assert.deepEqual(kit.outputs.at(-1)[3], {})
})

test('queues a hidden high-priority coordinator query for delegated work', async () => {
  const manager = new TaskManager()
  let releaseDelegation
  const delegated = manager.create({
    objective: '继续 Megatron-LM 项目',
    ownerId: 'owner',
    sessionId: 'voice',
    laneKey: 'coordinator:owner',
    runner: async (_objective, { onEvent, signal }) => {
      onEvent({
        type: 'backend.delegated',
        delegation: {
          id: 'delegation-one',
          sessionId: 'session-target',
          title: 'Megatron-LM',
          directory: '/project',
        },
      })
      return new Promise((resolve, reject) => {
        releaseDelegation = resolve
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        })
      })
    },
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(manager.get(delegated.id).status, 'delegated')

  let queried
  const kit = harness({
    manager,
    coordinator: {
      queryDelegatedWork: async (workId, question, options) => {
        queried = { workId, question, ownerId: options.ownerId }
        return { content: '正在检查模型目录。', metadata: {} }
      },
    },
  })
  kit.transcripts.record('turn-one', 'Megatron 那个已经查到了什么？')
  await kit.handler.handle({
    call_id: 'call-delegated-status',
    name: 'get_agent_task_status',
    arguments: JSON.stringify({ work_id: delegated.id }),
  })

  const output = kit.outputs.at(-1)[1]
  assert.equal(output.status, 'querying')
  assert.equal(output.work_id, delegated.id)
  assert.ok(output.query_work_id)
  const visible = manager.list({ ownerId: 'owner' })
  assert.equal(visible.some(task => task.id === output.query_work_id), false)
  const queryTask = await manager.wait(output.query_work_id)
  assert.equal(queryTask.status, 'completed')
  assert.equal(queryTask.result, '正在检查模型目录。')
  assert.deepEqual(queried, {
    workId: delegated.id,
    question: 'Megatron 那个已经查到了什么？',
    ownerId: 'owner',
  })

  releaseDelegation({ content: '最终完成' })
  await manager.wait(delegated.id)
})

test('relays a realtime semantic permission decision without evidence matching', async () => {
  const calls = []
  const answer = '你按刚才说的处理就成'
  const permissionPolicy = new SessionPermissionPolicy()
  const kit = await permissionHarness({
    answer,
    permissionPolicy,
    respondPermission: async (id, decision, options) => {
      calls.push({ id, decision, options })
      return {
        id,
        workId: 'work-one',
        status: 'approved',
      }
    },
  })
  await kit.handler.handle({
    call_id: 'permission-semantic-allow',
    name: 'respond_agent_permission',
    arguments: JSON.stringify({
      authorization_id: 'auth-one',
      decision: 'always',
    }),
  })

  assert.deepEqual(calls, [{
    id: 'auth-one',
    decision: 'always',
    options: { ownerId: 'owner' },
  }])
  assert.equal(kit.outputs.at(-1)[1].status, 'approved')
  assert.match(
    kit.outputs.at(-1)[3].response.instructions,
    /已允许，后台继续执行/,
  )
  assert.equal(permissionPolicy.shouldAutoAllow('owner', 'voice'), true)
  await kit.finish()
})

test('confirms a rejected realtime permission exactly once', async () => {
  const answer = '不允许'
  const permissionPolicy = new SessionPermissionPolicy()
  permissionPolicy.applyDecision('owner', 'voice', 'always')
  const kit = await permissionHarness({
    answer,
    permissionPolicy,
    respondPermission: async id => ({
      id,
      workId: 'work-one',
      status: 'rejected',
    }),
  })
  await kit.handler.handle({
    call_id: 'permission-semantic-reject',
    name: 'respond_agent_permission',
    arguments: JSON.stringify({
      authorization_id: 'auth-one',
      decision: 'reject',
    }),
  })

  assert.equal(kit.outputs.at(-1)[1].status, 'rejected')
  assert.match(
    kit.outputs.at(-1)[3].response.instructions,
    /已拒绝/,
  )
  assert.equal(permissionPolicy.mode('owner', 'voice'), 'ask')
  await kit.finish()
})

test('auto-allows later permissions in the Gateway without publishing them', async () => {
  const permissionPolicy = new SessionPermissionPolicy()
  permissionPolicy.applyDecision('owner', 'voice', 'always')
  const approvals = []
  const kit = harness({
    permissionPolicy,
    respondPermission: async (id, decision, options) => {
      approvals.push({ id, decision, options })
      return { id, status: 'approved' }
    },
    coordinator: {
      run: async (_input, { onEvent }) => {
        onEvent({
          type: 'backend.permission.requested',
          permission: {
            id: 'auth-auto',
            status: 'pending',
            summary: 'List directory',
          },
        })
        return { content: '完成', metadata: {} }
      },
    },
  })
  const events = []
  kit.manager.subscribe(event => events.push(event))
  kit.transcripts.record('turn-one', '检查项目')

  await kit.handler.handle({
    call_id: 'auto-permission-work',
    name: 'spawn_thinking',
    arguments: '{"objective":"检查项目"}',
  })
  await kit.manager.wait(kit.outputs[0][1].work_id)

  assert.deepEqual(approvals, [{
    id: 'auth-auto',
    decision: 'always',
    options: { ownerId: 'owner' },
  }])
  assert.equal(
    events.some(event => event.type === 'task.permission.requested'),
    false,
  )
})

test('accepts a semantic permission decision without an evidence field', async () => {
  const calls = []
  const kit = await permissionHarness({
    answer: '你按刚才说的做吧',
    respondPermission: async (id, decision) => {
      calls.push({ id, decision })
      return { id, workId: 'work-one', status: 'approved' }
    },
  })
  await kit.handler.handle({
    call_id: 'permission-without-evidence',
    name: 'respond_agent_permission',
    arguments: JSON.stringify({
      authorization_id: 'auth-one',
      decision: 'always',
    }),
  })

  assert.deepEqual(calls, [{ id: 'auth-one', decision: 'always' }])
  assert.equal(kit.outputs.at(-1)[1].status, 'approved')
  await kit.finish()
})

test('rejects a permission id that is not pending on the current task', async () => {
  let called = false
  const answer = '照你说的来'
  const kit = await permissionHarness({
    answer,
    respondPermission: async () => {
      called = true
    },
  })
  await kit.handler.handle({
    call_id: 'permission-wrong-id',
    name: 'respond_agent_permission',
    arguments: JSON.stringify({
      authorization_id: 'auth-other',
      decision: 'always',
    }),
  })

  assert.equal(called, false)
  assert.equal(kit.outputs.at(-1)[1].error_code, 'permission_not_pending')
  await kit.finish()
})

test('uses one scoped memory tool for recall and remember', async () => {
  const calls = []
  let changes = 0
  const memoryStore = {
    list: (ownerId, options) => {
      calls.push(['list', ownerId, options])
      return [{
        id: 'profile_one',
        scope: 'profile',
        content: '用户希望被称为老大',
        editable: true,
      }]
    },
    remember: (ownerId, input) => {
      calls.push(['remember', ownerId, input])
      return { id: 'mem_one', ...input, editable: true }
    },
  }
  const kit = harness({
    memoryStore,
    onMemoryChanged: () => { changes += 1 },
  })

  await kit.handler.handle({
    call_id: 'memory-recall',
    name: 'user_memory',
    arguments: '{"action":"recall","scope":"all","query":"称呼"}',
  })
  assert.equal(kit.outputs.at(-1)[1].status, 'ok')
  assert.deepEqual(calls[0], ['list', 'owner', {
    scope: 'all',
    query: '称呼',
  }])

  await kit.handler.handle({
    call_id: 'memory-remember',
    name: 'user_memory',
    arguments: JSON.stringify({
      action: 'remember',
      scope: 'long_term',
      content: '用户喜欢苹果',
    }),
  })
  assert.equal(kit.outputs.at(-1)[1].status, 'remembered')
  assert.deepEqual(calls[1], ['remember', 'owner', {
    scope: 'long_term',
    content: '用户喜欢苹果',
  }])
  assert.equal(changes, 1)
})

test('routes standing user rules to the rules memory scope', async () => {
  const calls = []
  let changes = 0
  const kit = harness({
    memoryStore: {
      remember: (ownerId, input) => {
        calls.push(['remember', ownerId, input])
        return {
          id: 'mem_rule',
          scope: 'rules',
          content: input.content,
          editable: true,
        }
      },
    },
    onMemoryChanged: () => { changes += 1 },
  })

  await kit.handler.handle({
    call_id: 'memory-rule',
    name: 'user_memory',
    arguments: JSON.stringify({
      action: 'remember',
      scope: 'rules',
      content: '回复默认先给结论',
    }),
  })

  assert.deepEqual(calls[0], ['remember', 'owner', {
    scope: 'rules',
    content: '回复默认先给结论',
  }])
  assert.equal(kit.outputs.at(-1)[1].status, 'remembered')
  assert.equal(kit.outputs.at(-1)[1].memory.scope, 'rules')
  assert.equal(changes, 1)
})

test('replaces recalled text memories in one storage operation', async () => {
  let replaced
  let changes = 0
  const kit = harness({
    memoryStore: {
      replace: (ownerId, input) => {
        replaced = { ownerId, ...input }
        return {
          replaced: 2,
          memory: {
            id: 'mem_banana',
            scope: 'long_term',
            content: input.content,
            editable: true,
          },
        }
      },
    },
    onMemoryChanged: () => { changes += 1 },
  })

  await kit.handler.handle({
    call_id: 'memory-replace',
    name: 'user_memory',
    arguments: JSON.stringify({
      action: 'replace',
      scope: 'long_term',
      memory_ids: ['mem_apple', 'mem_likes_apple'],
      content: '用户最喜欢的水果是香蕉',
    }),
  })

  assert.deepEqual(replaced, {
    ownerId: 'owner',
    scope: 'long_term',
    ids: ['mem_apple', 'mem_likes_apple'],
    content: '用户最喜欢的水果是香蕉',
  })
  assert.equal(kit.outputs.at(-1)[1].status, 'replaced')
  assert.equal(kit.outputs.at(-1)[1].replaced, 2)
  assert.equal(changes, 1)
})

test('requires recalled ids for replacement and never guesses targets', async () => {
  const kit = harness({
    memoryStore: {
      replace: () => {
        throw new Error('must not run')
      },
    },
  })
  await kit.handler.handle({
    call_id: 'memory-replace-without-id',
    name: 'user_memory',
    arguments: JSON.stringify({
      action: 'replace',
      scope: 'long_term',
      content: '用户最喜欢的水果是香蕉',
    }),
  })
  assert.equal(kit.outputs.at(-1)[1].error_code, 'missing_memory_ids')
})

test('forgets selected memory without re-parsing user wording', async () => {
  const kit = harness({
    memoryStore: {
      forget: (_ownerId, options) => {
        assert.deepEqual(options, {
          scope: 'profile',
          query: '称呼',
          all: false,
        })
        return 1
      },
    },
  })
  await kit.handler.handle({
    call_id: 'memory-forget',
    name: 'user_memory',
    arguments: '{"action":"forget","scope":"profile","query":"称呼"}',
  })
  assert.equal(kit.outputs.at(-1)[1].status, 'forgotten')
})

test('clears an entire memory scope through the explicit all parameter', async () => {
  let calls = 0
  const memoryStore = {
    forget: () => {
      calls += 1
      return 2
    },
  }
  const allowed = harness({ memoryStore })
  await allowed.handler.handle({
    call_id: 'memory-clear',
    name: 'user_memory',
    arguments: '{"action":"forget","scope":"long_term","all":true}',
  })
  assert.equal(allowed.outputs.at(-1)[1].status, 'forgotten')
  assert.equal(calls, 1)
})

test('rejects secrets and an ambiguous memory scope', async () => {
  const kit = harness({
    memoryStore: {
      remember: () => {
        throw new Error('must not write')
      },
    },
  })
  await kit.handler.handle({
    call_id: 'memory-secret',
    name: 'user_memory',
    arguments: JSON.stringify({
      action: 'remember',
      scope: 'long_term',
      content: '我的 API Key 是 sk-secret',
    }),
  })
  assert.equal(kit.outputs.at(-1)[1].error_code, 'sensitive_memory')

  await kit.handler.handle({
    call_id: 'memory-all',
    name: 'user_memory',
    arguments: JSON.stringify({
      action: 'remember',
      scope: 'all',
      content: '用户喜欢苹果',
    }),
  })
  assert.equal(kit.outputs.at(-1)[1].error_code, 'missing_memory')
})

test('notes: adds items to a named list and reports ambiguous removals', async () => {
  const notesStore = new FrontendNotesStore()
  const kit = harness({ notesStore })

  await kit.handler.handle({
    call_id: 'notes-add',
    name: 'notes',
    arguments: JSON.stringify({
      action: 'add',
      list: '购物清单',
      items: ['牛奶', '面包'],
    }),
  })
  const added = kit.outputs.at(-1)[1]
  assert.equal(added.status, 'ok')
  assert.deepEqual(added.added, ['牛奶', '面包'])

  await kit.handler.handle({
    call_id: 'notes-remove-fuzzy',
    name: 'notes',
    arguments: JSON.stringify({
      action: 'remove',
      list: '购物清单',
      items: ['面包'],
    }),
  })
  assert.deepEqual(kit.outputs.at(-1)[1].removed, ['面包'])

  await kit.handler.handle({
    call_id: 'notes-show',
    name: 'notes',
    arguments: JSON.stringify({ action: 'show', list: '购物清单' }),
  })
  assert.deepEqual(
    kit.outputs.at(-1)[1].items.map(item => item.text),
    ['牛奶'],
  )
})

test('notes: clears and drops a named list without re-parsing user wording', async () => {
  const notesStore = new FrontendNotesStore()
  const kit = harness({ notesStore })
  await kit.handler.handle({
    call_id: 'notes-seed',
    name: 'notes',
    arguments: JSON.stringify({ action: 'add', list: '购物清单', items: ['牛奶'] }),
  })

  await kit.handler.handle({
    call_id: 'notes-clear-ok',
    name: 'notes',
    arguments: JSON.stringify({ action: 'clear', list: '购物清单' }),
  })
  assert.equal(kit.outputs.at(-1)[1].status, 'ok')
  assert.equal(kit.outputs.at(-1)[1].removed, 1)
  assert.equal(notesStore.show('owner', '购物清单').items.length, 0)

  await kit.handler.handle({
    call_id: 'notes-drop-ok',
    name: 'notes',
    arguments: JSON.stringify({ action: 'drop', list: '购物清单' }),
  })
  assert.equal(kit.outputs.at(-1)[1].status, 'ok')
  assert.deepEqual(notesStore.lists('owner'), [])
})

test('notes: rejects secrets and missing arguments', async () => {
  const notesStore = new FrontendNotesStore()
  const kit = harness({ notesStore })

  await kit.handler.handle({
    call_id: 'notes-secret',
    name: 'notes',
    arguments: JSON.stringify({ action: 'add', list: '购物清单', items: ['我的密码是 12345'] }),
  })
  assert.equal(kit.outputs.at(-1)[1].error_code, 'sensitive_notes')

  await kit.handler.handle({
    call_id: 'notes-no-list',
    name: 'notes',
    arguments: JSON.stringify({ action: 'show' }),
  })
  assert.equal(kit.outputs.at(-1)[1].error_code, 'missing_notes_target')

  await kit.handler.handle({
    call_id: 'notes-no-items',
    name: 'notes',
    arguments: JSON.stringify({ action: 'add', list: '购物清单' }),
  })
  assert.equal(kit.outputs.at(-1)[1].error_code, 'missing_notes_items')
})

test('notes: unavailable without a notes store', async () => {
  const kit = harness({})
  await kit.handler.handle({
    call_id: 'notes-unavailable',
    name: 'notes',
    arguments: JSON.stringify({ action: 'lists' }),
  })
  assert.equal(kit.outputs.at(-1)[1].error_code, 'notes_unavailable')
})
