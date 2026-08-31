import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PERMISSION_RESPONSE_CAPABILITY,
  BACKEND_INPUT_RESPONSE_CAPABILITY,
  ENTER_SLEEP_TOOL_NAME,
  FETCH_URL_TOOL_NAME,
  KNOWLEDGE_TOOL_NAME,
  RESPOND_PERMISSION_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  frontendToolRegistry,
  frontendTools,
  TOOLS,
} from '../src/voice/frontend-tools.mjs'
import {
  FRONTEND_TOOL_MODES,
  FrontendToolRegistry,
} from '../src/voice/tools/frontend-tool-registry.mjs'
import { FrontendToolLoop } from '../src/voice/tools/frontend-tool-loop.mjs'

const DEFAULT_TOOL_NAMES = [
  'spawn_thinking',
  'schedule_reminder',
  'cancel_agent_task',
  'get_agent_task_status',
  'get_current_time',
  'memory',
  'notes',
]

function names(tools) {
  return tools.map(tool => tool.function.name)
}

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
      mode: 'inline',
      maxResultBytes: 48 * 1024,
      requiredCapabilities: ['web-search'],
    },
  )
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
      mode: 'inline',
      maxResultBytes: 64 * 1024,
      requiredCapabilities: ['knowledge'],
    },
  )
})

test('keeps visibility policy separate from runtime execution checks', () => {
  const entry = frontendToolRegistry.get(ENTER_SLEEP_TOOL_NAME)
  assert.deepEqual(entry.policy, {
    mode: 'control',
    requiredClientActions: ['desktop.presence.enter_sleep'],
  })
  assert.equal(Object.isFrozen(entry.policy), true)
  assert.equal(Object.isFrozen(entry.policy.requiredClientActions), true)
})

test('declares one background tool and classifies every other tool', () => {
  assert.deepEqual(FRONTEND_TOOL_MODES, [
    'inline',
    'background',
    'control',
  ])
  assert.deepEqual(Object.fromEntries(
    frontendToolRegistry.names().map(name => [
      name,
      frontendToolRegistry.get(name).policy.mode,
    ]),
  ), {
    spawn_thinking: 'background',
    schedule_reminder: 'inline',
    cancel_agent_task: 'control',
    get_agent_task_status: 'control',
    get_current_time: 'inline',
    memory: 'inline',
    notes: 'inline',
    knowledge: 'inline',
    recall: 'inline',
    respond_permission: 'control',
    respond_agent_input: 'control',
    web_search: 'inline',
    fetch_url: 'inline',
    enter_sleep: 'control',
  })
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
      { definition, policy: { mode: 'inline' } },
      { definition, policy: { mode: 'inline' } },
    ]),
    /Duplicate frontend tool/,
  )
  assert.throws(
    () => new FrontendToolRegistry([{ definition }]),
    /requires a valid mode/,
  )
  assert.throws(
    () => new FrontendToolRegistry([
      { definition, policy: { mode: 'deferred' } },
    ]),
    /requires a valid mode/,
  )
  assert.throws(
    () => new FrontendToolRegistry([
      { definition, policy: { mode: 'inline', repeatHandling: 'always' } },
    ]),
    /repeatHandling must be handler/,
  )
  assert.throws(
    () => new FrontendToolRegistry([
      { definition, policy: { mode: 'inline', maxResultBytes: 0 } },
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
    { definition: definition('first'), policy: { mode: 'background' } },
    { definition: definition('second'), policy: { mode: 'inline' } },
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
  assert.equal(execution.tool.policy.mode, 'background')
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
    { definition, policy: { mode: 'inline' } },
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
