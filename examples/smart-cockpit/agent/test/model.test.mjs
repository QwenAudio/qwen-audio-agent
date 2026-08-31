import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DashScopeCockpitModel,
  DEFAULT_COCKPIT_AGENT_MODEL,
} from '../model.mjs'

test('uses Qwen3.8-Flash with thinking and standard function tools', async () => {
  let request
  const model = new DashScopeCockpitModel({
    model: DEFAULT_COCKPIT_AGENT_MODEL,
    client: {
      chat: {
        completions: {
          async create(value) {
            request = value
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
  })

  assert.equal(DEFAULT_COCKPIT_AGENT_MODEL, 'qwen3.8-flash')
  assert.equal(request.model, 'qwen3.8-flash')
  assert.equal(request.enable_thinking, true)
  assert.deepEqual(request.tools, tools)
  assert.equal(message.content, '完成')
})
