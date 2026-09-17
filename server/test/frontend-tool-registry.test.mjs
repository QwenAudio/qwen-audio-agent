import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PERMISSION_RESPONSE_CAPABILITY,
  BACKEND_INPUT_RESPONSE_CAPABILITY,
  ENTER_SLEEP_TOOL_NAME,
  FETCH_URL_TOOL_NAME,
  RESPOND_PERMISSION_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  frontendToolRegistry,
  frontendTools,
  buildFrontendInstructions,
  TOOLS,
} from '../src/frontend/frontend-tools.mjs'
import { KNOWLEDGE_TOOL_NAME } from '../src/knowledge/tools.mjs'
import { FrontendToolRegistry } from '../src/frontend/tools/frontend-tool-registry.mjs'
import { FrontendToolLoop } from '../src/frontend/tools/frontend-tool-loop.mjs'
import { buildFrontendToolContext } from '../src/frontend/tools/frontend-tool-context.mjs'
import { loadFrontendPrompt } from '../src/conversation/frontend-agent-context.mjs'

const DEFAULT_TOOL_NAMES = [
  'spawn_thinking',
  'schedule_reminder',
  'cancel_agent_task',
  'get_agent_task_status',
  'get_current_time',
  'notes',
]

function names(tools) {
  return tools.map(tool => tool.function.name)
}

// Prompt-maintenance convention, not a runtime tool classification.
const CORE_PROMPT_TOOLS = new Set([
  'spawn_thinking', 'get_agent_task_status', 'cancel_agent_task',
  'respond_permission', 'respond_agent_input', 'get_current_time',
])

function optionalToolNames() {
  return frontendToolRegistry.names().filter(name => (
    !CORE_PROMPT_TOOLS.has(name)
  ))
}

test('fixed policy and tool definitions never depend on optional tool names', () => {
  const prompt = loadFrontendPrompt()
  for (const name of CORE_PROMPT_TOOLS) {
    assert.equal(frontendToolRegistry.has(name), true, `stale core prompt tool: ${name}`)
  }
  for (const optional of optionalToolNames()) {
    const reference = new RegExp(`\\b${optional}\\b`, 'u')
    assert.doesNotMatch(prompt, reference, `fixed prompt references ${optional}`)
    for (const name of frontendToolRegistry.names()) {
      if (name === optional) continue
      const tool = frontendToolRegistry.get(name).definition.function
      assert.doesNotMatch(
        JSON.stringify({ description: tool.description, parameters: tool.parameters }),
        reference,
        `${name} references optional tool ${optional}`,
      )
    }
  }
  // Optional tools may use stable core contracts, without reverse coupling.
  assert.match(frontendToolRegistry.get('schedule_reminder').definition.function.description, /get_current_time/)
  assert.match(frontendToolRegistry.get('recall').definition.function.description, /get_agent_task_status/)
})

test('disabling any optional tool removes its instructions without changing fixed policy', () => {
  const context = {
    frontend: { capabilities: ['web-search', 'url-fetch', 'knowledge', 'recall', 'memory'] },
    client: { actions: ['desktop.presence.enter_sleep'] },
  }
  const tools = frontendTools(context)
  const prompt = buildFrontendInstructions(context)
  for (const name of optionalToolNames()) {
    const disabledContext = {
      ...context,
      frontend: { ...context.frontend, disabledTools: [name] },
    }
    assert.equal(names(tools).includes(name), true)
    assert.deepEqual(frontendTools(disabledContext), tools.filter(tool => tool.function.name !== name))
    const disabledPrompt = buildFrontendInstructions(disabledContext)
    if (name !== 'memory') assert.equal(disabledPrompt, prompt)
    else assert.doesNotMatch(disabledPrompt, /# Personalization and memory/)
    assert.doesNotMatch(
      `${disabledPrompt}\n${JSON.stringify(frontendTools(disabledContext))}`,
      new RegExp(`\\b${name}\\b`, 'u'),
    )
  }
})

test('registers tools without classification or an explicit runtime policy', () => {
  const definition = {
    type: 'function',
    function: { name: 'extension', description: 'Extension.', parameters: { type: 'object' } },
  }
  const registry = new FrontendToolRegistry([{ definition }])
  assert.deepEqual(registry.get('extension'), {
    name: 'extension', definition, policy: {},
  })
  assert.deepEqual(registry.definitions(), [definition])
  for (const name of frontendToolRegistry.names()) {
    const entry = frontendToolRegistry.get(name)
    assert.equal(Object.isFrozen(entry), true)
    assert.equal(Object.hasOwn(entry, 'contract'), false)
    assert.equal(Object.hasOwn(entry.policy, 'mode'), false)
    assert.equal(Object.hasOwn(entry.definition, 'contract'), false)
    assert.equal(Object.hasOwn(entry.definition.function, 'contract'), false)
  }
})

test('permission field semantics live in schema rather than fixed policy', () => {
  const prompt = loadFrontendPrompt()
  const tool = frontendToolRegistry.get('respond_permission').definition.function
  assert.doesNotMatch(prompt, /`permission_id`|`series_id`|`input_refs`|spawn_thinking\.objective/)
  assert.match(tool.parameters.properties.permission_id.description, /原样使用 Gateway.*不得猜造/)
  assert.equal(tool.parameters.properties.task_id, undefined)
  assert.deepEqual(tool.parameters.required, ['decision'])
  assert.match(tool.parameters.properties.permission_id.description, /只有一个待确认请求时可省略/)
  assert.match(tool.parameters.properties.decision.description, /task.*always.*reject/)
  assert.match(tool.description, /自然表达判断.*不得.*代替用户决定或要求固定口令/)
})

test('registers every default frontend tool once in stable order', () => {
  assert.deepEqual(names(TOOLS), DEFAULT_TOOL_NAMES)
  assert.deepEqual(names(frontendTools()), DEFAULT_TOOL_NAMES)
  assert.equal(frontendTools(), TOOLS)
  for (const name of DEFAULT_TOOL_NAMES) {
    assert.equal(frontendToolRegistry.has(name), true)
  }
})

test('customizes only the spawn_thinking capability description', () => {
  const description = '只处理座舱车辆、导航、音乐、天气和闪购任务。'
  const customized = frontendTools({
    frontend: { spawnThinkingDescription: description },
  })

  assert.equal(customized[0].function.name, 'spawn_thinking')
  assert.equal(customized[0].function.description, description)
  assert.deepEqual(customized[0].function.parameters, TOOLS[0].function.parameters)
  assert.notEqual(customized[0], TOOLS[0])
  assert.deepEqual(customized.slice(1), TOOLS.slice(1))
  assert.notEqual(TOOLS[0].function.description, description)
})

test('appends namespaced dynamic tools without changing the static registry', () => {
  const dynamic = {
    type: 'function',
    function: {
      name: 'mcp__documents__search',
      description: 'Search configured documents.',
      parameters: { type: 'object', properties: {} },
    },
  }
  assert.deepEqual(frontendTools({
    frontend: { tools: [dynamic] },
  }), [...TOOLS, dynamic])
  assert.equal(frontendToolRegistry.has('mcp__documents__search'), false)
  assert.throws(
    () => frontendTools({ frontend: { tools: [TOOLS[0]] } }),
    /duplicate dynamic frontend tool/,
  )
})

test('exposes the unified permission response only for a real request capability', () => {
  assert.equal(
    names(frontendTools()).includes(RESPOND_PERMISSION_TOOL_NAME),
    false,
  )
  assert.deepEqual(
    names(frontendTools({
      frontend: {
        capabilities: [PERMISSION_RESPONSE_CAPABILITY],
      },
    })),
    [...DEFAULT_TOOL_NAMES, RESPOND_PERMISSION_TOOL_NAME],
  )
})

test('exposes backend input response only for a real pending request', () => {
  assert.equal(names(frontendTools()).includes('respond_agent_input'), false)
  assert.deepEqual(names(frontendTools({
    frontend: { capabilities: [BACKEND_INPUT_RESPONSE_CAPABILITY] },
  })), [...DEFAULT_TOOL_NAMES, 'respond_agent_input'])
})

test('exposes Client Action tools only when the client advertises support', () => {
  assert.equal(frontendToolRegistry.isEnabled(ENTER_SLEEP_TOOL_NAME), false)
  assert.equal(
    frontendToolRegistry.isEnabled(ENTER_SLEEP_TOOL_NAME, {
      client: { actions: ['desktop.presence.enter_sleep'] },
    }),
    true,
  )
  assert.deepEqual(
    names(frontendTools({
      client: { actions: ['desktop.presence.enter_sleep'] },
    })),
    [...DEFAULT_TOOL_NAMES, ENTER_SLEEP_TOOL_NAME],
  )
  assert.deepEqual(
    names(frontendTools({ client: { actions: ['unknown'] } })),
    DEFAULT_TOOL_NAMES,
  )
})

test('exposes retrieval tools only when the frontend advertises each capability', () => {
  assert.equal(frontendToolRegistry.isEnabled(WEB_SEARCH_TOOL_NAME), false)
  assert.equal(frontendToolRegistry.isEnabled(FETCH_URL_TOOL_NAME), false)
  assert.deepEqual(
    names(frontendTools({ frontend: { capabilities: ['url-fetch'] } })),
    [...DEFAULT_TOOL_NAMES, FETCH_URL_TOOL_NAME],
  )
  assert.deepEqual(
    names(frontendTools({
      frontend: { capabilities: ['web-search', 'url-fetch'] },
    })),
    [...DEFAULT_TOOL_NAMES, WEB_SEARCH_TOOL_NAME, FETCH_URL_TOOL_NAME],
  )
  assert.deepEqual(
    frontendToolRegistry.get(WEB_SEARCH_TOOL_NAME).policy,
    {
      maxResultBytes: 48 * 1024,
      requiredCapabilities: ['web-search'],
    },
  )
})

test('hides explicitly disabled optional tools after capability checks', () => {
  assert.deepEqual(names(frontendTools({
    frontend: {
      capabilities: ['web-search', 'url-fetch', 'knowledge', 'recall'],
      disabledTools: [
        'schedule_reminder',
        'web_search',
        'fetch_url',
        'knowledge',
        'recall',
        'notes',
      ],
    },
  })), DEFAULT_TOOL_NAMES.filter(name => (
    name !== 'schedule_reminder' && name !== 'notes'
  )))
})

test('gates the backend permission response tool behind its capability', () => {
  assert.equal(
    frontendToolRegistry.isEnabled(RESPOND_PERMISSION_TOOL_NAME),
    false,
  )
  assert.deepEqual(
    names(frontendTools({
      frontend: { capabilities: [PERMISSION_RESPONSE_CAPABILITY] },
    })),
    [...DEFAULT_TOOL_NAMES, RESPOND_PERMISSION_TOOL_NAME],
  )
})

test('frontend-only mode retains reminder controls but not backend execution', () => {
  const context = { frontend: buildFrontendToolContext({
    backendAvailability: { snapshot: () => ({ configured: false }) },
  }) }
  const tools = frontendTools(context)
  assert.deepEqual(names(tools), DEFAULT_TOOL_NAMES.filter(name => name !== 'spawn_thinking'))
  const schedule = tools.find(tool => tool.function.name === 'schedule_reminder')
  assert.deepEqual(schedule.function.parameters.properties.type.enum, ['reminder'])
  // Filtering one session must not mutate another session's schemas.
  const fullSchedule = frontendTools().find(tool => tool.function.name === 'schedule_reminder')
  assert.deepEqual(fullSchedule.function.parameters.properties.type.enum, ['reminder', 'task'])
})

test('availability projection combines configured features and pending requests', () => {
  const frontend = buildFrontendToolContext({
    disabledTools: ['notes'],
    backendAvailability: { snapshot: () => ({ configured: true, ok: false, known: true }) },
    frontendRetrieval: { capabilities: () => ['web-search', 'url-fetch'] },
    frontendKnowledge: { capabilities: () => ['knowledge'] },
    sessionDigests: {},
    permissionPending: true,
    inputPending: true,
  })
  assert.deepEqual(frontend.capabilities, [
    'web-search', 'url-fetch', 'knowledge', 'recall',
    PERMISSION_RESPONSE_CAPABILITY, BACKEND_INPUT_RESPONSE_CAPABILITY,
  ])
  const visible = names(frontendTools({ frontend }))
  assert.equal(visible.includes('notes'), false)
  assert.equal(visible.includes('spawn_thinking'), true, 'temporary failure is not no-backend mode')
  assert.equal(visible.includes('respond_permission'), true)
  assert.equal(visible.includes('respond_agent_input'), true)
})

test('status query exposes only parameters the Gateway actually consumes', () => {
  const tool = frontendToolRegistry.get('get_agent_task_status').definition.function
  assert.deepEqual(Object.keys(tool.parameters.properties), ['task_id', 'list_all'])
  assert.match(tool.parameters.properties.task_id.description, /当前对话或工具结果/)
  assert.match(tool.parameters.properties.list_all.description, /20[\s\S]*其他会话/)
})

test('disabled tools cannot execute or consume the tool-loop budget', async () => {
  const calls = []
  const executor = frontendToolRegistry.createExecutor(Object.fromEntries(
    frontendToolRegistry.names().map(name => [name, async () => calls.push(name)]),
  ), { loop: new FrontendToolLoop({ maxCallsPerTurn: 1 }) })
  const context = {
    turnId: 'disabled-turn',
    generation: 1,
    frontend: {
      capabilities: ['web-search', 'url-fetch', 'knowledge', 'recall',
        PERMISSION_RESPONSE_CAPABILITY, BACKEND_INPUT_RESPONSE_CAPABILITY],
      disabledTools: frontendToolRegistry.names(),
    },
    client: { actions: ['desktop.presence.enter_sleep'] },
  }
  for (const name of frontendToolRegistry.names()) {
    const result = await executor.execute(name, context)
    assert.equal(result.executed, false, name)
    assert.equal(result.limit.reason, 'tool_unavailable', name)
  }
  assert.deepEqual(calls, [])
  const result = await executor.execute('get_current_time', {
    ...context,
    frontend: { disabledTools: [] },
  })
  assert.equal(result.executed, true)
  assert.deepEqual(calls, ['get_current_time'])
})

test('exposes the knowledge tool only with the frontend knowledge capability', () => {
  assert.equal(frontendToolRegistry.isEnabled(KNOWLEDGE_TOOL_NAME), false)
  assert.deepEqual(
    names(frontendTools({ frontend: { capabilities: ['knowledge'] } })),
    [
      ...DEFAULT_TOOL_NAMES.slice(0, 7),
      KNOWLEDGE_TOOL_NAME,
      ...DEFAULT_TOOL_NAMES.slice(7),
    ],
  )
  assert.deepEqual(
    frontendToolRegistry.get(KNOWLEDGE_TOOL_NAME).policy,
    {
      maxResultBytes: 64 * 1024,
      requiredCapabilities: ['knowledge'],
    },
  )
})

test('keeps visibility policy separate from runtime execution checks', () => {
  const entry = frontendToolRegistry.get(ENTER_SLEEP_TOOL_NAME)
  assert.deepEqual(entry.policy, {
    requiredClientActions: ['desktop.presence.enter_sleep'],
  })
  assert.equal(Object.isFrozen(entry.policy), true)
  assert.equal(Object.isFrozen(entry.policy.requiredClientActions), true)
})

test('rejects unnamed and duplicate tool registrations', () => {
  assert.throws(
    () => new FrontendToolRegistry([{ definition: {} }]),
    /requires a name/,
  )
  const definition = {
    type: 'function',
    function: { name: 'duplicate', parameters: { type: 'object' } },
  }
  assert.throws(
    () => new FrontendToolRegistry([
      { definition },
      { definition },
    ]),
    /Duplicate frontend tool/,
  )
  assert.throws(
    () => new FrontendToolRegistry([
      { definition, policy: { repeatHandling: 'always' } },
    ]),
    /repeatHandling must be handler/,
  )
  assert.throws(
    () => new FrontendToolRegistry([
      { definition, policy: { maxResultBytes: 0 } },
    ]),
    /maxResultBytes must be a positive integer/,
  )
})

test('binds one executor per registered tool and rejects incomplete maps', async () => {
  const definition = name => ({
    type: 'function',
    function: { name, parameters: { type: 'object' } },
  })
  const registry = new FrontendToolRegistry([
    { definition: definition('first') },
    { definition: definition('second') },
  ])

  assert.throws(
    () => registry.createExecutor({ first: async () => 'first' }),
    /lack executors: second/,
  )
  assert.throws(
    () => registry.createExecutor({
      first: async () => 'first',
      second: async () => 'second',
      unknown: async () => 'unknown',
    }),
    /not registered: unknown/,
  )

  const executor = registry.createExecutor({
    first: async context => `first:${context.value}`,
    second: async () => 'second',
  })
  const execution = await executor.execute('first', { value: 1 })
  assert.equal(execution.handled, true)
  assert.equal(execution.executed, true)
  assert.equal(execution.tool.name, 'first')
  assert.deepEqual(execution.tool.policy, {})
  assert.equal(execution.value, 'first:1')
  assert.deepEqual(await executor.execute('unknown', {}), {
    handled: false,
    executed: false,
    tool: null,
    value: undefined,
  })
})

test('enforces the tool loop before invoking a registered handler', async () => {
  const definition = {
    type: 'function',
    function: { name: 'bounded', parameters: { type: 'object' } },
  }
  const registry = new FrontendToolRegistry([
    { definition },
  ])
  let calls = 0
  const executor = registry.createExecutor({
    bounded: async () => { calls += 1 },
  }, {
    loop: new FrontendToolLoop({ maxCallsPerTurn: 1 }),
  })

  const context = { turnId: 'turn', turnGeneration: 1 }
  assert.equal((await executor.execute('bounded', {
    ...context,
    args: { value: 1 },
  })).executed, true)
  const limited = await executor.execute('bounded', {
    ...context,
    args: { value: 2 },
  })
  assert.equal(limited.executed, false)
  assert.equal(limited.limit.reason, 'call_limit')
  assert.equal(calls, 1)
})
