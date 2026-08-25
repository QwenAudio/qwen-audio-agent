import assert from 'node:assert/strict'
import test from 'node:test'
import {
  GatewayClientMessageSchema,
  GatewayServerMessageSchema,
  parseGatewayClientMessage,
  parseGatewayServerMessage,
} from '../shared/protocol/gateway-events.mjs'

function task(overrides = {}) {
  return {
    id: 'work_1',
    workId: 'work_1',
    jobId: 'job_1',
    workState: 'active',
    status: 'running',
    kind: 'work',
    objective: 'test work',
    createdAt: 1,
    elapsedMs: 0,
    ...overrides,
  }
}

test('validates client event envelopes and preserves extension fields', () => {
  assert.deepEqual(parseGatewayClientMessage({
    type: 'connect',
    provider: 'dashscope',
    clientExtension: { inputSampleRate: 16_000 },
  }), {
    type: 'connect',
    provider: 'dashscope',
    clientExtension: { inputSampleRate: 16_000 },
  })

  assert.equal(
    GatewayClientMessageSchema.safeParse({ type: 'voice.ready' }).success,
    false,
  )
  assert.equal(GatewayClientMessageSchema.safeParse(null).success, false)
})

test('validates voice and task messages in the server direction', () => {
  assert.deepEqual(parseGatewayServerMessage({
    type: 'voice.ready',
    inputSampleRate: 16_000,
    outputSampleRate: 24_000,
  }), {
    type: 'voice.ready',
    inputSampleRate: 16_000,
    outputSampleRate: 24_000,
  })

  assert.equal(
    GatewayServerMessageSchema.safeParse({
      type: 'task.accepted',
      task: task(),
    }).success,
    true,
  )
  assert.equal(
    GatewayServerMessageSchema.safeParse({
      type: 'task.accepted',
      task: { id: 'work_1' },
    }).success,
    false,
  )
  assert.equal(
    GatewayServerMessageSchema.safeParse({ type: 'connect' }).success,
    false,
  )
})
