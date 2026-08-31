import assert from 'node:assert/strict'
import test from 'node:test'
import { TaskManager } from '../src/task/task-manager.mjs'
import { ToolCallHandler } from '../src/voice/tools/tool-call-handler.mjs'
import { FrontendNotesStore } from '../src/conversation/frontend-notes.mjs'
import { SessionPermissionPolicy } from '../src/voice/session-permission-policy.mjs'
import { TurnTranscripts } from '../src/voice/tools/turn-transcripts.mjs'
import { permissionReference } from '../src/voice/tools/permission-reference.mjs'

function harness({
  coordinator,
  manager = new TaskManager(),
  memoryStore = null,
  notesStore = null,
  onMemoryChanged = () => {},
  backendAvailability = null,
  respondPermission,
  respondInput,
  permissionPolicy,
  onPermissionDeliveryFailed,
  clientContext = {},
  presenceController,
  inputAssets,
  onAgentActivity,
  frontendRetrieval,
  frontendKnowledge,
  frontendToolSources,
  getTurnId = () => 'turn-one',
} = {}) {
  const outputs = []
  const ensuredResponses = []
  const transcripts = new TurnTranscripts({ waitMs: 5 })
  const frontend = {
    sendFunctionOutput: async (...args) => outputs.push(args),
    ensureResponse: async (...args) => ensuredResponses.push(args),
  }
  const handler = new ToolCallHandler({
    taskManager: manager,
    ownerId: 'owner',
    sessionId: 'voice',
    transcripts,
    getFrontend: () => frontend,
    getTurnId,
    getTurnGeneration: () => 1,
    backendRuntime: coordinator || {
      run: async () => ({ content: '完成', metadata: {} }),
      cancel: async taskId => ({ taskId, state: 'cancelled' }),
    },
    backendAvailability,
    memoryService: memoryStore,
    notesStore,
    onMemoryChanged,
    respondAuthorization: respondPermission
      ? (_taskId, id, decision, options) => (
          respondPermission(id, decision, options)
        )
      : undefined,
    respondInput,
    permissionPolicy,
    onPermissionDeliveryFailed,
    getClientContext: () => clientContext,
    presenceController,
    onAgentActivity,
    inputAssets,
    frontendRetrieval,
    frontendKnowledge,
    frontendToolSources,
  })
  return { outputs, ensuredResponses, manager, transcripts, handler }
}

test('executes discovered external tools through the shared boundary', async () => {
  const calls = []
  const source = {
    tools: () => [{
      name: 'mcp__documents__search',
      definition: {
        type: 'function',
        function: {
          name: 'mcp__documents__search',
          parameters: { type: 'object', properties: {} },
        },
      },
      policy: {
        mode: 'inline',
        maxCallsPerTurn: 1,
        maxResultBytes: 2_048,
      },
    }],
    execute: async (name, args) => {
      calls.push([name, args])
      return { status: 'ok', text: 'Found.' }
    },
  }
  const kit = harness({ frontendToolSources: [source] })
  const invoke = (callId, args) => kit.handler.handle({
    call_id: callId,
    name: 'mcp__documents__search',
    arguments: JSON.stringify(args),
  }, { turnId: 'turn-one', turnGeneration: 1 })

  await invoke('external-one', { query: 'architecture' })
  await invoke('external-two', { query: 'different' })

  assert.deepEqual(calls, [[
    'mcp__documents__search',
    { query: 'architecture' },
  ]])
  assert.equal(kit.outputs[0][1].text, 'Found.')
  assert.equal(kit.outputs[1][1].error_code, 'tool_loop_limit')
})

test('executes an explicitly enabled state-changing external tool inline', async () => {
  const calls = []
  const source = {
    tools: () => [{
      name: 'mcp__cockpit__vehicle_window_control',
      definition: {
        type: 'function',
        function: {
          name: 'mcp__cockpit__vehicle_window_control',
          parameters: { type: 'object', properties: {} },
        },
      },
      policy: {
        mode: 'inline',
        maxCallsPerTurn: 1,
        maxResultBytes: 2_048,
      },
    }],
    execute: async (name, args) => {
      calls.push([name, args])
      return { status: 'ok', text: '已打开主驾车窗' }
    },
  }
  const kit = harness({ frontendToolSources: [source] })

  await kit.handler.handle({
    call_id: 'window-control',
    name: 'mcp__cockpit__vehicle_window_control',
    arguments: JSON.stringify({ action: 'open', window: 'windowFL' }),
  }, { turnId: 'turn-one', turnGeneration: 1 })

  assert.deepEqual(calls, [[
    'mcp__cockpit__vehicle_window_control',
    { action: 'open', window: 'windowFL' },
  ]])
  assert.equal(kit.outputs[0][1].text, '已打开主驾车窗')
  assert.equal(kit.outputs[0][1].status, 'ok')
})

function taskForId(manager, taskId) {
  return manager.getByTaskId(taskId, { ownerId: 'owner' })
}

function waitForTask(manager, taskId) {
  return manager.wait(taskForId(manager, taskId).id)
}

test('asks a capable client to enter sleep without creating another response', async () => {
  const sources = []
  const kit = harness({
    presenceController: {
      supportsSleep: () => true,
      requestSleep: async ({ source }) => sources.push(source),
    },
  })

  await kit.handler.handle({
    call_id: 'call-hide',
    name: 'enter_sleep',
    arguments: '{}',
  }, { turnId: 'turn-one', turnGeneration: 1 })

  assert.deepEqual(sources, ['realtime_tool'])
  assert.equal(kit.outputs[0][1].status, 'sleeping')
  assert.equal(kit.outputs[0][3].createResponse, false)
})

test('creates a response only when the client fails to enter sleep', async () => {
  const error = Object.assign(new Error('window could not be hidden'), {
    code: 'desktop_hide_failed',
  })
  const kit = harness({
    presenceController: {
      supportsSleep: () => true,
      requestSleep: async () => { throw error },
    },
  })

  await kit.handler.handle({
    call_id: 'call-hide-failed',
    name: 'enter_sleep',
    arguments: '{}',
  }, { turnId: 'turn-one', turnGeneration: 1 })

  assert.equal(kit.outputs[0][1].error_code, 'desktop_hide_failed')
  assert.equal(kit.outputs[0][3].createResponse, true)
})

test('executes only retrieval tools advertised by the injected frontend runtime', async () => {
  const calls = []
  const kit = harness({
    frontendRetrieval: {
      capabilities: () => ['web-search', 'url-fetch'],
      search: async (query, options) => {
        calls.push(['search', query, options.limit])
        return { status: 'ok', query, results: [], citations: [] }
      },
      fetchUrl: async url => {
        calls.push(['fetch', url])
        return { status: 'ok', url, content: 'page', citations: [] }
      },
    },
  })

  await kit.handler.handle({
    call_id: 'call-search',
    name: 'web_search',
    arguments: JSON.stringify({ query: 'current facts', limit: 3 }),
  }, { turnId: 'turn-one', turnGeneration: 1 })
  await kit.handler.handle({
    call_id: 'call-fetch',
    name: 'fetch_url',
    arguments: JSON.stringify({ url: 'https://example.com/' }),
  }, { turnId: 'turn-one', turnGeneration: 1 })

  assert.deepEqual(calls, [
    ['search', 'current facts', 3],
    ['fetch', 'https://example.com/'],
  ])
  assert.equal(kit.outputs[0][1].status, 'ok')
  assert.equal(kit.outputs[1][1].content, 'page')
})

test('fails closed when a stale model calls an unavailable retrieval tool', async () => {
  const kit = harness()
  await kit.handler.handle({
    call_id: 'call-search-disabled',
    name: 'web_search',
    arguments: JSON.stringify({ query: 'current facts' }),
  }, { turnId: 'turn-one', turnGeneration: 1 })

  assert.equal(kit.outputs[0][1].error_code, 'tool_unavailable')
  assert.equal(kit.outputs[0][3].createResponse, true)
})

test('executes capability-gated knowledge retrieval with trusted context', async () => {
  const calls = []
  const kit = harness({
    frontendKnowledge: {
      capabilities: () => ['knowledge'],
      search: async (query, options) => {
        calls.push([query, options])
        return { status: 'ok', query, results: [] }
      },
    },
  })
  await kit.handler.handle({
    call_id: 'knowledge-search',
    name: 'knowledge',
    arguments: JSON.stringify({
      query: 'fact',
      knowledge_base_ids: ['kb_one'],
      top_k: 3,
    }),
  }, { turnId: 'turn-one', turnGeneration: 1 })

  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], 'fact')
  assert.equal(calls[0][1].ownerId, 'owner')
  assert.equal(calls[0][1].turnId, 'turn-one')
  assert.equal(calls[0][1].traceId, 'knowledge-search')
  assert.deepEqual(calls[0][1].knowledgeBaseIds, ['kb_one'])
  assert.equal(calls[0][1].topK, 3)
  assert.equal(kit.outputs[0][1].status, 'ok')
})

test('fails closed when a stale model calls the unavailable knowledge tool', async () => {
  const kit = harness()
  await kit.handler.handle({
    call_id: 'call-knowledge-disabled',
    name: 'knowledge',
    arguments: JSON.stringify({ query: 'fact' }),
  }, { turnId: 'turn-one', turnGeneration: 1 })

  assert.equal(kit.outputs[0][1].error_code, 'tool_unavailable')
})

test('rejects sleep when the client does not advertise the action', async () => {
  const kit = harness()

  await kit.handler.handle({
    call_id: 'call-hide-unsupported',
    name: 'enter_sleep',
    arguments: '{}',
  }, { turnId: 'turn-one', turnGeneration: 1 })

  assert.equal(kit.outputs[0][1].error_code, 'client_action_unsupported')
  assert.equal(kit.outputs[0][3].createResponse, true)
})

test('fails closed for tools absent from the frontend registry', async () => {
  const kit = harness()

  await kit.handler.handle({
    call_id: 'call-unknown',
    name: 'unknown_tool',
    arguments: '{}',
  }, { turnId: 'turn-one', turnGeneration: 1 })

  assert.equal(kit.outputs[0][1].error_code, 'unsupported_tool')
  assert.equal(kit.manager.list({ ownerId: 'owner' }).length, 0)
})

test('blocks an exact repeated inline tool call within one turn', async () => {
  const kit = harness()
  const context = { turnId: 'turn-one', turnGeneration: 1 }

  await kit.handler.handle({
    call_id: 'call-time-one',
    name: 'get_current_time',
    arguments: '{}',
  }, context)
  await kit.handler.handle({
    call_id: 'call-time-two',
    name: 'get_current_time',
    arguments: '{}',
  }, context)

  assert.equal(kit.outputs[0][1].status, 'ok')
  assert.equal(kit.outputs[1][1].status, 'duplicate')
  assert.equal(kit.outputs[1][3].createResponse, false)
})

async function permissionHarness({
  answer,
  authorizationId = 'auth-one',
  respondPermission,
  permissionPolicy,
  onPermissionDeliveryFailed,
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
  const kit = harness({
    manager,
    respondPermission,
    permissionPolicy,
    onPermissionDeliveryFailed,
  })
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
  let receivedOptions
  const kit = harness({
    coordinator: {
      run: async (input, options) => {
        received = input
        receivedOptions = options
        return { content: '完成', metadata: {} }
      },
    },
  })
  kit.transcripts.record('turn-one', '继续改刚才那个页面')
  const execution = await kit.handler.handle({
    call_id: 'call-one',
    name: 'spawn_thinking',
    arguments: JSON.stringify({ objective: '继续修改此前讨论的页面' }),
  }, { turnId: 'turn-one', turnGeneration: 1 })

  assert.equal(execution.tool.policy.mode, 'background')
  assert.equal(kit.outputs[0][1].status, 'accepted')
  assert.equal(
    kit.outputs[0][1].message,
    '工作已受理，请自然确认一次，不要再次调用工具。',
  )
  assert.equal(kit.outputs[0][1].marker, undefined)
  assert.deepEqual(kit.outputs[0][3], {})
  assert.equal(kit.manager.list({ ownerId: 'owner' }).length, 1)
  await waitForTask(kit.manager, kit.outputs[0][1].task_id)
  assert.equal('originalRequest' in received, false)
  assert.equal(received.objective, '继续修改此前讨论的页面')
  assert.equal('conversationContext' in received, false)
  assert.equal('userMemories' in received, false)
  assert.equal(receivedOptions.taskId, kit.outputs[0][1].task_id)
  assert.equal(
    receivedOptions.taskId,
    taskForId(kit.manager, kit.outputs[0][1].task_id).id,
  )
})

test('automatically carries current-turn attachments into spawned work', async () => {
  let received
  const kit = harness({
    coordinator: {
      run: async input => {
        received = input
        return { content: '完成', metadata: {} }
      },
    },
  })
  const image = {
    type: 'file',
    mime: 'image/png',
    filename: 'reference.png',
    url: 'data:image/png;base64,aGVsbG8=',
  }
  kit.transcripts.record('turn-one', '根据这张图生成皮肤')
  kit.transcripts.recordParts('turn-one', [image])
  await kit.handler.handle({
    call_id: 'call-image',
    name: 'spawn_thinking',
    arguments: '{"objective":"根据参考图生成皮肤"}',
  }, { turnId: 'turn-one', turnGeneration: 1 })

  await waitForTask(kit.manager, kit.outputs[0][1].task_id)
  assert.deepEqual(received.inputParts, [image])
})

test('resolves an earlier-turn input reference when the next turn delegates work', async () => {
  let received
  const historicalImage = {
    type: 'file',
    mime: 'image/png',
    filename: 'cat.png',
    url: 'data:image/png;base64,aGVsbG8=',
  }
  const kit = harness({
    inputAssets: {
      resolve: ({ ownerId, sessionId, refs }) => {
        assert.equal(ownerId, 'owner')
        assert.equal(sessionId, 'voice')
        assert.deepEqual(refs, ['input_1'])
        return [historicalImage]
      },
    },
    coordinator: {
      run: async input => {
        received = input
        return { content: '完成', metadata: {} }
      },
    },
  })
  kit.transcripts.record('turn-one', '分析刚才那张图片')

  await kit.handler.handle({
    call_id: 'call-historical-image',
    name: 'spawn_thinking',
    arguments: JSON.stringify({
      objective: '分析用户此前提供的图片',
      input_refs: ['input_1'],
    }),
  }, { turnId: 'turn-one', turnGeneration: 1 })

  await waitForTask(kit.manager, kit.outputs[0][1].task_id)
  assert.deepEqual(received.inputParts, [historicalImage])
})

test('asks for the attachment again when a referenced input has expired', async () => {
  const kit = harness({
    inputAssets: {
      resolve: () => { throw new Error('引用的输入已经失效') },
    },
  })
  kit.transcripts.record('turn-one', '分析刚才那张图片')

  await kit.handler.handle({
    call_id: 'call-expired-image',
    name: 'spawn_thinking',
    arguments: JSON.stringify({
      objective: '分析用户此前提供的图片',
      input_refs: ['input_1'],
    }),
  }, { turnId: 'turn-one', turnGeneration: 1 })

  assert.equal(kit.outputs[0][1].error_code, 'invalid_input_ref')
  assert.equal(kit.outputs[0][1].retryable, true)
  assert.equal(kit.manager.list({ ownerId: 'owner' }).length, 0)
})

test('suppresses the receipt reply when the original response already spoke', async () => {
  const kit = harness()
  kit.transcripts.record('turn-one', '给项目添加特殊食物')
  await kit.handler.handle({
    call_id: 'call-spoken-before-tool',
    response_id: 'response-spoken-before-tool',
    name: 'spawn_thinking',
    arguments: '{"objective":"给项目添加特殊食物"}',
  }, {
    turnId: 'turn-one',
    turnGeneration: 1,
    responseId: 'response-spoken-before-tool',
  })
  await kit.handler.finishToolResponse('response-spoken-before-tool', {
    suppressResponse: true,
  })

  assert.equal(kit.outputs[0][1].status, 'accepted')
  assert.equal(
    kit.outputs[0][1].message,
    '工作已受理，请自然确认一次，不要再次调用工具。',
  )
  assert.equal(kit.outputs[0][3].createResponse, false)
  assert.equal(kit.ensuredResponses.length, 0)
  await waitForTask(kit.manager, kit.outputs[0][1].task_id)
})

test('accepts distinct spawn_thinking calls from one realtime response', async () => {
  const kit = harness()
  kit.transcripts.record('turn-one', '查询内存并生成小狗图片')
  const first = kit.handler.handle({
    call_id: 'call-one',
    response_id: 'response-multi-work',
    name: 'spawn_thinking',
    arguments: '{"objective":"查询电脑物理内存"}',
  }, { turnId: 'turn-one', turnGeneration: 1, responseId: 'response-multi-work' })
  const second = kit.handler.handle({
    call_id: 'call-two',
    response_id: 'response-multi-work',
    name: 'spawn_thinking',
    arguments: '{"objective":"生成一张小狗图片"}',
  }, { turnId: 'turn-one', turnGeneration: 1, responseId: 'response-multi-work' })

  // Providers may deliver response.done before the async function outputs
  // finish sending. The batch must still produce exactly one follow-up.
  await kit.handler.finishToolResponse('response-multi-work')
  await Promise.all([first, second])

  assert.equal(kit.manager.list({ ownerId: 'owner' }).length, 2)
  assert.ok(kit.outputs.every(output => output[1].status === 'accepted'))
  assert.ok(kit.outputs.every(output => output[3].createResponse === false))
  assert.ok(kit.outputs.every(output => (
    output[1].message === '工作已受理，请自然确认一次，不要再次调用工具。'
  )))
  assert.equal(kit.ensuredResponses.length, 1)
  assert.equal(kit.ensuredResponses[0][1], undefined)
  await Promise.all(kit.manager.list({ ownerId: 'owner' }).map(task => (
    kit.manager.wait(task.id)
  )))
})

test('blocks rewritten spawn_thinking calls from later responses in one turn', async () => {
  const kit = harness()
  kit.transcripts.record('turn-one', '单独创建一个贪吃蛇网页小游戏')
  await kit.handler.handle({
    call_id: 'call-first',
    response_id: 'response-first',
    name: 'spawn_thinking',
    arguments: '{"objective":"单独创建一个贪吃蛇网页小游戏"}',
  }, {
    turnId: 'turn-one',
    turnGeneration: 1,
    responseId: 'response-first',
  })
  await kit.handler.handle({
    call_id: 'call-rewritten',
    response_id: 'response-follow-up',
    name: 'spawn_thinking',
    arguments: '{"objective":"整理贪吃蛇完整代码并附说明"}',
  }, {
    turnId: 'turn-one',
    turnGeneration: 1,
    responseId: 'response-follow-up',
  })

  assert.equal(kit.manager.list({ ownerId: 'owner' }).length, 1)
  assert.equal(kit.outputs.at(-1)[1].status, 'duplicate')
  assert.equal(kit.outputs.at(-1)[3].createResponse, false)
})

test('blocks status polling triggered by a spawn receipt response', async () => {
  const kit = harness()
  kit.transcripts.record('turn-one', '查询电脑内存')
  await kit.handler.handle({
    call_id: 'call-spawn',
    response_id: 'response-spawn',
    name: 'spawn_thinking',
    arguments: '{"objective":"查询电脑内存"}',
  }, {
    turnId: 'turn-one',
    turnGeneration: 1,
    responseId: 'response-spawn',
  })

  await kit.handler.handle({
    call_id: 'call-status-follow-up',
    response_id: 'response-follow-up',
    name: 'get_agent_task_status',
    arguments: '{}',
  }, {
    turnId: 'turn-one',
    turnGeneration: 1,
    responseId: 'response-follow-up',
  })

  assert.equal(kit.outputs.at(-1)[1].status, 'duplicate')
  assert.equal(kit.outputs.at(-1)[3].createResponse, false)
  assert.equal(
    kit.handler.consumeTerminalToolResponse('response-follow-up'),
    true,
  )
  await Promise.all(kit.manager.list({ ownerId: 'owner' }).map(task => (
    kit.manager.wait(task.id)
  )))
})

test('allows one status query per user turn and blocks response-driven repeats', async () => {
  const activities = []
  const kit = harness({ onAgentActivity: event => activities.push(event) })
  const task = kit.manager.create({
    objective: '查询电脑内存',
    ownerId: 'owner',
    sessionId: 'voice',
    runner: async () => ({ content: '24 GB' }),
  })
  await kit.manager.wait(task.id)

  await kit.handler.handle({
    call_id: 'call-status-first',
    response_id: 'response-status-first',
    name: 'get_agent_task_status',
    arguments: '{}',
  }, {
    turnId: 'turn-one',
    turnGeneration: 1,
    responseId: 'response-status-first',
  })
  assert.equal(kit.outputs.at(-1)[1].status, 'ok')

  await kit.handler.handle({
    call_id: 'call-status-repeat',
    response_id: 'response-status-repeat',
    name: 'get_agent_task_status',
    arguments: '{}',
  }, {
    turnId: 'turn-one',
    turnGeneration: 1,
    responseId: 'response-status-repeat',
  })
  assert.equal(kit.outputs.at(-1)[1].status, 'duplicate')
  assert.equal(kit.outputs.at(-1)[3].createResponse, false)
  assert.deepEqual(activities, [{ activity: 'query', turnId: 'turn-one' }])
})

test('deduplicates the same objective replayed in one realtime turn', async () => {
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
    arguments: '{"objective":"执行一次"}',
  })
  assert.equal(kit.manager.list({ ownerId: 'owner' }).length, 1)
  assert.equal(kit.outputs.at(-1)[1].status, 'duplicate')
  assert.equal(
    kit.outputs.at(-1)[1].message,
    '同一工作此前已受理，请自然确认一次，不要再次调用工具。',
  )
})

test('rejects delegated work immediately when the backend is known to be down', async () => {
  const kit = harness({
    backendAvailability: {
      snapshot: () => ({ configured: true, ok: false, known: true }),
    },
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

test('accepts optimistically before the first health probe and fails via the task', async () => {
  let probed = 0
  const kit = harness({
    backendAvailability: {
      snapshot: () => {
        probed += 1
        return { configured: true, ok: true, known: false }
      },
    },
    coordinator: {
      run: async () => {
        throw new Error('后台 Agent 未连接')
      },
    },
  })
  kit.transcripts.record('turn-one', '帮我修改项目')
  await kit.handler.handle({
    call_id: 'call-optimistic',
    name: 'spawn_thinking',
    arguments: '{"objective":"修改项目"}',
  })

  // The receipt is optimistic; the dispatch failure surfaces on the task,
  // which the announcement path reports asynchronously.
  assert.equal(probed, 1)
  assert.equal(kit.outputs[0][1].status, 'accepted')
  await waitForTask(kit.manager, kit.outputs[0][1].task_id)
  assert.equal(taskForId(kit.manager, kit.outputs[0][1].task_id).status, 'failed')
})

test('hands out the acceptance receipt without waiting for the turn transcript', async () => {
  let received
  const kit = harness({
    coordinator: {
      run: async input => {
        received = input
        return { content: '完成', metadata: {} }
      },
    },
  })
  // No transcript is ever recorded: acceptance must not block on ASR and the
  // dispatch-time resolution falls back to the model-provided objective.
  await kit.handler.handle({
    call_id: 'call-no-transcript',
    name: 'spawn_thinking',
    arguments: '{"objective":"整理会议纪要"}',
  }, { turnId: 'turn-one', turnGeneration: 1 })

  assert.equal(kit.outputs[0][1].status, 'accepted')
  await waitForTask(kit.manager, kit.outputs[0][1].task_id)
  assert.equal(received.objective, '整理会议纪要')
})

test('keeps the submitted objective even when later turns evict the transcript', async () => {
  const requests = []
  let releaseFirst
  let currentTurn = 'turn-one'
  const kit = harness({
    getTurnId: () => currentTurn,
    coordinator: {
      run: async input => {
        requests.push(input.objective)
        if (input.objective === '堆积任务') {
          return new Promise(resolve => {
            releaseFirst = () => resolve({ content: '完成', metadata: {} })
          })
        }
        return { content: '完成', metadata: {} }
      },
    },
  })
  // The first work blocks the owner FIFO lane so the second one queues.
  kit.transcripts.record('turn-one', '堆积任务')
  await kit.handler.handle({
    call_id: 'call-blocking',
    name: 'spawn_thinking',
    arguments: '{"objective":"堆积任务"}',
  }, { turnId: 'turn-one', turnGeneration: 1 })

  kit.transcripts.record('turn-two', '把上周的周报发给老板')
  currentTurn = 'turn-two'
  await kit.handler.handle({
    call_id: 'call-queued',
    name: 'spawn_thinking',
    arguments: '{"objective":"发送上周周报"}',
  }, { turnId: 'turn-two', turnGeneration: 1 })
  const queuedTaskId = kit.outputs.at(-1)[1].task_id

  // While the lane is blocked, twenty-plus newer turns evict turn-two from
  // the transcript ring buffer. Dispatch must retain the submitted objective.
  for (let index = 0; index < 25; index += 1) {
    kit.transcripts.record(`turn-filler-${index}`, `闲聊第 ${index} 句`)
  }
  releaseFirst()
  await waitForTask(kit.manager, queuedTaskId)

  assert.deepEqual(requests, ['堆积任务', '发送上周周报'])
})

test('explains that background work is unavailable without a configured backend', async () => {
  const kit = harness({
    backendAvailability: {
      snapshot: () => ({ configured: false, ok: false, known: true }),
    },
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
      taskId: 'work-one',
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
  assert.equal(output[1].task_id, kit.task.id)
  assert.match(
    output[3].response.instructions,
    /respond_permission/,
  )
  assert.equal(
    kit.manager.list({ ownerId: 'owner' }).filter(task => (
      task.objective === '可以'
    )).length,
    0,
  )
  await kit.finish()
})

test('returns a backend answer to the same pending task', async () => {
  const manager = new TaskManager()
  let release
  const task = manager.create({
    objective: '生成报告',
    ownerId: 'owner',
    sessionId: 'voice',
    runner: async (_objective, { onEvent }) => {
      onEvent({
        type: 'backend.input.requested',
        input: {
          id: 'input-one',
          status: 'pending',
          mode: 'text',
          prompt: '使用中文还是英文？',
        },
      })
      await new Promise(resolve => { release = resolve })
      return { content: '完成' }
    },
  })
  await new Promise(resolve => setImmediate(resolve))
  const calls = []
  const kit = harness({
    manager,
    respondInput: async (...args) => {
      calls.push(args)
      return { status: 'accepted' }
    },
  })
  await kit.handler.handle({
    call_id: 'input-answer',
    name: 'respond_agent_input',
    arguments: JSON.stringify({
      task_id: task.id,
      action: 'accept',
      text: '中文',
    }),
  }, { turnId: 'turn-one', turnGeneration: 1 })
  assert.deepEqual(calls[0].slice(0, 3), [
    task.id,
    'input-one',
    { action: 'accept', text: '中文', values: undefined },
  ])
  assert.equal(kit.outputs[0][1].status, 'submitted')
  release()
  await manager.wait(task.id)
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
  await waitForTask(manager, first.outputs[0][1].task_id)
  assert.equal(manager.list({ ownerId: 'owner' }).length, 1)
  assert.equal(second.outputs[0][1].status, 'duplicate')
  assert.equal(
    second.outputs[0][1].message,
    '同一工作此前已受理，请自然确认一次，不要再次调用工具。',
  )
  assert.equal(runs, 1)
})

test('cancels the most recently submitted active work', async () => {
  const kit = harness()
  let release
  const cancellations = []
  kit.handler.backendRuntime = {
    run: async (_input, { signal }) => new Promise((resolve, reject) => {
      release = resolve
      signal.addEventListener('abort', () => reject(signal.reason), {
        once: true,
      })
    }),
    cancel: async (taskId, options) => {
      cancellations.push([taskId, options])
      return { taskId, state: 'cancelled' }
    },
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
  assert.match(
    kit.outputs.at(-1)[3].response.instructions,
    /只作一次简短自然的确认/,
  )
  assert.equal(kit.manager.list({ active: true }).length, 0)
  assert.equal(kit.manager.list()[0].status, 'cancelled')
  assert.deepEqual(cancellations, [[
    kit.manager.list()[0].id,
    { ownerId: 'owner' },
  ]])
  release?.()
})

test('cancels all active work with one tool call and one response', async () => {
  const manager = new TaskManager()
  const running = ['A', 'B'].map((objective, index) => manager.create({
    objective,
    ownerId: 'owner',
    sessionId: 'voice',
    laneKey: `lane-${index}`,
    runner: async (_input, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), {
        once: true,
      })
    }),
  }))
  await new Promise(resolve => setImmediate(resolve))
  const kit = harness({ manager })
  const cancellation = kit.handler.handle({
    call_id: 'call-cancel-all',
    response_id: 'response-cancel-all',
    name: 'cancel_agent_task',
    arguments: '{"all":true}',
  }, {
    turnId: 'turn-one',
    turnGeneration: 1,
    responseId: 'response-cancel-all',
  })
  await kit.handler.finishToolResponse('response-cancel-all')
  await cancellation

  assert.equal(kit.outputs.at(-1)[1].status, 'cancelled')
  assert.equal(kit.outputs.at(-1)[1].cancelled_count, 2)
  assert.equal(manager.list({ ownerId: 'owner', active: true }).length, 0)
  assert.ok(running.every(task => manager.get(task.id).status === 'cancelled'))
  assert.equal(kit.ensuredResponses.length, 1)
  assert.match(
    kit.ensuredResponses[0][1].response.instructions,
    /只作一次简短自然的确认/,
  )
})

test('batches targeted cancellations and blocks cancellation follow-ups', async () => {
  const manager = new TaskManager()
  const tasks = ['A', 'B'].map((objective, index) => manager.create({
    objective,
    ownerId: 'owner',
    sessionId: 'voice',
    laneKey: `lane-${index}`,
    runner: async (_input, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), {
        once: true,
      })
    }),
  }))
  await new Promise(resolve => setImmediate(resolve))
  const kit = harness({ manager })
  const calls = tasks.map((task, index) => kit.handler.handle({
    call_id: `call-cancel-${index}`,
    response_id: 'response-cancel-batch',
    name: 'cancel_agent_task',
    arguments: JSON.stringify({ task_id: task.id }),
  }, {
    turnId: 'turn-one',
    turnGeneration: 1,
    responseId: 'response-cancel-batch',
  }))
  await kit.handler.finishToolResponse('response-cancel-batch')
  await Promise.all(calls)

  assert.equal(kit.ensuredResponses.length, 1)
  assert.ok(kit.outputs.every(output => output[3].createResponse === false))

  await kit.handler.handle({
    call_id: 'call-cancel-follow-up',
    response_id: 'response-cancel-follow-up',
    name: 'cancel_agent_task',
    arguments: JSON.stringify({ task_id: tasks[0].id }),
  }, {
    turnId: 'turn-one',
    turnGeneration: 1,
    responseId: 'response-cancel-follow-up',
  })
  assert.equal(kit.outputs.at(-1)[1].status, 'duplicate')
  assert.equal(kit.outputs.at(-1)[3].createResponse, false)
  assert.equal(kit.ensuredResponses.length, 1)
})

test('queries the latest work directly from the realtime task ledger', async () => {
  const kit = harness()
  kit.transcripts.record('turn-one', '执行一次')
  await kit.handler.handle({
    call_id: 'call-submit',
    name: 'spawn_thinking',
    arguments: '{"objective":"执行一次"}',
  })
  const taskId = kit.outputs.at(-1)[1].task_id
  await kit.manager.wait(taskId)

  await kit.handler.handle({
    call_id: 'call-status',
    name: 'get_agent_task_status',
    arguments: '{}',
  })

  assert.equal(kit.outputs.at(-1)[1].status, 'ok')
  assert.equal(kit.outputs.at(-1)[1].task_id, taskId)
  assert.equal(kit.outputs.at(-1)[1].task_status, 'completed')
  assert.equal(kit.outputs.at(-1)[1].result, '完成')
  assert.deepEqual(kit.outputs.at(-1)[2], {
    turnId: 'turn-one',
    taskId: taskId,
    consumesTaskNotification: true,
  })
  assert.match(
    kit.outputs.at(-1)[1].message,
    /不要再次调用状态工具/,
  )
})

test('reports recent ordinary-work activity directly from the Gateway ledger', async () => {
  const manager = new TaskManager()
  let release
  const task = manager.create({
    objective: '修改首页',
    ownerId: 'owner',
    sessionId: 'voice',
    runner: async (_objective, { onEvent }) => {
      onEvent({
        type: 'backend.activity',
        activity: { id: null, kind: 'text', status: 'running' },
      })
      onEvent({
        type: 'backend.activity',
        activity: {
          id: 'plan',
          kind: 'plan',
          status: 'running',
          detail: '更新页面结构',
          completed: 1,
          total: 3,
        },
      })
      onEvent({
        type: 'backend.activity',
        activity: {
          id: 'write-one',
          kind: 'tool',
          category: 'write',
          status: 'completed',
          label: '写入 src/index.html',
        },
      })
      onEvent({
        type: 'backend.message',
        message: '页面主体已经完成。',
      })
      onEvent({
        type: 'backend.artifact',
        artifact: {
          artifactId: 'page',
          name: 'index.html',
          parts: [{ text: '<main />', mediaType: 'text/html' }],
        },
      })
      return new Promise(resolve => { release = resolve })
    },
  })
  await new Promise(resolve => setImmediate(resolve))
  let coordinatorQueries = 0
  const kit = harness({
    manager,
    coordinator: {
      queryDelegatedWork: async () => {
        coordinatorQueries += 1
        return { content: '不应调用' }
      },
    },
  })

  await kit.handler.handle({
    call_id: 'call-running-status',
    name: 'get_agent_task_status',
    arguments: JSON.stringify({ task_id: task.id }),
  })

  const output = kit.outputs.at(-1)[1]
  assert.equal(output.task_status, 'running')
  assert.deepEqual(output.recent_updates, [
    {
      kind: 'plan',
      status: 'running',
      detail: '更新页面结构',
      completed: 1,
      total: 3,
    },
    {
      kind: 'tool',
      status: 'completed',
      category: 'write',
      detail: '写入 src/index.html',
    },
  ])
  assert.equal(output.latest_update, '页面主体已经完成。')
  assert.deepEqual(output.artifacts, [{
    artifact_id: 'page',
    name: 'index.html',
    description: null,
  }])
  assert.equal(coordinatorQueries, 0)

  release({ content: '完成' })
  await manager.wait(task.id)
})

test('queries delegated status directly from the Gateway ledger', async () => {
  const manager = new TaskManager()
  let releaseDelegation
  const delegated = manager.create({
    objective: '继续 Megatron-LM 项目',
    ownerId: 'owner',
    sessionId: 'voice',
    laneKey: 'backend:owner',
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
      onEvent({
        type: 'backend.activity',
        activity: {
          id: 'read-one',
          kind: 'tool',
          category: 'read',
          status: 'completed',
          detail: '检查模型目录',
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

  const kit = harness({
    manager,
    coordinator: {
      queryDelegatedWork: async () => {
        throw new Error('delegated status must not query the coordinator')
      },
    },
  })
  kit.transcripts.record('turn-one', 'Megatron 那个已经查到了什么？')
  await kit.handler.handle({
    call_id: 'call-delegated-status',
    name: 'get_agent_task_status',
    arguments: JSON.stringify({ task_id: delegated.id }),
  })

  const output = kit.outputs.at(-1)[1]
  assert.equal(output.status, 'ok')
  assert.equal(output.task_id, delegated.id)
  assert.equal(output.task_status, 'delegated')
  assert.deepEqual(output.recent_updates, [{
    kind: 'tool',
    status: 'completed',
    category: 'read',
    detail: '检查模型目录',
  }])
  assert.equal(manager.list({ ownerId: 'owner' }).length, 1)

  releaseDelegation({ content: '最终完成' })
  await manager.wait(delegated.id)
})

test('allows one realtime permission without enabling later automatic approval', async () => {
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
        taskId: 'work-one',
        status: 'approved',
      }
    },
  })
  await kit.handler.handle({
    call_id: 'permission-semantic-allow',
    name: 'respond_permission',
    arguments: JSON.stringify({
      permission_id: permissionReference('auth-one'),
      task_id: kit.task.id,
      decision: 'once',
    }),
  })

  // The receipt is issued before the fire-and-forget backend delivery lands.
  assert.equal(kit.outputs.at(-1)[1].status, 'submitted')
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(calls, [{
    id: 'auth-one',
    decision: 'once',
    options: { ownerId: 'owner' },
  }])
  assert.match(
    kit.outputs.at(-1)[3].response.instructions,
    /已允许，后台继续执行/,
  )
  assert.equal(permissionPolicy.shouldAutoAllow('owner', 'voice'), false)
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
      taskId: 'work-one',
      status: 'rejected',
    }),
  })
  await kit.handler.handle({
    call_id: 'permission-semantic-reject',
    name: 'respond_permission',
    arguments: JSON.stringify({
      permission_id: permissionReference('auth-one'),
      task_id: kit.task.id,
      decision: 'reject',
    }),
  })

  assert.equal(kit.outputs.at(-1)[1].status, 'submitted')
  assert.match(
    kit.outputs.at(-1)[3].response.instructions,
    /已拒绝/,
  )
  assert.equal(permissionPolicy.mode('owner', 'voice'), 'ask')
  await kit.finish()
})

test('rolls back the session policy when the permission delivery fails', async () => {
  const failures = []
  const permissionPolicy = new SessionPermissionPolicy()
  const kit = await permissionHarness({
    answer: '可以',
    permissionPolicy,
    respondPermission: async () => {
      throw new Error('backend unreachable')
    },
    onPermissionDeliveryFailed: event => failures.push(event),
  })
  await kit.handler.handle({
    call_id: 'permission-delivery-failed',
    name: 'respond_permission',
    arguments: JSON.stringify({
      permission_id: permissionReference('auth-one'),
      task_id: kit.task.id,
      decision: 'always',
    }),
  })

  // The spoken confirmation is receipt-based and always issued.
  assert.equal(kit.outputs.at(-1)[1].status, 'submitted')
  await new Promise(resolve => setImmediate(resolve))
  // Delivery failed: the local auto-allow rolls back and the gateway is told
  // so the pending permission can be re-announced.
  assert.equal(permissionPolicy.shouldAutoAllow('owner', 'voice'), false)
  assert.equal(failures.length, 1)
  assert.equal(failures[0].authorizationId, 'auth-one')
  assert.equal(failures[0].decision, 'always')
  assert.match(failures[0].error, /backend unreachable/)
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
  await waitForTask(kit.manager, kit.outputs[0][1].task_id)

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

test('one always decision settles every pending permission for the selected task', async () => {
  const permissionIds = ['auth-news-1', 'auth-news-2', 'auth-news-3', 'auth-news-4']
  const approvals = []
  let release
  const kit = harness({
    permissionPolicy: new SessionPermissionPolicy(),
    respondPermission: async (id, decision, options) => {
      approvals.push({ id, decision, options })
      return { id, status: 'approved' }
    },
    coordinator: {
      run: async (_input, { onEvent }) => {
        permissionIds.forEach(id => onEvent({
          type: 'backend.permission.requested',
          permission: {
            id,
            status: 'pending',
            category: 'search',
            summary: `Allow search ${id}`,
          },
        }))
        return new Promise(resolve => { release = resolve })
      },
    },
  })
  kit.transcripts.record('turn-one', '搜索新闻')
  await kit.handler.handle({
    call_id: 'spawn-news',
    name: 'spawn_thinking',
    arguments: '{"objective":"搜索最新新闻"}',
  }, { turnId: 'turn-one', turnGeneration: 1 })
  await new Promise(resolve => setImmediate(resolve))

  kit.transcripts.record('turn-one', '我同意')
  const taskId = kit.manager.list({ ownerId: 'owner' })[0].id
  const decision = kit.handler.handle({
    call_id: 'allow-news',
    response_id: 'permission-response',
    name: 'respond_permission',
    arguments: JSON.stringify({
      permission_id: permissionReference(permissionIds[0]),
      task_id: taskId,
      decision: 'always',
    }),
  }, {
    turnId: 'turn-one',
    turnGeneration: 1,
    responseId: 'permission-response',
  })
  await kit.handler.finishToolResponse('permission-response')
  await decision
  await new Promise(resolve => setImmediate(resolve))

  assert.deepEqual(
    approvals.map(call => call.id).sort(),
    [...permissionIds].sort(),
  )
  assert.ok(approvals.every(call => call.decision === 'always'))
  assert.ok(kit.outputs.slice(1).every(output => output[3].createResponse === false))
  assert.equal(kit.ensuredResponses.length, 1)
  assert.match(
    kit.ensuredResponses[0][1].response.instructions,
    /已允许，后台继续执行/,
  )

  release({ content: '完成' })
  await Promise.all(kit.manager.list({ ownerId: 'owner' }).map(task => (
    kit.manager.wait(task.id)
  )))
})

test('accepts a semantic permission decision without an evidence field', async () => {
  const calls = []
  const kit = await permissionHarness({
    answer: '你按刚才说的做吧',
    respondPermission: async (id, decision) => {
      calls.push({ id, decision })
      return { id, taskId: 'work-one', status: 'approved' }
    },
  })
  await kit.handler.handle({
    call_id: 'permission-without-evidence',
    name: 'respond_permission',
    arguments: JSON.stringify({
      permission_id: permissionReference('auth-one'),
      task_id: kit.task.id,
      decision: 'always',
    }),
  })

  // The verbatim delivery lands asynchronously behind the receipt.
  assert.equal(kit.outputs.at(-1)[1].status, 'submitted')
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(calls, [{ id: 'auth-one', decision: 'always' }])
  await kit.finish()
})

test('rejects a task id that has no pending permission', async () => {
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
    name: 'respond_permission',
    arguments: JSON.stringify({
      permission_id: permissionReference('auth-one'),
      task_id: 'task-other',
      decision: 'always',
    }),
  }, {
    turnId: 'turn-one',
    turnGeneration: 1,
    responseId: 'permission-wrong-response',
  })
  await kit.handler.finishToolResponse('permission-wrong-response')

  assert.equal(called, false)
  assert.equal(kit.outputs.at(-1)[1].error_code, 'permission_not_pending')
  assert.equal(kit.ensuredResponses.length, 1)
  assert.match(
    kit.ensuredResponses[0][1].response.instructions,
    /没有真实、仍待确认的后台权限请求/,
  )
  assert.doesNotMatch(
    kit.ensuredResponses[0][1].response.instructions,
    /已允许/,
  )
  await kit.finish()
})

test('reads both natural Markdown memory documents', async () => {
  const calls = []
  const memoryStore = {
    list: (ownerId, options) => {
      calls.push(['list', ownerId, options])
      return [{
        id: 'user_document',
        scope: 'user',
        content: '# USER\n\n- 称呼：船长',
        revision: 'rev-user',
        editable: true,
      }]
    },
  }
  const kit = harness({ memoryStore })

  await kit.handler.handle({
    call_id: 'memory-read',
    name: 'memory',
    arguments: '{"action":"read"}',
  })
  assert.equal(kit.outputs.at(-1)[1].status, 'ok')
  assert.deepEqual(calls[0], ['list', 'owner', undefined])
  assert.equal(kit.outputs.at(-1)[1].documents[0].revision, 'rev-user')
})

test('replaces one exact Markdown fragment', async () => {
  let call
  let changes = 0
  const kit = harness({
    memoryStore: {
      apply: (ownerId, changes) => {
        call = { ownerId, changes }
        return {
          changed: 3,
          documents: changes.map(change => ({ scope: change.document, revision: 'next' })),
        }
      },
    },
    onMemoryChanged: () => { changes += 1 },
  })

  await kit.handler.handle({
    call_id: 'memory-edit',
    name: 'memory',
    arguments: JSON.stringify({
      action: 'replace',
      document: 'user',
      old_text: '- 称呼：老板',
      new_text: '- 称呼：船长',
    }),
  })

  assert.deepEqual(call, {
    ownerId: 'owner',
    changes: [{
      document: 'user',
      edits: [{ old_text: '- 称呼：老板', new_text: '- 称呼：船长' }],
      append: '',
    }],
  })
  assert.equal(kit.outputs.at(-1)[1].status, 'updated')
  assert.equal(changes, 1)
})

test('appends one memory item', async () => {
  let call
  const kit = harness({
    memoryStore: {
      apply: (ownerId, changes) => {
        call = { ownerId, changes }
        return {
          changed: 2,
          documents: changes.map(change => ({ scope: change.document, revision: 'next' })),
        }
      },
    },
  })

  await kit.handler.handle({
    call_id: 'memory-cross-scope',
    name: 'memory',
    arguments: JSON.stringify({
      action: 'append',
      document: 'user',
      content: '- 助手称呼用户：老大',
    }),
  })

  assert.equal(call.ownerId, 'owner')
  assert.equal(call.changes[0].document, 'user')
  assert.equal(call.changes[0].append, '- 助手称呼用户：老大')
  assert.equal(kit.outputs.at(-1)[1].status, 'updated')
  assert.equal(kit.outputs.at(-1)[1].documents.length, 1)
})

test('combines multiple memory writes from one model response into one follow-up', async () => {
  const kit = harness({
    memoryStore: {
      apply: (_ownerId, changes) => ({
        changed: 1,
        documents: changes.map(change => ({ scope: change.document })),
      }),
    },
  })
  const context = {
    turnId: 'turn-one',
    turnGeneration: 1,
    responseId: 'response-memory-batch',
  }
  await Promise.all([
    ['memory-name', 'user', '- 助手称呼用户：船长'],
    ['memory-assistant-name', 'user', '- 当前用户称呼助手：小舟'],
    ['memory-hobby', 'memory', '- 喜欢打篮球'],
  ].map(async ([callId, scope, append]) => kit.handler.handle({
    call_id: callId,
    response_id: 'response-memory-batch',
    name: 'memory',
    arguments: JSON.stringify({
      action: 'append',
      document: scope,
      content: append,
    }),
  }, context)))

  assert.equal(kit.outputs.length, 3)
  assert.ok(kit.outputs.every(output => output[3].createResponse === false))
  assert.equal(kit.ensuredResponses.length, 0)

  await kit.handler.finishToolResponse('response-memory-batch')
  assert.equal(kit.ensuredResponses.length, 1)
  assert.deepEqual(kit.ensuredResponses[0][0], {
    turnId: 'turn-one',
    turnGeneration: 1,
  })
})

test('returns the latest document when an exact edit no longer matches', async () => {
  const kit = harness({
    memoryStore: {
      apply: () => {
        const error = new Error('stale')
        error.code = 'edit_not_found'
        throw error
      },
      list: () => [{ scope: 'memory', content: '# MEMORY', revision: 'latest' }],
    },
  })
  await kit.handler.handle({
    call_id: 'memory-stale',
    name: 'memory',
    arguments: JSON.stringify({
      action: 'replace',
      document: 'memory',
      old_text: '- 喜欢香蕉',
      new_text: '- 喜欢苹果',
    }),
  })
  assert.equal(kit.outputs.at(-1)[1].error_code, 'edit_not_found')
  assert.equal(kit.outputs.at(-1)[1].documents[0].revision, 'latest')
})

test('fails closed when a frontend tool result exceeds its size budget', async () => {
  const kit = harness({
    memoryStore: {
      list: () => [{
        scope: 'memory',
        content: 'x'.repeat(70 * 1024),
        revision: 'large',
      }],
    },
  })

  await kit.handler.handle({
    call_id: 'memory-too-large',
    name: 'memory',
    arguments: JSON.stringify({ action: 'read', document: 'memory' }),
  })

  assert.equal(kit.outputs.at(-1)[1].error_code, 'tool_result_too_large')
})

test('rejects sensitive additions and incomplete atomic edits', async () => {
  const kit = harness({
    memoryStore: {
      apply: () => { throw new Error('must not write') },
    },
  })
  await kit.handler.handle({
    call_id: 'memory-secret',
    name: 'memory',
    arguments: JSON.stringify({
      action: 'append',
      document: 'memory',
      content: '- API Key：sk-secret',
    }),
  })
  assert.equal(kit.outputs.at(-1)[1].error_code, 'sensitive_memory')
  await kit.handler.handle({
    call_id: 'memory-no-scope',
    name: 'memory',
    arguments: '{"action":"replace","document":"user","old_text":"- 称呼：船长"}',
  })
  assert.equal(kit.outputs.at(-1)[1].error_code, 'invalid_memory_edit')
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
