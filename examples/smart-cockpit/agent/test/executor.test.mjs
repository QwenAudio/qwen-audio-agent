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
