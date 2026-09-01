import assert from 'node:assert/strict'
import test from 'node:test'
import {
  Role,
  TaskState,
} from '@a2a-js/sdk'
import { CockpitAgentExecutor } from '../executor.mjs'

const CLIMATE_TOOL = {
  name: 'vehicle_climate_control',
  description: '控制空调',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string' },
      temperature: { type: 'number' },
    },
  },
}

function requestContext(text) {
  return {
    taskId: 'remote-task',
    contextId: 'remote-context',
    userMessage: {
      messageId: 'message-1',
      contextId: '',
      taskId: '',
      role: Role.ROLE_USER,
      parts: [{
        content: { $case: 'text', value: text },
        mediaType: 'text/plain',
        filename: '',
      }],
      extensions: [],
      referenceTaskIds: [],
    },
  }
}

test('lets the model plan an MCP call and publishes the A2A lifecycle', async () => {
  const calls = []
  const events = []
  let round = 0
  const executor = new CockpitAgentExecutor({
    model: {
      async complete({ messages, tools }) {
        assert.equal(tools[0].function.name, CLIMATE_TOOL.name)
        if (round++ === 0) {
          assert.match(messages[0].content, /必须使用提供的工具/u)
          assert.match(messages[0].content, /后续指令中明确确认/u)
          assert.match(messages[0].content, /导航到.*navigation_start/u)
          return {
            content: null,
            tool_calls: [{
              id: 'call-climate',
              function: {
                name: CLIMATE_TOOL.name,
                arguments: JSON.stringify({ action: 'set_temp', temperature: 22 }),
              },
            }],
          }
        }
        assert.equal(messages.at(-1).role, 'tool')
        return { content: messages.at(-1).content }
      },
    },
    tools: {
      async list() { return [CLIMATE_TOOL] },
      async call(name, args) {
        calls.push({ name, args })
        return { content: '空调当前开启，制冷，22°C，3档', data: { vehicle: { acTemp: 22 } } }
      },
    },
  })
  await executor.execute(requestContext('空调调到二十二度'), {
    publish(event) { events.push(event) },
  })

  assert.deepEqual(calls, [{
    name: 'vehicle_climate_control',
    args: { action: 'set_temp', temperature: 22 },
  }])
  assert.deepEqual(events.map(event => event.kind), [
    'task',
    'statusUpdate',
    'statusUpdate',
    'artifactUpdate',
    'statusUpdate',
  ])
  assert.equal(events[1].data.status.state, TaskState.TASK_STATE_WORKING)
  assert.equal(events.at(-1).data.status.state, TaskState.TASK_STATE_COMPLETED)
  assert.equal(
    events.at(-2).data.artifact.parts[0].content.value,
    '空调当前开启，制冷，22°C，3档',
  )
})

test('returns a model clarification without inventing a tool call', async () => {
  let called = false
  const events = []
  const executor = new CockpitAgentExecutor({
    model: {
      async complete() {
        return { content: '您最后要去萧山的哪个位置？' }
      },
    },
    tools: {
      async list() { return [CLIMATE_TOOL] },
      async call() { called = true },
    },
  })
  await executor.execute(requestContext('最后再回到萧山那个'), {
    publish(event) { events.push(event) },
  })

  assert.equal(called, false)
  assert.equal(events.at(-1).data.status.state, TaskState.TASK_STATE_COMPLETED)
  assert.match(
    events.at(-1).data.status.message.parts[0].content.value,
    /萧山的哪个位置/u,
  )
})

test('discovers a custom skill, loads it, and then executes its real tools', async () => {
  const calls = []
  const events = []
  let round = 0
  const tools = [
    {
      name: 'custom_skill_list',
      description: '列出自定义技能',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'custom_skill_load',
      description: '加载自定义技能',
      inputSchema: {
        type: 'object',
        properties: { skill_name: { type: 'string' } },
        required: ['skill_name'],
      },
    },
    {
      name: 'navigation_start',
      description: '开始导航',
      inputSchema: {
        type: 'object',
        properties: { destination: { type: 'string' } },
        required: ['destination'],
      },
    },
  ]
  const executor = new CockpitAgentExecutor({
    model: {
      async complete({ messages }) {
        if (round++ === 0) {
          assert.match(messages[0].content, /下班回家/u)
          assert.match(messages[0].content, /执行前必须调用 custom_skill_load/u)
          return {
            tool_calls: [{
              id: 'load-skill',
              function: {
                name: 'custom_skill_load',
                arguments: JSON.stringify({ skill_name: '下班回家' }),
              },
            }],
          }
        }
        if (round === 2) {
          assert.match(messages.at(-1).content, /导航到家/u)
          return {
            tool_calls: [{
              id: 'start-navigation',
              function: {
                name: 'navigation_start',
                arguments: JSON.stringify({ destination: '家' }),
              },
            }],
          }
        }
        return { content: '已开始导航回家。' }
      },
    },
    tools: {
      async list() { return tools },
      async call(name, args) {
        calls.push({ name, args })
        if (name === 'custom_skill_list') {
          return {
            content: '下班回家：导航回家',
            data: { skills: [{ name: '下班回家', description: '导航回家' }] },
          }
        }
        if (name === 'custom_skill_load') {
          return { content: '<custom_skill_instructions>导航到家。</custom_skill_instructions>' }
        }
        return { content: '已开始导航到家', data: { navigation: { status: 'navigating' } } }
      },
    },
  })
  await executor.execute(requestContext('执行下班回家'), {
    publish(event) { events.push(event) },
  })

  assert.deepEqual(calls.map(call => call.name), [
    'custom_skill_list',
    'custom_skill_load',
    'navigation_start',
  ])
  assert.equal(events.at(-1).data.status.state, TaskState.TASK_STATE_COMPLETED)
  assert.equal(events.at(-1).data.status.message.parts[0].content.value, '已开始导航回家。')
})
