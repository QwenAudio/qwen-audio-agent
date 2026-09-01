import assert from 'node:assert/strict'
import test from 'node:test'
import { WebSocketServer } from 'ws'
import { config } from '../src/core/config.mjs'
import {
  buildFrontendInstructions,
  describeActiveRealtime,
  REALTIME_PROVIDERS,
  RealtimeFrontend,
  realtimeEventErrorMessage,
  SPAWN_THINKING_TOOL_NAME,
  TOOLS,
} from '../src/voice/realtime-provider.mjs'
import { validateRealtimeProvider } from '../src/voice/providers/registry.mjs'
import { permissionReference } from '../src/voice/tools/permission-reference.mjs'
import {
  DASHSCOPE_AUDIO_FLASH_REALTIME_MODEL,
  DASHSCOPE_OMNI_FLASH_REALTIME_MODEL,
  DASHSCOPE_OMNI_PLUS_REALTIME_MODEL,
  DEFAULT_DASHSCOPE_REALTIME_MODEL,
} from '../../shared/realtime-provider-catalog.mjs'

const FRONTEND_TOOL_NAMES = [
  'spawn_thinking',
  'schedule_reminder',
  'cancel_agent_task',
  'get_agent_task_status',
  'get_current_time',
  'memory',
  'notes',
]

test('keeps spawn_thinking as the stable asynchronous work protocol', () => {
  assert.equal(SPAWN_THINKING_TOOL_NAME, 'spawn_thinking')
  assert.equal(
    TOOLS.filter(tool => (
      tool.function.name === SPAWN_THINKING_TOOL_NAME
    )).length,
    1,
  )
  const spawn = TOOLS.find(tool => (
    tool.function.name === SPAWN_THINKING_TOOL_NAME
  ))
  assert.deepEqual(spawn.function.parameters.required, ['objective'])
  assert.equal(spawn.function.parameters.properties.input_refs.type, 'array')
  assert.equal(spawn.function.parameters.properties.input_refs.maxItems, 8)
  assert.match(
    spawn.function.parameters.properties.objective.description,
    /忠实、完整且自包含地转达用户要做什么及其明确约束/,
  )
  assert.ok(spawn.function.description.trim())
  assert.match(spawn.function.description, /用户补充信息、作出选择或确认后继续/)
  const instructions = buildFrontendInstructions()
  assert.match(instructions, /不要重复提交已经覆盖的目标/)
  assert.match(instructions, /把回答交回请求中的同一项工作/)
  assert.match(instructions, /不支持结构化输入请求的旧后台.*既有工作的续办/s)
  assert.match(instructions, /不要预测、模拟或代替后台提出权限请求/)
  assert.match(instructions, /duplicate.*同一目标此前已提交/)
})

function createQwenFrontend(options = {}) {
  return new RealtimeFrontend({
    provider: REALTIME_PROVIDERS.qwen,
    ...options,
  })
}

test('projects input parts through the realtime provider boundary', () => {
  const frontend = createQwenFrontend()
  const projection = frontend.projectUserInput([
    { type: 'text', text: '[Image 1] 这是什么？' },
    {
      type: 'file',
      mime: 'image/png',
      filename: 'cat.png',
      url: 'data:image/png;base64,aGVsbG8=',
      source: { type: 'clipboard', text: { value: '[Image 1]' } },
      _meta: { 'qwen-audio-agent/inputRef': 'input_1' },
    },
  ])
  const text = projection.conversationItem.content[0].text

  assert.match(text, /\[Image 1\] 这是什么？/)
  assert.match(text, /"id":"input_1"/)
  assert.match(text, /"type":"file"/)
  assert.match(text, /"source":\{"type":"clipboard","text":\{"value":"\[Image 1\]"\}\}/)
  assert.match(text, /"mime":"image\/png"/)
  assert.doesNotMatch(text, /aGVsbG8=/)
})

test('rejects a provider error before the realtime session becomes ready', () => {
  const frontend = createQwenFrontend()

  assert.throws(
    () => frontend.handleProviderEvent({
      type: 'error',
      error: {
        code: 'InvalidApiKey',
        message: 'Invalid API-key provided.',
      },
    }),
    /InvalidApiKey: Invalid API-key provided/,
  )
  assert.equal(frontend.ready, false)
})

test('preserves provider error codes in the user-facing realtime error', () => {
  assert.equal(realtimeEventErrorMessage({
    type: 'error',
    error: {
      code: 'AllocationQuota.FreeTierOnly',
      type: 'insufficient_quota',
      message: 'The free tier of the model has been exhausted.',
    },
  }), 'AllocationQuota.FreeTierOnly: insufficient_quota: The free tier of the model has been exhausted.')
})

test('classifies non-recoverable DashScope account errors as fatal', () => {
  const provider = REALTIME_PROVIDERS.qwen
  for (const message of [
    'InvalidApiKey: Invalid API-key provided.',
    'Arrearage: Access denied, please make sure your account is in good standing.',
    'AllocationQuota.FreeTierOnly: The free tier of the model has been exhausted.',
    'Free allocated quota exceeded.',
    'Unexpected server response: 401',
  ]) {
    assert.equal(provider.classifyError(message), 'fatal', message)
  }
  assert.equal(
    provider.classifyError('You exceeded your current quota, please check your plan.'),
    'other',
  )
})

test('classifies DashScope content inspection errors for clean-session recovery', () => {
  const provider = REALTIME_PROVIDERS.qwen
  for (const message of [
    'DataInspectionFailed: Input or output data may contain inappropriate content.',
    'IPInfringementSuspect: The input may violate content policy.',
    'content_filter: response blocked by content safety',
  ]) {
    assert.equal(provider.classifyError(message), 'content_safety', message)
  }
})

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
  const frontend = createQwenFrontend()
  frontend.ready = true
  let waitingAfterCreated = false
  frontend.send = event => {
    if (event.type !== 'response.create') return
    const requestId = frontend.pendingResponses[0].requestId
    frontend.handleLifecycle({
      type: 'response.created',
      response: {
        id: 'response-1',
        metadata: { qwen_audio_request_id: requestId },
      },
    })
    waitingAfterCreated = frontend.responseWaiters.has('response-1')
    frontend.handleLifecycle({
      type: 'response.done',
      response: { id: 'response-1', status: 'completed' },
    })
  }

  const outcome = frontend.speak('任务完成', 'agent', {
    turnId: 'voice-100-1',
    taskId: 'job-1',
  })

  assert.deepEqual(await outcome, {
    completed: true,
    responseId: 'response-1',
  })
  assert.equal(waitingAfterCreated, true)
})

test('keeps a long response alive while output activity continues', async () => {
  const frontend = createQwenFrontend({
    responseStartTimeoutMs: 100,
    responseInactivityTimeoutMs: 80,
  })
  frontend.ready = true
  const sent = []
  frontend.send = event => sent.push(event)

  const outcome = frontend.speak('一段持续时间较长的语音回复')
  await new Promise(resolve => setImmediate(resolve))
  frontend.handleLifecycle({
    type: 'response.created',
    response: { id: 'response-long' },
  })
  await new Promise(resolve => setTimeout(resolve, 50))
  frontend.handleLifecycle({
    type: 'response.audio.delta',
    response_id: 'response-long',
    delta: 'audio-one',
  })
  await new Promise(resolve => setTimeout(resolve, 50))
  frontend.handleLifecycle({
    type: 'response.audio_transcript.delta',
    response_id: 'response-long',
    delta: '仍在输出',
  })
  await new Promise(resolve => setTimeout(resolve, 50))
  frontend.handleLifecycle({
    type: 'response.done',
    response: { id: 'response-long', status: 'completed' },
  })

  assert.deepEqual(await outcome, {
    completed: true,
    responseId: 'response-long',
  })
  assert.doesNotMatch(
    sent.map(event => event.type).join(','),
    /response\.cancel/,
  )
})

test('cancels and diagnoses a response only after output becomes inactive', async () => {
  const diagnostics = []
  const frontend = createQwenFrontend({
    responseStartTimeoutMs: 100,
    responseInactivityTimeoutMs: 10,
    onDiagnostic: diagnostic => diagnostics.push(diagnostic),
  })
  frontend.ready = true
  const sent = []
  frontend.send = event => sent.push(event)

  const outcome = frontend.speak('这次响应会停止输出')
  await new Promise(resolve => setImmediate(resolve))
  frontend.handleLifecycle({
    type: 'response.created',
    response: { id: 'response-stalled' },
  })

  assert.deepEqual(await outcome, {
    timedOut: true,
    phase: 'inactivity',
    responseId: 'response-stalled',
  })
  assert.equal(sent.at(-1).type, 'response.cancel')
  assert.equal(diagnostics.length, 1)
  assert.equal(diagnostics[0].event, 'realtime.response_timeout')
  assert.equal(diagnostics[0].provider, 'dashscope')
  assert.equal(diagnostics[0].responseId, 'response-stalled')
  assert.equal(diagnostics[0].phase, 'inactivity')
  assert.ok(diagnostics[0].inactivityMs >= 10)
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
  const permissionSession = REALTIME_PROVIDERS.qwen.buildSession({
    configured: false,
    agentContext: {
      frontend: { capabilities: ['permission.respond'] },
    },
  })
  const permissionTool = permissionSession.tools.find(tool => (
    tool.function.name === 'respond_permission'
  ))

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
    permissionTool.function.parameters.required,
    ['permission_id', 'decision'],
  )
  assert.deepEqual(
    permissionTool.function.parameters.properties.decision.enum,
    ['once', 'always', 'reject'],
  )
  assert.match(
    permissionTool.function.description,
    /普通肯定表达选择 once.*以后都允许时选择 always/,
  )
})

test('resolves exact DashScope model profiles for sessions and responses', t => {
  const originalModel = config.audioModel
  const originalVoice = config.audioVoice
  t.after(() => {
    config.audioModel = originalModel
    config.audioVoice = originalVoice
  })

  for (const [model, label, family, voice, turnDetection] of [
    [
      DASHSCOPE_OMNI_FLASH_REALTIME_MODEL,
      'Qwen3.5 Omni Flash Realtime',
      'omni',
      'Ethan',
      { type: 'semantic_vad' },
    ],
    [
      DASHSCOPE_OMNI_PLUS_REALTIME_MODEL,
      'Qwen3.5 Omni Plus Realtime',
      'omni',
      'Ethan',
      { type: 'semantic_vad' },
    ],
    [
      DEFAULT_DASHSCOPE_REALTIME_MODEL,
      'Qwen Audio 3.0 Realtime Plus',
      'audio',
      'longanqian',
      { type: 'smart_turn' },
    ],
  ]) {
    config.audioModel = model
    config.audioVoice = ''
    const profile = REALTIME_PROVIDERS.qwen.modelProfile()
    const session = REALTIME_PROVIDERS.qwen.buildSession({ configured: false })

    assert.equal(profile.id, model)
    assert.equal(profile.label, label)
    assert.equal(profile.family, family)
    assert.equal(profile.sessionDefaults.voice, voice)
    assert.equal(
      createQwenFrontend().capabilities.conversationItemIdEcho,
      family !== 'omni',
    )
    assert.equal(session.voice, voice)
    assert.deepEqual(profile.sessionDefaults.turnDetection, turnDetection)
    assert.deepEqual(session.turn_detection, turnDetection)
    assert.deepEqual(session.modalities, ['text', 'audio'])
    assert.deepEqual(
      REALTIME_PROVIDERS.qwen.buildSpeakResponse('完成').modalities,
      ['text', 'audio'],
    )
  }
})

test('prefers the selected DashScope family voice override over the profile default', t => {
  const originalModel = config.audioModel
  const originalVoice = config.audioVoice
  t.after(() => {
    config.audioModel = originalModel
    config.audioVoice = originalVoice
  })

  config.audioModel = DASHSCOPE_OMNI_PLUS_REALTIME_MODEL
  config.audioVoice = 'custom-omni'
  assert.equal(
    REALTIME_PROVIDERS.qwen.buildSession({ configured: false }).voice,
    'custom-omni',
  )
})

test('prefers a per-session output voice over the process-wide default', t => {
  const originalModel = config.audioModel
  const originalVoice = config.audioVoice
  t.after(() => {
    config.audioModel = originalModel
    config.audioVoice = originalVoice
  })

  config.audioModel = DEFAULT_DASHSCOPE_REALTIME_MODEL
  config.audioVoice = 'longanqian'

  const session = REALTIME_PROVIDERS.qwen.buildSession({
    configured: false,
    sessionOptions: { voice: 'longanlufeng' },
  })

  assert.equal(session.voice, 'longanlufeng')
})

test('advertises Omni model vision without admitting unsupported visual transport', t => {
  const originalModel = config.audioModel
  t.after(() => {
    config.audioModel = originalModel
  })
  config.audioModel = DASHSCOPE_OMNI_PLUS_REALTIME_MODEL

  const profile = REALTIME_PROVIDERS.qwen.modelProfile()
  const frontend = createQwenFrontend()

  assert.equal(profile.modelCapabilities.imageInput, true)
  assert.equal(profile.modelCapabilities.videoInput, false)
  assert.equal(profile.transportCapabilities.imageInput, false)
  assert.equal(profile.transportCapabilities.observationInput, false)
  assert.equal(profile.transportCapabilities.nativeVideoInput, false)
  assert.equal(frontend.modelProfile, profile)
  assert.equal(frontend.modelCapabilities, profile.modelCapabilities)
  assert.equal(frontend.transportCapabilities, profile.transportCapabilities)
})

test('fails closed for an unknown DashScope model without inferring Omni behavior', t => {
  const originalModel = config.audioModel
  t.after(() => {
    config.audioModel = originalModel
  })
  config.audioModel = 'qwen3.5-omni-plus-realtime-future'

  const profile = REALTIME_PROVIDERS.qwen.modelProfile()
  const session = REALTIME_PROVIDERS.qwen.buildSession({ configured: false })

  assert.equal(profile.family, 'unknown')
  assert.deepEqual(Object.values(profile.modelCapabilities), Array(7).fill(false))
  assert.deepEqual(Object.values(profile.transportCapabilities), Array(5).fill(false))
  assert.deepEqual(session.modalities, [])
  assert.deepEqual(
    REALTIME_PROVIDERS.qwen.buildSpeakResponse('完成').modalities,
    [],
  )
})

test('rejects an unknown DashScope model before opening its WebSocket', async t => {
  const originalModel = config.audioModel
  t.after(() => {
    config.audioModel = originalModel
  })
  config.audioModel = 'qwen3.5-omni-flash-realtime-future'
  const frontend = createQwenFrontend()

  await assert.rejects(
    frontend.connect(),
    /不支持的 Realtime 模型.*qwen3\.5-omni-flash-realtime-future.*Qwen-Audio-Realtime/,
  )
  assert.equal(frontend.ws, null)
})

test('rejects malformed optional realtime model profiles', () => {
  const base = REALTIME_PROVIDERS.qwen
  const valid = base.modelProfile()
  const malformedProfiles = [
    {},
    { ...valid, id: '' },
    { ...valid, label: '' },
    { ...valid, family: '' },
    {
      ...valid,
      modelCapabilities: {
        ...valid.modelCapabilities,
        imageInput: 'yes',
      },
    },
    {
      ...valid,
      transportCapabilities: {
        ...valid.transportCapabilities,
        observationInput: undefined,
      },
    },
    { ...valid, sessionDefaults: null },
    { ...valid, sessionDefaults: { voice: 1, turnDetection: null } },
    { ...valid, sessionDefaults: { voice: '  ', turnDetection: null } },
    { ...valid, sessionDefaults: { voice: null, turnDetection: {} } },
    { ...valid, sessionDefaults: { voice: null, turnDetection: { type: '  ' } } },
  ]

  for (const profile of malformedProfiles) {
    assert.throws(
      () => validateRealtimeProvider({
        ...base,
        key: 'malformed-profile',
        modelProfile: () => profile,
      }),
      /modelProfile/,
    )
  }
  assert.doesNotThrow(() => validateRealtimeProvider({
    ...base,
    key: 'null-profile',
    modelProfile: () => null,
  }))
  const { modelProfile: _modelProfile, ...withoutProfile } = base
  assert.doesNotThrow(() => validateRealtimeProvider({
    ...withoutProfile,
    key: 'profile-optional',
  }))
})

test('publishes the active DashScope profile without assigning one to s2s', t => {
  const originalModel = config.audioModel
  const originalApiKey = config.dashscopeApiKey
  t.after(() => {
    config.audioModel = originalModel
    config.dashscopeApiKey = originalApiKey
  })
  config.audioModel = DASHSCOPE_OMNI_FLASH_REALTIME_MODEL
  config.dashscopeApiKey = 'configured-for-provider-list-test'

  const active = describeActiveRealtime('dashscope')

  assert.equal(active.modelProfile.id, DASHSCOPE_OMNI_FLASH_REALTIME_MODEL)
  assert.equal(active.label, 'Qwen-Audio-Realtime')
  assert.equal(active.modelProfile.label, 'Qwen3.5 Omni Flash Realtime')
  assert.equal(active.modelCapabilities.imageInput, true)
  assert.equal(active.transportCapabilities.imageInput, false)
  assert.equal(
    active.providers.find(provider => provider.key === 'dashscope')?.label,
    'Qwen-Audio-Realtime',
  )
  assert.deepEqual(
    active.providers.find(provider => provider.key === 'dashscope')
      ?.realtimeModelIds,
    [
      DASHSCOPE_OMNI_FLASH_REALTIME_MODEL,
      DASHSCOPE_OMNI_PLUS_REALTIME_MODEL,
      DEFAULT_DASHSCOPE_REALTIME_MODEL,
      DASHSCOPE_AUDIO_FLASH_REALTIME_MODEL,
    ],
  )
  assert.equal(REALTIME_PROVIDERS['speech-to-speech'].modelProfile, undefined)
  const s2s = describeActiveRealtime('speech-to-speech')
  assert.equal(s2s.modelProfile, null)
  assert.deepEqual(s2s.modelCatalog, [])
})

test('client text-only hints do not change the Qwen Realtime session', () => {
  const session = REALTIME_PROVIDERS.qwen.buildSession({
    configured: false,
    agentContext: { textOnly: true },
  })

  assert.deepEqual(session.modalities, ['text', 'audio'])
  assert.deepEqual(session.turn_detection, { type: 'smart_turn' })
  assert.deepEqual(
    REALTIME_PROVIDERS.qwen
      .buildSpeakResponse('完成', { textOnly: true })
      .modalities,
    ['text', 'audio'],
  )
  assert.deepEqual(
    REALTIME_PROVIDERS.qwen
      .buildResultInjection('结果', { textOnly: true })
      .response.modalities,
    ['text', 'audio'],
  )
})

test('offers the sleep tool only to a client that advertises the action', () => {
  const ordinary = REALTIME_PROVIDERS.qwen.buildSession({
    configured: false,
    agentContext: { client: { actions: [] } },
  })
  const desktop = REALTIME_PROVIDERS.qwen.buildSession({
    configured: false,
    agentContext: { client: { actions: ['desktop.presence.enter_sleep'] } },
  })
  const s2sDesktop = REALTIME_PROVIDERS['speech-to-speech'].buildSession({
    agentContext: { client: { actions: ['desktop.presence.enter_sleep'] } },
  })

  assert.equal(
    ordinary.tools.some(tool => tool.function.name === 'enter_sleep'),
    false,
  )
  assert.equal(
    desktop.tools.some(tool => tool.function.name === 'enter_sleep'),
    true,
  )
  const sleepTool = desktop.tools.find(
    tool => tool.function.name === 'enter_sleep',
  )
  assert.match(sleepTool.function.description, /必须立即调用/)
  assert.match(sleepTool.function.description, /不要只口头回应/)
  assert.equal(
    s2sDesktop.tools.some(tool => tool.name === 'enter_sleep'),
    true,
  )
})

test('projects dynamic frontend tools into each realtime protocol shape', () => {
  const dynamic = {
    type: 'function',
    function: {
      name: 'mcp__documents__search',
      description: 'Search configured documents.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
      },
    },
  }
  const agentContext = { frontend: { tools: [dynamic] } }
  const qwen = REALTIME_PROVIDERS.qwen.buildSession({
    configured: false,
    agentContext,
  })
  const s2s = REALTIME_PROVIDERS['speech-to-speech'].buildSession({
    agentContext,
  })

  assert.deepEqual(qwen.tools.at(-1), dynamic)
  assert.deepEqual(s2s.tools.at(-1), {
    type: 'function',
    name: dynamic.function.name,
    description: dynamic.function.description,
    parameters: dynamic.function.parameters,
  })
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

test('uses a trusted session Assistant Profile without changing core policy', () => {
  const prompt = buildFrontendInstructions({
    assistantProfile: '# Identity\n\n你是当前会话的行动派座舱伙伴。',
  })

  assert.match(prompt, /<assistant_profile authority="persona_only">[\s\S]*行动派座舱伙伴/u)
  assert.doesNotMatch(prompt, /默认自然、直接、可靠/u)
  assert.match(prompt, /与用户进行全双工语音交互的统一助手/u)
  assert.match(prompt, /工具 description 和 schema 是各项能力的调用契约/u)
})

test('builds cache-friendly policy, identity, memory and reconnect context', () => {
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

  assert.match(prompt, /千问Audio/)
  assert.match(prompt, /与用户进行全双工语音交互的统一助手/)
  assert.match(prompt, /不要把自己描述成前台模型、后台模型/)
  assert.match(prompt, /Asia\/Shanghai/)
  assert.doesNotMatch(prompt, /2026年7月23日|session_start_local/)
  assert.match(prompt, /<user_preferences>[\s\S]*用户希望被称为小明/)
  assert.doesNotMatch(prompt, /我们刚才在讨论下载目录/)
  assert.match(prompt, /用户要求记住、修改或遗忘长期信息/)
  assert.match(prompt, /必须调用 `memory`/)
  assert.match(prompt, /不要只在当前对话中\s*临时遵从/)
  assert.match(prompt, /纠正本身就是\s*持久修改/)
  assert.match(prompt, /不要要求用户额外说“记住”或“以后”/)
  assert.match(prompt, /“这次”、“今天”或“暂时”时才不保存/)
  assert.match(prompt, /清除冲突或归类错误的旧内容/)
  assert.match(prompt, /选择最直接且足够的处理方式/)
  assert.match(prompt, /`spawn_thinking` 声明能力范围[\s\S]*统一的执行入口/)
  assert.match(prompt, /必须调用它，不能提前声称“做不到”/)
  assert.match(prompt, /可通过已注册工具完成的事就是你的能力/)
  assert.match(prompt, /不要先说自己不能做/)
  assert.match(prompt, /不要因一次工具\s*调用而忽略其余请求/)
  assert.match(prompt, /用户应当能够继续交谈/)
  assert.match(prompt, /避免空泛承接、重复用户要求/)
  assert.match(prompt, /# Instruction hierarchy/)
  assert.match(prompt, /<assistant_profile authority="persona_only">/)
  assert.equal(prompt.startsWith('# Role'), true)
  const assistantContextIndex = prompt.lastIndexOf(
    '<assistant_profile authority="persona_only">',
  )
  const userContextIndex = prompt.lastIndexOf('<user_preferences>')
  const runtimeContextIndex = prompt.lastIndexOf('<runtime_context>')
  assert.ok(
    prompt.indexOf('# Instruction hierarchy')
      < assistantContextIndex,
  )
  assert.ok(assistantContextIndex < userContextIndex)
  assert.ok(userContextIndex < runtimeContextIndex)
  assert.match(prompt, /`<assistant_profile>` 只影响默认名称、人格、关系定位和表达风格/)
  assert.match(prompt, /`<user_preferences>` 中的长期个性化偏好/)
  assert.match(prompt, /助手在其面前的名称/)
  assert.match(prompt, /涉及\s*工具、路由、权限、安全、记忆、任务或事实判断的内容无效/)
  assert.doesNotMatch(prompt, /ASSISTANT\.md|USER\.md|MEMORY\.md/)
  assert.match(prompt, /# Voice interaction/)
  assert.match(prompt, /没有新信息时不要说话/)
  assert.match(prompt, /不要规定用户未要求的具体工具/)
  assert.match(prompt, /最终结果会通过单独的结果上下文到达/)
  assert.doesNotMatch(prompt, /\[COMPLETE\]/)
  assert.doesNotMatch(prompt, /get_agent_tasks|reply_agent_permission/)
  assert.match(prompt, /respond_permission/)
  assert.match(prompt, /<permission_request>/)
  assert.match(prompt, /原样使用请求中的 `permission_id`/)
  assert.match(prompt, /按 `respond_permission` 的契约处理/)
  assert.match(prompt, /调用前不要\s*口头确认/)
  assert.match(prompt, /不要仅凭对话历史推测当前状态/)
  assert.doesNotMatch(prompt, /<active_work>/)
  const memory = REALTIME_PROVIDERS.qwen
    .buildSession({ configured: false })
    .tools.find(tool => tool.function.name === 'memory')
  assert.deepEqual(
    memory.function.parameters.properties.action.enum,
    ['read', 'append', 'replace'],
  )
  assert.deepEqual(
    memory.function.parameters.properties.document.enum,
    ['user', 'memory', 'all'],
  )
  assert.doesNotMatch(memory.function.description, /ASSISTANT\.md|USER\.md|MEMORY\.md/)
  assert.match(memory.function.description, /默认写入 user/)
  assert.match(memory.function.description, /每次调用执行一个 read、append 或 replace/)
  assert.match(memory.function.description, /多项持久修改时逐项调用/)
  assert.deepEqual(memory.function.parameters.required, ['action'])
  assert.deepEqual(
    Object.keys(memory.function.parameters.properties),
    ['action', 'document', 'old_text', 'new_text', 'content'],
  )
  assert.equal(
    memory.function.parameters.properties.old_text.type,
    'string',
  )

  const notes = REALTIME_PROVIDERS.qwen
    .buildSession({ configured: false })
    .tools.find(tool => tool.function.name === 'notes')
  assert.deepEqual(
    notes.function.parameters.properties.action.enum,
    ['lists', 'show', 'add', 'remove', 'clear', 'drop'],
  )
  assert.match(notes.function.description, /破坏性操作/)
  assert.deepEqual(notes.function.parameters.required, ['action'])

  const spawnThinking = REALTIME_PROVIDERS.qwen
    .buildSession({ configured: false })
    .tools.find(tool => (
      tool.function.name === SPAWN_THINKING_TOOL_NAME
    ))
  assert.ok(spawnThinking.function.description.trim())
  assert.match(
    spawnThinking.function.parameters.properties.objective.description,
    /忠实、完整且自包含地转达用户要做什么及其明确约束/,
  )
  assert.match(
    spawnThinking.function.parameters.properties.objective.description,
    /后台不会收到前台的完整对话、个性化偏好或长期记忆/,
  )
  const status = REALTIME_PROVIDERS.qwen
    .buildSession({ configured: false })
    .tools.find(tool => tool.function.name === 'get_agent_task_status')
  assert.equal(
    status.function.parameters.properties.list_all.type,
    'boolean',
  )
  assert.match(status.function.description, /列出当前会话中的工作、定时任务和提醒/)
  const cancel = REALTIME_PROVIDERS.qwen
    .buildSession({ configured: false })
    .tools.find(tool => tool.function.name === 'cancel_agent_task')
  assert.match(cancel.function.description, /定时任务或提醒/)
  assert.match(cancel.function.description, /先调用 get_agent_task_status/)
  assert.match(cancel.function.parameters.properties.task_id.description, /task_id/)
  assert.equal(cancel.function.parameters.properties.all.type, 'boolean')
  assert.match(
    cancel.function.parameters.properties.all.description,
    /取消当前会话中的全部工作/,
  )
  const permission = REALTIME_PROVIDERS.qwen.buildPermissionInjection({
    id: 'permission-one',
    taskId: 'task_42',
    summary: '查看系统内存',
  })
  const permissionText = permission.item.content[0].text
  assert.match(permissionText, new RegExp(`permission_id=${permissionReference('permission-one')}`))
  assert.match(permissionText, /task_id=task_42/)
  assert.doesNotMatch(permissionText, /authorization_id/)
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
      recentMessages: [{ role: 'user', content: '只在恢复连接时注入的历史' }],
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
  assert.match(sent[0].session.instructions, /<user_preferences>[\s\S]*用户希望被称为新称呼/)
  assert.doesNotMatch(sent[0].session.instructions, /旧称呼/)
  assert.doesNotMatch(sent[0].session.instructions, /只在恢复连接时注入的历史/)
})

test('keeps the live session untouched when refreshSession is false', async () => {
  // instructions 是 prompt 前缀的一部分，重发 session.update 等于换前缀，会让
  // 整场会话已经建立的前缀缓存失效。所以「更新了上下文但不需要本轮就生效」的
  // 调用方要能只写缓存、不动会话。
  const frontend = createQwenFrontend({
    agentContext: {
      client: { timeZone: 'Asia/Shanghai', locale: 'zh-CN' },
      memories: [{ scope: 'profile', content: '旧的记忆' }],
    },
  })
  const sent = []
  frontend.ready = true
  frontend.sessionConfigured = true
  frontend.send = payload => sent.push(payload)

  frontend.updateAgentContext(
    { memories: [{ scope: 'profile', content: '新的记忆' }] },
    { refreshSession: false },
  )
  await frontend.outputQueue

  assert.deepEqual(sent, [], '不该重发 session.update')
  // 缓存要更新到位：下一次自然的 session.update 必须带上新内容，
  // 否则这个开关就变成了「丢掉这次更新」。
  frontend.updateAgentContext({})
  await frontend.outputQueue
  assert.equal(sent[0].type, 'session.update')
  assert.match(sent[0].session.instructions, /新的记忆/)
  assert.doesNotMatch(sent[0].session.instructions, /旧的记忆/)
})

test('restores recent conversation once after configuring a fresh session', () => {
  const frontend = createQwenFrontend({
    agentContext: {
      recentMessages: [{ role: 'user', content: '恢复用的近期对话' }],
    },
  })
  const sent = []
  frontend.send = payload => sent.push(payload)

  frontend.handleProviderEvent({ type: 'session.created' })
  assert.equal(sent[0].type, 'session.update')
  assert.doesNotMatch(sent[0].session.instructions, /恢复用的近期对话/)

  frontend.handleProviderEvent({ type: 'session.updated' })
  assert.equal(sent[1].type, 'conversation.item.create')
  assert.match(sent[1].item.content[0].text, /恢复用的近期对话/)
  assert.match(sent[1].item.content[0].text, /不是用户的新请求/)

  frontend.handleProviderEvent({ type: 'session.updated' })
  assert.equal(sent.length, 2)
})

test('restores recent conversation through the shared GA session lifecycle', () => {
  const frontend = createS2sFrontend({
    agentContext: {
      recentMessages: [{ role: 'assistant', content: '此前正在处理项目' }],
    },
  })
  const sent = []
  frontend.send = payload => sent.push(payload)

  frontend.handleProviderEvent({ type: 'session.created' })

  assert.equal(sent[0].type, 'session.update')
  assert.doesNotMatch(sent[0].session.instructions, /此前正在处理项目/)
  assert.equal(sent[1].type, 'conversation.item.create')
  assert.match(sent[1].item.id, /^msg_[0-9a-f]{32}$/)
  assert.match(sent[1].item.content[0].text, /此前正在处理项目/)
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

test('accepts an Omni conversation item receipt with a provider-assigned id', async () => {
  const frontend = createQwenFrontend({
    provider: {
      ...REALTIME_PROVIDERS.qwen,
      capabilities: {
        ...REALTIME_PROVIDERS.qwen.capabilities,
        conversationItemIdEcho: false,
      },
    },
  })
  const sent = []
  frontend.ready = true
  frontend.send = event => sent.push(event)

  const created = frontend.createConversationItem({
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: 'hi' }],
  })
  frontend.handleLifecycle({
    type: 'conversation.item.created',
    item: { id: 'item_provider_assigned', type: 'message', role: 'user' },
  })

  assert.equal((await created).id, 'item_provider_assigned')
  assert.notEqual(sent[0].item.id, 'item_provider_assigned')
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

test('can force one model response with ephemeral instructions', async () => {
  const frontend = createQwenFrontend({
    responseStartTimeoutMs: 50,
    responseCompletionTimeoutMs: 50,
  })
  const sent = []
  frontend.ready = true
  frontend.send = payload => sent.push(payload)

  const outcome = frontend.ensureResponse(
    { turnId: 'permission-turn' },
    {
      shouldCreate: () => true,
      response: {
        instructions: '重新判断是否需要调用工具。',
        modalities: ['text'],
      },
    },
  )
  await new Promise(resolve => setImmediate(resolve))

  assert.deepEqual(sent, [{
    type: 'response.create',
    response: {
      instructions: '重新判断是否需要调用工具。',
      modalities: ['text'],
    },
  }])
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

test('injects AgentDelivery context without creating a realtime response', async () => {
  const frontend = createQwenFrontend({ responseStartTimeoutMs: 50 })
  const sent = []
  frontend.ready = true
  frontend.send = payload => sent.push(payload)

  const outcome = frontend.injectDelivery(
    '客户端环境已变化。',
    'client-event',
    { clientEventId: 'event-1' },
    { route: 'context' },
  )
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(sent.map(event => event.type), ['conversation.item.create'])
  frontend.handleLifecycle({
    type: 'conversation.item.created',
    item: { ...sent[0].item, status: 'completed' },
  })
  assert.deepEqual(await outcome, {
    completed: true,
    contextInjected: true,
    route: 'context',
  })
  assert.deepEqual(sent.map(event => event.type), ['conversation.item.create'])
})

test('can expose permission context before its response queue becomes idle', async () => {
  const frontend = createQwenFrontend({
    responseStartTimeoutMs: 50,
    responseCompletionTimeoutMs: 50,
  })
  const sent = []
  frontend.ready = true
  frontend.send = payload => sent.push(payload)
  frontend.activeResponses.add('response-active')

  const outcome = frontend.injectDelivery(
    '<permission_request>operation=test</permission_request>',
    'permission',
    { authorizationId: 'permission-1' },
    { route: 'respond', contextTiming: 'immediate' },
  )
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(sent.map(event => event.type), ['conversation.item.create'])
  frontend.handleLifecycle({
    type: 'conversation.item.created',
    item: { ...sent[0].item, status: 'completed' },
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(sent.map(event => event.type), ['conversation.item.create'])

  frontend.handleLifecycle({
    type: 'response.done',
    response: { id: 'response-active', status: 'completed' },
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(sent[1].type, 'response.create')
  frontend.handleLifecycle({
    type: 'response.created',
    response: { id: 'response-permission' },
  })
  frontend.handleLifecycle({
    type: 'response.done',
    response: { id: 'response-permission', status: 'completed' },
  })
  assert.equal((await outcome).contextInjected, true)
})

test('keeps tool policy provider-neutral for all result-injection providers', () => {
  for (const provider of [REALTIME_PROVIDERS.qwen, REALTIME_PROVIDERS.s2s]) {
    assert.equal(
      provider.buildResultInjection('event', { allowTools: true }).response.tool_choice,
      'auto',
    )
    assert.equal(
      provider.buildResultInjection('event').response.tool_choice,
      'none',
    )
  }
})

test('injects progress with response-scoped presentation instructions', async () => {
  const frontend = createQwenFrontend({
    responseStartTimeoutMs: 50,
    responseCompletionTimeoutMs: 50,
  })
  const sent = []
  frontend.ready = true
  frontend.send = payload => sent.push(payload)

  const outcome = frontend.injectResult(
    '<background_work_progress>正在整理来源</background_work_progress>',
    'progress',
    { taskId: 'task-progress', turnId: null },
    { instructions: '只简短播报阶段进展，不要说已经完成。' },
  )
  await new Promise(resolve => setImmediate(resolve))
  frontend.handleLifecycle({
    type: 'conversation.item.created',
    item: { ...sent[0].item, status: 'completed' },
  })
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(
    sent[1].response.instructions,
    '只简短播报阶段进展，不要说已经完成。',
  )
  frontend.handleLifecycle({
    type: 'response.created',
    response: { id: 'response-progress' },
  })
  frontend.handleLifecycle({
    type: 'response.done',
    response: { id: 'response-progress', status: 'completed' },
  })
  assert.equal((await outcome).completed, true)
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

test('cancelling an active response releases queued input without response.done', async () => {
  const frontend = createQwenFrontend({
    responseCancelGraceMs: 1,
    responseStartTimeoutMs: 50,
    responseCompletionTimeoutMs: 50,
  })
  frontend.ready = true
  const sent = []
  frontend.send = event => sent.push(event)

  const interrupted = frontend.speak('旧播报')
  await new Promise(resolve => setImmediate(resolve))
  frontend.handleLifecycle({
    type: 'response.created',
    response: { id: 'response-interrupted' },
  })

  frontend.cancel()
  const next = frontend.sendUserText('你好')
  assert.deepEqual(await interrupted, {
    cancelled: true,
    phase: 'completion',
  })

  await new Promise(resolve => setTimeout(resolve, 5))
  await new Promise(resolve => setImmediate(resolve))
  const item = sent.find(event => (
    event.type === 'conversation.item.create'
    && event.item?.content?.[0]?.text === '你好'
  ))
  assert.ok(item)
  frontend.handleLifecycle({
    type: 'conversation.item.created',
    item: { ...item.item, status: 'completed' },
  })
  await new Promise(resolve => setImmediate(resolve))
  frontend.handleLifecycle({
    type: 'response.created',
    response: { id: 'response-next' },
  })
  frontend.handleLifecycle({
    type: 'response.done',
    response: { id: 'response-next', status: 'completed' },
  })
  assert.deepEqual(await next, {
    completed: true,
    responseId: 'response-next',
  })
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

test('retires a sole automatic response when its provider error has no response id', () => {
  const frontend = createQwenFrontend()
  frontend.ready = true
  frontend.send = () => {}

  frontend.handleLifecycle({
    type: 'response.created',
    response: { id: 'automatic-response-error' },
  })
  const error = {
    type: 'error',
    error: {
      code: 'DataInspectionFailed',
      message: 'Input data may contain inappropriate content.',
    },
  }
  frontend.handleLifecycle(error)

  assert.equal(error.response_id, 'automatic-response-error')
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

test('retries typed input that races the end of a Smart Turn', async () => {
  const frontend = createQwenFrontend()
  const sent = []
  let retried = null
  frontend.ready = true
  frontend.ws = {
    readyState: 1,
    send: value => sent.push(JSON.parse(value)),
  }
  frontend.retryRefusedResponse = pending => {
    retried = pending
    frontend.settlePending(pending, { completed: true, retried: true })
  }

  const outcome = frontend.sendUserText('键盘输入', { turnId: 'text-turn' })
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

  assert.equal(error.__voiceRetried, true)
  assert.equal(retried?.origin, 'model')
  assert.equal(retried?.busyRetries, 1)
  assert.deepEqual(await outcome, { completed: true, retried: true })
})

function createS2sFrontend(options = {}) {
  return new RealtimeFrontend({
    provider: REALTIME_PROVIDERS['speech-to-speech'],
    ...options,
  })
}

test('rewrites response modalities into the GA output_modalities field', () => {
  const frontend = createS2sFrontend()
  const payload = frontend.protocol.responseCreate({
    modalities: ['text', 'audio'],
    tool_choice: 'none',
  })

  assert.deepEqual(payload.response, {
    tool_choice: 'none',
    output_modalities: ['text', 'audio'],
  })
  assert.equal('modalities' in payload.response, false)
})

test('becomes ready after writing session.update when no acknowledgement is expected', () => {
  const frontend = createS2sFrontend()
  const sent = []
  frontend.send = event => sent.push(event)

  const events = frontend.handleProviderEvent({ type: 'session.created' })

  assert.deepEqual(events.map(event => event.type), ['session.created'])
  assert.equal(sent[0].type, 'session.update')
  assert.equal(frontend.ready, true)
})

test('preserves standard input item correlation across DashScope and GA providers', () => {
  const event = {
    type: 'input_audio_buffer.speech_started',
    event_id: 'event-input-1',
    item_id: 'item-input-1',
  }

  for (const frontend of [createQwenFrontend(), createS2sFrontend()]) {
    assert.equal(
      frontend.protocol.normalizeIncoming({ ...event }).item_id,
      'item-input-1',
    )
  }
})

test('namespaces GA conversation item ids by item type', async () => {
  const frontend = createS2sFrontend()
  const sent = []
  frontend.ready = true
  frontend.send = event => sent.push(event)

  const first = frontend.createConversationItem({
    type: 'function_call_output',
    call_id: 'call-1',
    output: '{}',
  })
  frontend.handleProviderEvent({
    type: 'conversation.item.created',
    item: { id: sent[0].item.id },
  })
  await first
  const second = frontend.createConversationItem({
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: 'hi' }],
  })
  frontend.handleProviderEvent({
    type: 'conversation.item.created',
    item: { id: sent[1].item.id },
  })
  await second

  // The GA schema rejects an id from the wrong namespace outright, so the
  // prefix has to match the item type rather than a generic "item_".
  assert.match(sent[0].item.id, /^fco_[0-9a-f]{32}$/)
  assert.match(sent[1].item.id, /^msg_[0-9a-f]{32}$/)
})

test('keeps the beta dialect on a single conversation item id namespace', async () => {
  const frontend = createQwenFrontend()
  const sent = []
  frontend.ready = true
  frontend.send = event => sent.push(event)

  const created = frontend.createConversationItem({
    type: 'function_call_output',
    call_id: 'call-1',
    output: '{}',
  })
  const { id } = sent[0].item
  assert.match(id, /^item_[0-9a-f]{32}$/)

  frontend.handleProviderEvent({
    type: 'conversation.item.created',
    item: { id },
  })
  await created
})

test('normalizes GA text events into the shared transcript event names', () => {
  const frontend = createS2sFrontend()
  const [delta] = frontend.handleProviderEvent({
    type: 'response.output_text.delta',
    delta: '你好',
  })

  assert.equal(delta.type, 'response.text.delta')
  assert.equal(delta.delta, '你好')
})

test('waits for the GA conversation item receipt before creating a response', async () => {
  const frontend = createS2sFrontend()
  const sent = []
  frontend.ready = true
  frontend.send = event => sent.push(event)

  const outcome = frontend.injectResult(
    '任务完成',
    'announcement',
    { turnId: 'turn-1' },
  )
  await new Promise(resolve => setImmediate(resolve))

  assert.deepEqual(sent.map(event => event.type), ['conversation.item.create'])
  frontend.handleProviderEvent({
    type: 'conversation.item.created',
    item: { id: sent[0].item.id },
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(sent.map(event => event.type), [
    'conversation.item.create',
    'response.create',
  ])
  frontend.handleProviderEvent({
    type: 'response.created',
    response: {
      id: 'resp-result',
      metadata: {
        qwen_audio_request_id: frontend.pendingResponses[0].requestId,
      },
    },
  })
  frontend.handleProviderEvent({
    type: 'response.done',
    response: { id: 'resp-result', status: 'completed' },
  })
  assert.equal((await outcome).completed, true)
})

test('retries a response refused by an occupied single response slot', async () => {
  const frontend = createS2sFrontend()
  const sent = []
  const retried = []
  frontend.ready = true
  frontend.send = payload => {
    if (
      payload.type === 'response.create'
      && frontend.pendingResponses.length
    ) {
      frontend.pendingResponses[frontend.pendingResponses.length - 1]
        .responsePayload = payload
    }
    sent.push(payload)
  }
  // The retry itself waits out the in-flight generation, so only the decision
  // to retry is asserted here instead of the delayed replay.
  frontend.retryRefusedResponse = pending => retried.push(pending)

  frontend.speak('结果来了', 'agent', { turnId: 'turn-1' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(sent.filter(e => e.type === 'response.create').length, 1)

  const refusal = {
    type: 'error',
    error: { message: 'Cannot create response while another response is in progress.' },
  }
  frontend.handleLifecycle(refusal)

  // The refusal is handled internally: the gateway must not surface it, and
  // the response is queued for a replay instead of being dropped.
  assert.equal(refusal.__voiceRetried, true)
  assert.equal(retried.length, 1)
  assert.equal(retried[0].busyRetries, 1)
  assert.equal(retried[0].settled, false)
  assert.equal(retried[0].responsePayload.type, 'response.create')
})

test('surfaces a refusal a compliant provider cannot retry', async () => {
  const frontend = createQwenFrontend()
  frontend.ready = true
  frontend.send = () => {}

  const outcome = frontend.speak('结果来了', 'agent', { turnId: 'turn-1' })
  await new Promise(resolve => setImmediate(resolve))
  const refusal = {
    type: 'error',
    error: { message: 'Cannot create response while another response is in progress.' },
  }
  frontend.handleLifecycle(refusal)

  // Without the singleResponseSlot capability the error stays user-facing.
  assert.equal(refusal.__voiceRetried, undefined)
  assert.equal((await outcome).failed, true)
})

test('the Qwen provider exposes its supported realtime capabilities', () => {
  const qwen = createQwenFrontend()

  assert.deepEqual(qwen.capabilities, {
    acknowledgesSessionUpdate: true,
    singleResponseSlot: false,
    responseMetadataCorrelation: false,
    perResponseInstructions: true,
    sessionOutputVoice: true,
    conversationItemIdEcho: true,
  })
})

test('per-response instructions require explicit provider opt-in', () => {
  const { capabilities: _capabilities, ...provider } = REALTIME_PROVIDERS.qwen
  const frontend = new RealtimeFrontend({
    provider: {
      ...provider,
      key: 'unspecified-response-instructions',
    },
  })

  assert.equal(frontend.capabilities.perResponseInstructions, false)
  assert.equal(frontend.capabilities.sessionOutputVoice, false)
})

test('does not correlate an automatic VAD response with a pending GA response', async () => {
  const frontend = createS2sFrontend()
  const sent = []
  const retried = []
  frontend.ready = true
  frontend.ws = {
    readyState: 1,
    send: raw => sent.push(JSON.parse(raw)),
  }
  frontend.retryRefusedResponse = pending => retried.push(pending)

  const outcome = frontend.speak(
    '后台任务完成',
    'announcement',
    { turnId: 'turn-announcement' },
  )
  await new Promise(resolve => setImmediate(resolve))

  const requested = sent.find(event => event.type === 'response.create')
  assert.ok(requested.response.metadata.qwen_audio_request_id)
  assert.equal(frontend.pendingResponses.length, 1)

  const automatic = {
    type: 'response.created',
    response: { id: 'resp-automatic' },
  }
  frontend.handleLifecycle(automatic)

  assert.equal(automatic.__voiceOrigin, 'model')
  assert.deepEqual(automatic.__voiceContext, {})
  assert.equal(frontend.pendingResponses.length, 1)
  assert.equal(frontend.activeResponses.has('resp-automatic'), true)

  const refusal = {
    type: 'error',
    error: {
      message: 'Cannot create response while another response is in progress.',
    },
  }
  frontend.handleLifecycle(refusal)

  assert.equal(refusal.__voiceRetried, true)
  assert.equal(retried.length, 1)
  assert.equal(retried[0].origin, 'announcement')
  frontend.settlePending(retried[0], { cancelled: true })
  assert.equal((await outcome).cancelled, true)
})

test('tracks an implicit response from output activity when response.created is omitted', async () => {
  const frontend = createS2sFrontend()
  frontend.handleLifecycle({
    type: 'response.output_audio_transcript.done',
    response_id: 'resp-implicit',
    transcript: '你好',
  })

  assert.equal(frontend.activeResponses.has('resp-implicit'), true)
  let becameIdle = false
  const idle = frontend.whenIdle().then(() => {
    becameIdle = true
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(becameIdle, false)

  frontend.handleLifecycle({
    type: 'response.done',
    response: { id: 'resp-implicit', status: 'completed' },
  })
  await idle
  assert.equal(frontend.activeResponses.size, 0)
  assert.equal(becameIdle, true)
})

test('correlates an accepted GA response through echoed metadata', async () => {
  const frontend = createS2sFrontend()
  const sent = []
  frontend.ready = true
  frontend.ws = {
    readyState: 1,
    send: raw => sent.push(JSON.parse(raw)),
  }

  const outcome = frontend.speak(
    '后台任务完成',
    'announcement',
    { turnId: 'turn-announcement' },
  )
  await new Promise(resolve => setImmediate(resolve))
  const requestId = sent[0].response.metadata.qwen_audio_request_id
  const created = {
    type: 'response.created',
    response: {
      id: 'resp-announcement',
      metadata: { qwen_audio_request_id: requestId },
    },
  }
  frontend.handleLifecycle(created)

  assert.equal(created.__voiceOrigin, 'announcement')
  assert.equal(created.__voiceContext.turnId, 'turn-announcement')
  assert.equal(frontend.pendingResponses.length, 0)

  frontend.handleLifecycle({
    type: 'response.done',
    response: { id: 'resp-announcement', status: 'completed' },
  })
  assert.equal((await outcome).completed, true)
})

test('retries immediately after a known automatic response becomes idle', async () => {
  const frontend = createS2sFrontend()
  const sent = []
  frontend.ready = true
  frontend.ws = {
    readyState: 1,
    send: raw => sent.push(JSON.parse(raw)),
  }
  frontend.activeResponses.add('resp-automatic')
  frontend.whenIdle = async () => {
    frontend.activeResponses.clear()
  }
  const pending = {
    requestId: 'request-retry',
    responsePayload: frontend.protocol.responseCreate(),
    busyRetries: 1,
    settled: false,
    timer: null,
    resolve: () => {},
  }

  frontend.retryRefusedResponse(pending)
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(sent.length, 1)
  assert.equal(sent[0].type, 'response.create')
  assert.equal(
    sent[0].response.metadata.qwen_audio_request_id,
    pending.requestId,
  )
  frontend.settlePending(pending, { cancelled: true })
})

test('negotiates client audio rates without overriding speech-to-speech models', () => {
  const provider = REALTIME_PROVIDERS['speech-to-speech']
  const session = provider.buildSession({
    agentContext: {},
  })

  assert.equal(provider.key, 'speech-to-speech')
  assert.equal(REALTIME_PROVIDERS.s2s, provider)
  assert.equal(provider.inputSampleRate, 16000)
  assert.equal(provider.outputSampleRate, 24000)
  assert.equal(provider.responseStartTimeoutMs, 60_000)
  assert.equal(createS2sFrontend().responseStartTimeoutMs, 60_000)
  assert.equal(provider.model(), null)
  assert.equal(provider.voice(), null)
  assert.equal(session.audio.input.format, undefined)
  assert.deepEqual(session.audio.output.format, {
    type: 'audio/pcm',
    rate: 24000,
  })
  assert.equal(session.audio.output.voice, undefined)
  assert.equal(session.audio.input.turn_detection.type, 'server_vad')
})

test('classifies a busy speech-to-speech pipeline as retryable capacity', () => {
  const provider = REALTIME_PROVIDERS['speech-to-speech']

  assert.equal(
    provider.classifyError('All 1 session slots are in use. Disconnect an existing client first.'),
    'capacity_busy',
  )
  assert.equal(
    provider.classifyError('session_limit_reached'),
    'capacity_busy',
  )
})

test('creates out-of-band speech responses for speech-to-speech', () => {
  const response = REALTIME_PROVIDERS['speech-to-speech']
    .buildSpeakResponse('任务完成')

  assert.equal(response.conversation, 'none')
  assert.deepEqual(response.modalities, ['audio'])
  assert.equal(response.tool_choice, 'none')
})

test('connects to an OpenAI Realtime-compatible speech-to-speech server', async t => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise(resolve => server.once('listening', resolve))

  let requestHeaders
  const sessionUpdate = new Promise(resolve => {
    server.once('connection', (socket, request) => {
      requestHeaders = request.headers
      socket.on('message', raw => resolve(JSON.parse(raw.toString())))
      socket.send(JSON.stringify({ type: 'session.created' }))
    })
  })
  const address = server.address()
  const frontend = new RealtimeFrontend({
    provider: {
      ...REALTIME_PROVIDERS['speech-to-speech'],
      isConfigured: () => true,
      url: () => `ws://127.0.0.1:${address.port}/v1/realtime`,
    },
  })
  t.after(async () => {
    frontend.close()
    await new Promise(resolve => server.close(resolve))
  })

  await frontend.connect()
  const update = await sessionUpdate

  assert.equal(frontend.ready, true)
  assert.equal(requestHeaders.authorization, undefined)
  assert.equal(update.type, 'session.update')
  assert.equal(update.session.type, 'realtime')
  assert.equal(update.session.audio.input.format, undefined)
  assert.deepEqual(update.session.audio.output.format, {
    type: 'audio/pcm',
    rate: 24000,
  })
})

test('sends provider connection messages before regular realtime traffic', async t => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise(resolve => server.once('listening', resolve))

  const received = []
  const traffic = new Promise(resolve => {
    server.once('connection', socket => {
      socket.on('message', raw => {
        const message = JSON.parse(raw.toString())
        received.push(message)
        if (message.type === 'start') {
          socket.send(JSON.stringify({
            type: 'session.created',
            route: message.route,
          }))
        } else if (message.type === 'session.update') {
          socket.send(JSON.stringify({
            type: 'session.updated',
            route: message.route,
          }))
          resolve()
        }
      })
    })
  })
  const address = server.address()
  let protocolConnectionId = ''
  const frontend = new RealtimeFrontend({
    provider: {
      ...REALTIME_PROVIDERS.qwen,
      key: 'connection-message-test',
      isConfigured: () => true,
      url: () => `ws://127.0.0.1:${address.port}/v1/realtime`,
      createProtocol: ({ connectionId }) => {
        protocolConnectionId = connectionId
        return {
          ...REALTIME_PROVIDERS.qwen.protocol,
          connectionMessages: () => [{
            type: 'start',
            route: connectionId,
          }],
          encodeOutgoing: payload => ({
            ...REALTIME_PROVIDERS.qwen.protocol.encodeOutgoing(payload),
            route: connectionId,
          }),
          normalizeIncoming: event => {
            if (event.route !== connectionId) return []
            const { route: _route, ...normalized } = event
            return normalized
          },
        }
      },
    },
  })
  t.after(async () => {
    frontend.close()
    await new Promise(resolve => server.close(resolve))
  })

  await frontend.connect()
  await traffic

  assert.ok(protocolConnectionId)
  assert.deepEqual(received.map(message => message.type), [
    'start',
    'session.update',
  ])
  assert.equal(received[0].route, protocolConnectionId)
  assert.equal(received[1].route, protocolConnectionId)
  assert.equal(frontend.ready, true)
})

test('rejects connect fast when speech-to-speech reports its single session slot is busy', async t => {
  // s2s 服务为单 session 槽：旧连接关闭后槽异步释放，若立即重连（例如语音
  // 唤醒）会收到 session_limit_reached。该错误必须快速 reject（而非卡死），
  // 上层 wakeFromSleep 才能带退避重试并在槽释放后连上。
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise(resolve => server.once('listening', resolve))
  server.once('connection', socket => {
    socket.send(JSON.stringify({
      type: 'error',
      error: {
        type: 'session_limit_reached',
        message: 'All 1 session slots are in use. Disconnect an existing client first.',
      },
    }))
  })
  const address = server.address()
  const frontend = new RealtimeFrontend({
    provider: {
      ...REALTIME_PROVIDERS['speech-to-speech'],
      isConfigured: () => true,
      url: () => `ws://127.0.0.1:${address.port}/v1/realtime`,
    },
  })
  t.after(async () => {
    frontend.close()
    await new Promise(resolve => server.close(resolve))
  })

  await assert.rejects(
    frontend.connect(),
    /session slots are in use/,
  )
  assert.equal(frontend.ready, false)
})
