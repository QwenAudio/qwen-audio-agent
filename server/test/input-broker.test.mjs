import assert from 'node:assert/strict'
import test from 'node:test'
import { InputBroker } from '../src/agent/input-broker.mjs'

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
