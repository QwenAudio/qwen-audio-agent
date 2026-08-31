import assert from 'node:assert/strict'
import test from 'node:test'
import {
  Role,
  TaskState,
} from '@a2a-js/sdk'
import { CockpitAgentExecutor } from '../executor.mjs'

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

test('publishes a standard A2A task lifecycle around one MCP call', async () => {
  const calls = []
  const events = []
  const executor = new CockpitAgentExecutor({
    tools: {
      async call(name, args) {
        calls.push({ name, args })
        return { content: '已打开主驾车窗', data: { vehicle: { windowFL: 1 } } }
      },
    },
  })
  await executor.execute(requestContext('打开主驾车窗'), {
    publish(event) { events.push(event) },
  })

  assert.deepEqual(calls, [{
    name: 'vehicle_window_control',
    args: { action: 'open', window: 'windowFL' },
  }])
  assert.deepEqual(events.map(event => event.kind), [
    'task',
    'statusUpdate',
    'artifactUpdate',
    'statusUpdate',
  ])
  assert.equal(events[1].data.status.state, TaskState.TASK_STATE_WORKING)
  assert.equal(events[3].data.status.state, TaskState.TASK_STATE_COMPLETED)
  assert.equal(
    events[2].data.artifact.parts[0].content.value,
    '已打开主驾车窗',
  )
})

test('completes unsupported requests without inventing a business tool', async () => {
  let called = false
  const events = []
  const executor = new CockpitAgentExecutor({
    tools: {
      async call() {
        called = true
      },
    },
  })
  await executor.execute(requestContext('帮我写一份年度计划'), {
    publish(event) { events.push(event) },
  })
  assert.equal(called, false)
  assert.equal(events.at(-1).data.status.state, TaskState.TASK_STATE_COMPLETED)
  assert.match(
    events.at(-1).data.status.message.parts[0].content.value,
    /轻量示例/u,
  )
})
