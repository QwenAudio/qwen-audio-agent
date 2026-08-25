import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ENTER_SLEEP_TOOL_NAME,
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
  'respond_agent_permission',
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

test('exposes client-state tools only when the client advertises support', () => {
  assert.equal(frontendToolRegistry.isEnabled(ENTER_SLEEP_TOOL_NAME), false)
  assert.equal(
    frontendToolRegistry.isEnabled(ENTER_SLEEP_TOOL_NAME, {
      client: { states: ['sleeping'] },
    }),
    true,
  )
  assert.deepEqual(
    names(frontendTools({ client: { states: ['sleeping'] } })),
    [...DEFAULT_TOOL_NAMES, ENTER_SLEEP_TOOL_NAME],
  )
  assert.deepEqual(
    names(frontendTools({ client: { states: ['unknown'] } })),
    DEFAULT_TOOL_NAMES,
  )
})

test('keeps visibility policy separate from runtime execution checks', () => {
  const entry = frontendToolRegistry.get(ENTER_SLEEP_TOOL_NAME)
  assert.deepEqual(entry.policy, {
    mode: 'control',
    requiredClientStates: ['sleeping'],
  })
  assert.equal(Object.isFrozen(entry.policy), true)
  assert.equal(Object.isFrozen(entry.policy.requiredClientStates), true)
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
    respond_agent_permission: 'control',
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
