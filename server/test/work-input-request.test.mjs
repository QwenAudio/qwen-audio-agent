import assert from 'node:assert/strict'
import test from 'node:test'
import { InputRequestStatus, normalizeInputRequest, publicInputRequest, resolveInputRequest } from '../src/core/work-input-request.mjs'
import { GatewayInputRequestSchema } from '../../shared/protocol/gateway-events.mjs'

test('answered is a resolved input state, distinct from approving a business operation', () => {
  const request = normalizeInputRequest({ id: 'input-one', prompt: '是否继续？', kind: 'authorization' }, {
    taskId: 'task_1', now: 10,
  })
  const answered = resolveInputRequest(request, InputRequestStatus.ANSWERED, { now: 20 })
  assert.equal(answered.status, 'answered')
  assert.equal(answered.resolvedAt, 20)
  assert.equal(answered.taskId, 'task_1')
  assert.deepEqual(GatewayInputRequestSchema.parse(answered), answered)
  assert.deepEqual(publicInputRequest(answered), answered)
})
