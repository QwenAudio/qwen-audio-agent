import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildFrontendInstructions,
  REALTIME_PROVIDERS,
  RealtimeFrontend,
} from '../src/voice/realtime-provider.mjs'

const FRONTEND_TOOL_NAMES = [
  'spawn_thinking',
  'cancel_agent_task',
  'get_agent_task_status',
  'get_current_time',
  'user_memory',
  'respond_agent_permission',
]

function createQwenFrontend(options = {}) {
  return new RealtimeFrontend({
    provider: REALTIME_PROVIDERS.qwen,
    ...options,
  })
}

test('carries originating turn metadata to a created realtime response', () => {
  const frontend = createQwenFrontend()
  frontend.pendingResponses.push({
    origin: 'agent',
    context: { turnId: 'voice-100-1', taskId: 'job_1' },
    resolve: () => {},
  })
  const event = { type: 'response.created', response: { id: 'response_1' } }
  frontend.handleLifecycle(event)

  assert.equal(event.__voiceOrigin, 'agent')
  assert.deepEqual(event.__voiceContext, {
    turnId: 'voice-100-1',
    taskId: 'job_1',
  })
  frontend.handleLifecycle({
    type: 'response.done',
    response: { id: 'response_1', status: 'completed' },
  })
})

test('only reports a queued announcement as completed after response.done', async () => {
  const frontend = createQwenFrontend({
    responseStartTimeoutMs: 50,
    responseCompletionTimeoutMs: 50,
  })
  frontend.ready = true
  frontend.send = () => {}

  const outcome = frontend.speak('任务完成', 'agent', {
    turnId: 'voice-100-1',
    taskId: 'job-1',
  })
  await new Promise(resolve => setImmediate(resolve))
  frontend.handleLifecycle({
    type: 'response.created',
    response: { id: 'response-1' },
  })
  frontend.handleLifecycle({
    type: 'response.done',
    response: { id: 'response-1', status: 'completed' },
  })

  assert.deepEqual(await outcome, {
    completed: true,
    responseId: 'response-1',
  })
})

test('skips a queued response when its late deduplication guard rejects it', async () => {
  const frontend = createQwenFrontend()
  frontend.ready = true
  const sent = []
  frontend.send = event => sent.push(event)

  const outcome = await frontend.speak(
    '重复的启动说明',
    'agent',
    { turnId: 'voice-100-1', taskId: 'job-1' },
    { shouldSpeak: () => false },
  )

  assert.deepEqual(outcome, {
    skipped: true,
    phase: 'deduplicated',
  })
  assert.equal(frontend.pendingResponses.length, 0)
  assert.deepEqual(sent, [])
})

test('reports an unstarted response timeout as uncertain rather than successful', async () => {
  const frontend = createQwenFrontend({
    responseStartTimeoutMs: 2,
  })
  frontend.ready = true
  frontend.send = () => {}

  const outcome = await frontend.speak('任务完成')
  assert.deepEqual(outcome, {
    timedOut: true,
    phase: 'start',
  })
})

test('serializes response creation so only one start can await correlation', async () => {
  const frontend = createQwenFrontend({
    responseStartTimeoutMs: 50,
    responseCompletionTimeoutMs: 50,
  })
  frontend.ready = true
  const sent = []
  frontend.send = event => sent.push(event)

  const first = frontend.speak('第一条')
  const second = frontend.speak('第二条')
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(frontend.pendingResponses.length, 1)
  assert.equal(sent.length, 1)

  frontend.handleLifecycle({
    type: 'response.created',
    response: { id: 'response-one' },
  })
  frontend.handleLifecycle({
    type: 'response.done',
    response: { id: 'response-one', status: 'completed' },
  })
  await first
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(frontend.pendingResponses.length, 1)
  assert.equal(sent.length, 2)

  frontend.handleLifecycle({
    type: 'response.created',
    response: { id: 'response-two' },
  })
  frontend.handleLifecycle({
    type: 'response.done',
    response: { id: 'response-two', status: 'completed' },
  })
  await second
})

test('fails closed instead of ambiguously correlating two pending starts', async () => {
  const errors = []
  const frontend = createQwenFrontend({
    onError: error => errors.push(error),
  })
  frontend.ready = true
  const sent = []
  frontend.send = event => sent.push(event)
  frontend.pendingResponses.push({
    origin: 'existing',
    context: {},
    settled: false,
    resolve: () => {},
    timer: null,
  })

  const outcome = await frontend.speak('不应发送')

  assert.equal(outcome.failed, true)
  assert.equal(outcome.phase, 'correlation')
  assert.equal(frontend.pendingResponses.length, 1)
  assert.deepEqual(sent, [])
  assert.match(errors[0].message, /响应关联冲突/)
})

test('configures Qwen Audio Realtime with Smart Turn only', () => {
  const session = REALTIME_PROVIDERS.qwen.buildSession({ configured: false })

  assert.deepEqual(session.turn_detection, { type: 'smart_turn' })
  assert.equal(session.turn_detection.threshold, undefined)
  assert.equal(session.turn_detection.silence_duration_ms, undefined)
  assert.equal(REALTIME_PROVIDERS.qwen.inputSampleRate, 16000)
  assert.deepEqual(
    session.tools.map(tool => tool.function.name),
    FRONTEND_TOOL_NAMES,
  )
  assert.deepEqual(
    session.tools[0].function.parameters.required,
    ['objective'],
  )
  assert.deepEqual(
    session.tools.find(tool => (
      tool.function.name === 'respond_agent_permission'
    )).function.parameters.required,
    ['authorization_id', 'decision'],
  )
  assert.match(
    session.tools.find(tool => (
      tool.function.name === 'respond_agent_permission'
    )).function.description,
    /用户回答“可以”.*应调用 always/,
  )
})

test('configures a text-only Qwen session without Smart Turn', () => {
  const session = REALTIME_PROVIDERS.qwen.buildSession({
    configured: false,
    agentContext: { textOnly: true },
  })

  assert.deepEqual(session.modalities, ['text'])
  assert.equal(session.turn_detection, null)
  assert.deepEqual(
    REALTIME_PROVIDERS.qwen
      .buildSpeakResponse('完成', { textOnly: true })
      .modalities,
    ['text'],
  )
  assert.deepEqual(
    REALTIME_PROVIDERS.qwen
      .buildResultInjection('结果', { textOnly: true })
      .response.modalities,
    ['text'],
  )
})

test('adds an event id to realtime client events', () => {
  const frontend = createQwenFrontend()
  let sent
  frontend.ws = {
    readyState: 1,
    send: value => {
      sent = JSON.parse(value)
    },
  }

  frontend.appendAudio('pcm')

  assert.match(sent.event_id, /^event_[a-f0-9]+$/)
  assert.equal(sent.type, 'input_audio_buffer.append')
  assert.equal(sent.audio, 'pcm')
})

test('isolates a provider with a different wire message shape', () => {
  const events = []
  let sent
  const base = REALTIME_PROVIDERS.qwen
  const provider = {
    ...base,
    key: 'custom',
    label: 'Custom Realtime',
    protocol: {
      ...base.protocol,
      encodeOutgoing: payload => ({ frame: payload }),
      audioAppend: audio => ({ op: 'push-audio', chunk: audio }),
      normalizeIncoming: event => {
        if (event.kind === 'started') {
          return {
            type: 'response.created',
            response: { id: event.responseId },
          }
        }
        if (event.kind === 'finished') {
          return {
            type: 'response.done',
            response: {
              id: event.responseId,
              status: event.outcome,
            },
          }
        }
        return null
      },
    },
  }
  const frontend = new RealtimeFrontend({
    provider,
    onEvent: event => events.push(event),
  })
  frontend.ws = {
    readyState: 1,
    send: value => {
      sent = JSON.parse(value)
    },
  }
  frontend.pendingResponses.push({
    origin: 'agent',
    context: { turnId: 'turn-custom' },
    resolve: () => {},
    settled: false,
    timer: null,
  })

  frontend.appendAudio('custom-pcm')
  assert.deepEqual(sent, {
    frame: {
      op: 'push-audio',
      chunk: 'custom-pcm',
    },
  })

  frontend.handleProviderEvent({
    kind: 'started',
    responseId: 'custom-response',
  })
  assert.equal(frontend.activeResponses.has('custom-response'), true)
  assert.equal(events[0].type, 'response.created')
  assert.deepEqual(events[0].__voiceContext, {
    turnId: 'turn-custom',
  })

  frontend.handleProviderEvent({
    kind: 'finished',
    responseId: 'custom-response',
    outcome: 'completed',
  })
  assert.equal(frontend.activeResponses.size, 0)
  assert.equal(events[1].type, 'response.done')
})

test('builds frontend identity, time, memory and reconnect context', () => {
  const prompt = buildFrontendInstructions({
    client: { timeZone: 'Asia/Shanghai', locale: 'zh-CN' },
    now: new Date('2026-07-23T04:00:00.000Z'),
    memories: [{
      scope: 'profile',
      content: '用户希望被称为小明',
    }],
    recentMessages: [{
      role: 'user',
      content: '我们刚才在讨论下载目录',
    }],
  })

  assert.match(prompt, /你叫千问Audio/)
  assert.match(prompt, /用户正在双工语音交谈的统一助手/)
  assert.match(prompt, /不要把自己描述成前台模型、语音模型/)
  assert.match(prompt, /始终是同一个千问Audio/)
  assert.match(prompt, /Asia\/Shanghai/)
  assert.match(prompt, /2026年7月23日/)
  assert.match(prompt, /\[profile\] 用户希望被称为小明/)
  assert.match(prompt, /我们刚才在讨论下载目录/)
  assert.match(prompt, /get_current_time/)
  assert.match(prompt, /user_memory/)
  assert.match(prompt, /每次用户说完后选择一种方式/)
  assert.match(prompt, /始终保持可继续/)
  assert.match(prompt, /避免“好的、收到、没问题”/)
  assert.match(prompt, /# Operating model/)
  assert.match(prompt, /# Speaking style/)
  assert.match(prompt, /没有值得告诉用户的新信息时，不要说话/)
  assert.match(prompt, /不要规定后台 Agent 使用哪个工具/)
  assert.match(prompt, /\[COMPLETE\]/)
  assert.doesNotMatch(prompt, /get_agent_tasks|reply_agent_permission/)
  assert.match(prompt, /respond_agent_permission/)
  assert.match(prompt, /存在待确认权限时/)
  assert.match(prompt, /不要求用户原话与某个短语逐字一致/)
  assert.match(prompt, /判断明确后直接调用工具/)
  assert.match(prompt, /不要先说“好”“收到”“正在授权”/)
  assert.match(prompt, /cancel_agent_task/)
  const memory = REALTIME_PROVIDERS.qwen
    .buildSession({ configured: false })
    .tools.find(tool => tool.function.name === 'user_memory')
  assert.deepEqual(
    memory.function.parameters.properties.action.enum,
    ['recall', 'remember', 'replace', 'forget'],
  )
  assert.deepEqual(
    memory.function.parameters.properties.scope.enum,
    ['profile', 'long_term', 'all'],
  )
  assert.equal(
    memory.function.parameters.properties.memory_ids.items.type,
    'string',
  )

  const delegate = REALTIME_PROVIDERS.qwen
    .buildSession({ configured: false })
    .tools.find(tool => tool.function.name === 'spawn_thinking')
  assert.match(delegate.function.description, /屏幕/)
  assert.match(delegate.function.description, /阶段产物/)
  assert.match(delegate.function.description, /get_agent_task_status/)
  assert.match(delegate.function.description, /不要使用“好的、收到”/)
  assert.match(delegate.function.description, /结合本轮已有发言判断/)
  assert.match(delegate.function.description, /先问一个必要问题/)
  assert.match(
    delegate.function.parameters.properties.objective.description,
    /忠实保留本轮用户要求/,
  )
  assert.match(
    delegate.function.parameters.properties.objective.description,
    /必须是已经可以执行的目标/,
  )
  assert.match(
    delegate.function.parameters.properties.objective.description,
    /后台 Agent 会同时收到近期对话/,
  )
  assert.match(prompt, /继续或修改已有工作/)
  assert.match(prompt, /get_agent_task_status/)
  assert.match(prompt, /不要因为推测自己缺少某种能力而拒绝/)
  const permission = REALTIME_PROVIDERS.qwen.buildPermissionInjection({
    id: 'permission-one',
    summary: '查看系统内存',
  })
  assert.match(permission.response.instructions, /自然、简短地说明操作/)
  assert.match(permission.response.instructions, /是否同意授权/)
  assert.doesNotMatch(permission.response.instructions, /用一句完整的话/)
  assert.match(permission.response.instructions, /不要提供或要求复述固定口令/)
  assert.doesNotMatch(permission.response.instructions, /后续权限会自动允许/)
  assert.doesNotMatch(permission.response.instructions, /必须明确告诉用户/)
})

test('refreshes live session instructions after frontend context changes', async () => {
  const frontend = createQwenFrontend({
    agentContext: {
      client: { timeZone: 'Asia/Shanghai', locale: 'zh-CN' },
      memories: [{ scope: 'profile', content: '用户希望被称为旧称呼' }],
    },
  })
  const sent = []
  frontend.ready = true
  frontend.sessionConfigured = true
  frontend.send = payload => sent.push(payload)

  frontend.updateAgentContext({
    memories: [{ scope: 'profile', content: '用户希望被称为新称呼' }],
  })
  await frontend.outputQueue

  assert.equal(sent[0].type, 'session.update')
  assert.match(sent[0].session.instructions, /\[profile\] 用户希望被称为新称呼/)
  assert.doesNotMatch(sent[0].session.instructions, /旧称呼/)
})

test('can close a stale function call without creating a new model response', async () => {
  const frontend = createQwenFrontend()
  const sent = []
  frontend.ready = true
  frontend.send = payload => sent.push(payload)

  const outcome = frontend.sendFunctionOutput(
    'call-stale',
    { status: 'superseded' },
    { turnId: 'turn-old' },
    { createResponse: false },
  )
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(sent.length, 1)
  assert.equal(sent[0].type, 'conversation.item.create')
  assert.equal(sent[0].item.type, 'function_call_output')
  frontend.handleLifecycle({
    type: 'conversation.item.created',
    item: { id: sent[0].item.id, type: 'function_call_output' },
  })
  await outcome
})

test('can give the model contextual guidance after an accepted tool call', async () => {
  const frontend = createQwenFrontend({
    responseStartTimeoutMs: 50,
    responseCompletionTimeoutMs: 50,
  })
  const sent = []
  frontend.ready = true
  frontend.send = payload => sent.push(payload)

  const outcome = frontend.sendFunctionOutput(
    'call-accepted',
    { status: 'accepted' },
    { turnId: 'turn-one' },
    {
      response: {
        instructions: '判断是否还需要确认。',
      },
    },
  )
  await new Promise(resolve => setImmediate(resolve))
  frontend.handleLifecycle({
    type: 'conversation.item.created',
    item: { ...sent[0].item, status: 'completed' },
  })
  await new Promise(resolve => setImmediate(resolve))

  assert.deepEqual(sent[1], {
    type: 'response.create',
    response: {
      instructions: '判断是否还需要确认。',
    },
  })
  frontend.handleLifecycle({
    type: 'response.created',
    response: { id: 'response-followup' },
  })
  frontend.handleLifecycle({
    type: 'response.done',
    response: { id: 'response-followup', status: 'completed' },
  })
  assert.deepEqual(await outcome, {
    completed: true,
    responseId: 'response-followup',
  })
})

test('can force one model response when Smart Turn stays silent', async () => {
  const frontend = createQwenFrontend({
    responseStartTimeoutMs: 50,
    responseCompletionTimeoutMs: 50,
  })
  const sent = []
  frontend.ready = true
  frontend.send = payload => sent.push(payload)

  const outcome = frontend.ensureResponse(
    { turnId: 'permission-turn' },
    { shouldCreate: () => true },
  )
  await new Promise(resolve => setImmediate(resolve))

  assert.deepEqual(sent, [{ type: 'response.create' }])
  frontend.handleLifecycle({
    type: 'response.created',
    response: { id: 'response-permission' },
  })
  frontend.handleLifecycle({
    type: 'response.done',
    response: { id: 'response-permission', status: 'completed' },
  })
  assert.deepEqual(await outcome, {
    completed: true,
    responseId: 'response-permission',
  })
})

test('submits text through the documented Qwen conversation protocol', async () => {
  const frontend = createQwenFrontend({
    responseStartTimeoutMs: 50,
    responseCompletionTimeoutMs: 50,
  })
  const sent = []
  frontend.ready = true
  frontend.send = payload => sent.push(payload)

  const outcome = frontend.sendUserText(
    '  你好，文字模式  ',
    { turnId: 'text-1' },
    { modalities: ['text'] },
  )
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(sent.length, 1)
  assert.equal(sent[0].type, 'conversation.item.create')
  assert.equal(sent[0].item.type, 'message')
  assert.equal(sent[0].item.role, 'user')
  assert.deepEqual(sent[0].item.content, [{
    type: 'input_text',
    text: '你好，文字模式',
  }])
  assert.doesNotMatch(
    sent.map(event => event.type).join(','),
    /input_audio_buffer/,
  )

  frontend.handleLifecycle({
    type: 'conversation.item.created',
    item: { ...sent[0].item, status: 'completed' },
  })
  await new Promise(resolve => setImmediate(resolve))

  assert.deepEqual(sent[1], {
    type: 'response.create',
    response: { modalities: ['text'] },
  })
  frontend.handleLifecycle({
    type: 'response.created',
    response: { id: 'response-text' },
  })
  frontend.handleLifecycle({
    type: 'response.done',
    response: { id: 'response-text', status: 'completed' },
  })
  assert.deepEqual(await outcome, {
    completed: true,
    responseId: 'response-text',
  })
})

test('does not trigger inference when Qwen rejects a text conversation item', async () => {
  const frontend = createQwenFrontend({
    responseStartTimeoutMs: 50,
  })
  const sent = []
  frontend.ready = true
  frontend.send = payload => sent.push(payload)

  const outcome = frontend.sendUserText('失败输入')
  await new Promise(resolve => setImmediate(resolve))
  frontend.handleLifecycle({
    type: 'error',
    error: { message: 'invalid conversation item' },
  })

  assert.deepEqual(await outcome, {
    failed: true,
    phase: 'input',
    error: 'invalid conversation item',
  })
  assert.deepEqual(sent.map(event => event.type), ['conversation.item.create'])
})

test('injects a completed work result into Qwen conversation with tools disabled', async () => {
  const frontend = createQwenFrontend({
    responseStartTimeoutMs: 50,
    responseCompletionTimeoutMs: 50,
  })
  const sent = []
  frontend.ready = true
  frontend.send = payload => sent.push(payload)

  const outcome = frontend.injectResult(
    '后台任务完成：第二点是保持上下文。',
    'announcement',
    { turnId: 'turn-result', taskId: 'job-result' },
  )
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(sent[0].type, 'conversation.item.create')
  assert.equal(sent[0].item.type, 'message')
  assert.equal(sent[0].item.role, 'user')
  assert.deepEqual(sent[0].item.content, [{
    type: 'input_text',
    text: '后台任务完成：第二点是保持上下文。',
  }])
  frontend.handleLifecycle({
    type: 'conversation.item.created',
    item: { ...sent[0].item, status: 'completed' },
  })
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(sent[1].type, 'response.create')
  assert.equal(sent[1].response.conversation, undefined)
  assert.equal(sent[1].response.tool_choice, 'none')
  assert.deepEqual(sent[1].response.modalities, ['text', 'audio'])
  assert.match(sent[1].response.instructions, /结合当前对话自然回应/)
  assert.doesNotMatch(sent[1].response.instructions, /最多两三个|先结论/)

  frontend.handleLifecycle({
    type: 'response.created',
    response: { id: 'response-result' },
  })
  frontend.handleLifecycle({
    type: 'response.done',
    response: { id: 'response-result', status: 'completed' },
  })
  assert.deepEqual(await outcome, {
    completed: true,
    responseId: 'response-result',
    contextInjected: true,
  })
})

test('cancelling a response before response.created releases its queue entry', async () => {
  const frontend = createQwenFrontend()
  frontend.ready = true
  frontend.send = () => {}

  const outcome = frontend.speak('稍后播报')
  await new Promise(resolve => setImmediate(resolve))
  frontend.cancel()

  assert.deepEqual(await outcome, {
    cancelled: true,
    phase: 'start',
  })
  assert.equal(frontend.pendingResponses.length, 0)
})

test('cancels only the matching permission response', async () => {
  const frontend = createQwenFrontend()
  const permissionOutcome = Promise.withResolvers()
  const agentOutcome = Promise.withResolvers()
  frontend.pendingResponses.push(
    {
      origin: 'permission',
      context: { authorizationId: 'auth-one' },
      resolve: permissionOutcome.resolve,
      settled: false,
    },
    {
      origin: 'agent',
      context: { taskId: 'work-one' },
      resolve: agentOutcome.resolve,
      settled: false,
    },
  )

  frontend.cancelResponses((context, origin) => (
    origin === 'permission' && context.authorizationId === 'auth-one'
  ))

  assert.deepEqual(await permissionOutcome.promise, {
    cancelled: true,
    phase: 'start',
  })
  assert.equal(frontend.pendingResponses.length, 1)
  assert.equal(frontend.pendingResponses[0].origin, 'agent')
})

test('does not start a permission response resolved during context injection', async () => {
  const frontend = createQwenFrontend()
  frontend.ready = true
  const sent = []
  frontend.send = event => sent.push(event)
  let pending = true
  let releaseItem
  frontend.createConversationItem = () => new Promise(resolve => {
    releaseItem = resolve
  })

  const speaking = frontend.injectPermission({
    id: 'permission-race',
    summary: 'Edit snake.py',
  }, {
    authorizationId: 'permission-race',
  }, {
    shouldSpeak: () => pending,
  })
  await new Promise(resolve => setImmediate(resolve))

  pending = false
  frontend.cancelResponses((context, origin) => (
    origin === 'permission'
    && context.authorizationId === 'permission-race'
  ))
  releaseItem({})
  const outcome = await speaking

  assert.equal(outcome.skipped, true)
  assert.equal(outcome.phase, 'deduplicated')
  assert.equal(
    sent.some(message => message.type === 'response.create'),
    false,
  )
})

test('associates an unscoped provider error with the sole active response', async () => {
  const frontend = createQwenFrontend()
  frontend.ready = true
  frontend.send = () => {}

  const outcome = frontend.speak('测试')
  await new Promise(resolve => setImmediate(resolve))
  frontend.handleLifecycle({
    type: 'response.created',
    response: { id: 'response-error' },
  })
  frontend.handleLifecycle({
    type: 'error',
    error: { message: 'provider failed' },
  })

  assert.deepEqual(await outcome, {
    failed: true,
    responseId: 'response-error',
    status: undefined,
  })
  assert.equal(frontend.activeResponses.size, 0)
})

test('identifies a permission response rejected while the user is speaking', async () => {
  const frontend = createQwenFrontend()
  const sent = []
  frontend.ready = true
  frontend.send = event => sent.push(event)

  const outcome = frontend.injectPermission({
    id: 'auth-speaking',
    summary: '运行游戏',
  }, {
    turnId: 'turn-permission',
    taskId: 'work-permission',
  })
  await new Promise(resolve => setImmediate(resolve))
  frontend.handleLifecycle({
    type: 'conversation.item.created',
    item: { ...sent[0].item, status: 'completed' },
  })
  await new Promise(resolve => setImmediate(resolve))

  const error = {
    type: 'error',
    error: { message: 'Cannot create response while user is speaking.' },
  }
  frontend.handleLifecycle(error)

  assert.equal(error.__voiceOrigin, 'permission')
  assert.deepEqual(error.__voiceContext, {
    turnId: 'turn-permission',
    taskId: 'work-permission',
  })
  assert.equal((await outcome).failed, true)
})
