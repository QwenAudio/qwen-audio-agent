import assert from 'node:assert/strict'
import test from 'node:test'
import { InputBroker } from '../src/backend/adapters/acp/input-broker.mjs'

test('ACP elicitation pauses and resumes the same backend work', async () => {
  const events = []
  const broker = new InputBroker({ protocol: 'acp' })
  const pending = broker.request({
    mode: 'form',
    message: '请选择输出语言。',
    requestedSchema: {
      type: 'object',
      properties: { language: { type: 'string' } },
      required: ['language'],
    },
  }, {
    session: {
      coordinationRunId: 'task_1',
      ownerId: 'owner-one',
      onEvent: event => events.push(event),
    },
  })
  const request = events[0].input
  assert.equal(events[0].type, 'backend.input.requested')
  const resolved = broker.respond(request.id, {
    action: 'accept',
    text: '中文',
  }, { ownerId: 'owner-one' })
  assert.equal(resolved.status, 'accepted')
  assert.deepEqual(await pending, {
    action: 'accept',
    content: { language: '中文' },
  })
  assert.equal(events[1].type, 'backend.input.resolved')
})

test('ACP natural answers submit literal content, not an inferred permission decision', async () => {
  const events = []
  const broker = new InputBroker({ protocol: 'acp' })
  const pending = broker.request({ message: '是否按原方案处理？' }, {
    session: { coordinationRunId: 'task_2', ownerId: 'owner-one', onEvent: event => events.push(event) },
  })
  broker.respond(events[0].input.id, { text: '不要这样做，改成新方案' }, { ownerId: 'owner-one' })
  // Native MCP accept submits the answer contents; it does not approve an
  // operation or replace the separate ACP permission request protocol.
  assert.deepEqual(await pending, { action: 'accept', content: { response: '不要这样做，改成新方案' } })
})
