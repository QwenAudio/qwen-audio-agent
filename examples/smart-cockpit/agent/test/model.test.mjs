import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DashScopeCockpitModel,
  DEFAULT_COCKPIT_AGENT_MODEL,
} from '../model.mjs'

test('uses Qwen3.8-Flash with thinking and standard function tools', async () => {
  let request
  let requestOptions
  const controller = new AbortController()
  const model = new DashScopeCockpitModel({
    model: DEFAULT_COCKPIT_AGENT_MODEL,
    client: {
      chat: {
        completions: {
          async create(value, options) {
            request = value
            requestOptions = options
            return { choices: [{ message: { content: '完成' } }] }
          },
        },
      },
    },
  })
  const tools = [{
    type: 'function',
    function: { name: 'navigation_start', parameters: { type: 'object' } },
  }]
  const message = await model.complete({
    messages: [{ role: 'user', content: '导航' }],
    tools,
    signal: controller.signal,
  })

  assert.equal(DEFAULT_COCKPIT_AGENT_MODEL, 'qwen3.8-flash')
  assert.equal(request.model, 'qwen3.8-flash')
  assert.equal(request.enable_thinking, true)
  assert.deepEqual(request.tools, tools)
  assert.equal(request.tool_choice, 'auto')
  assert.equal(requestOptions.signal, controller.signal)
  assert.equal(message.content, '完成')
})

test('explicitly disables tool calls during finalization and preserves cancellation', async () => {
  let request
  let requestOptions
  const controller = new AbortController()
  const model = new DashScopeCockpitModel({
    model: DEFAULT_COCKPIT_AGENT_MODEL,
    client: {
      chat: {
        completions: {
          async create(value, options) {
            request = value
            requestOptions = options
            return { choices: [{ message: { content: '已根据已有来源整理结果。' } }] }
          },
        },
      },
    },
  })

  const message = await model.complete({
    messages: [{ role: 'user', content: '停止检索，整理已有结果。' }],
    tools: [],
    signal: controller.signal,
  })

  assert.equal(request.model, 'qwen3.8-flash')
  assert.equal(request.enable_thinking, true)
  assert.equal(Object.hasOwn(request, 'tools'), false)
  assert.equal(request.tool_choice, 'none')
  assert.equal(requestOptions.signal, controller.signal)
  controller.abort()
  assert.equal(requestOptions.signal.aborted, true)
  assert.equal(message.content, '已根据已有来源整理结果。')
})
