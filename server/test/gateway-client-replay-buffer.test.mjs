import assert from 'node:assert/strict'
import test from 'node:test'
import {
  GatewayClientReplayBuffer,
  isReplayableGatewayEvent,
} from '../src/transport/gateway-client-replay-buffer.mjs'

test('retains only bounded Task lifecycle events with monotonic sequence', () => {
  const buffer = new GatewayClientReplayBuffer({ limit: 2 })
  assert.equal(isReplayableGatewayEvent({ type: 'audio.delta' }), false)
  assert.equal(isReplayableGatewayEvent({ type: 'task.running' }), true)
  assert.equal(buffer.append({ type: 'task.running', task: { id: '1' } }).sequence, 1)
  assert.equal(buffer.append({ type: 'task.progress', task: { id: '1' } }).sequence, 2)
  assert.equal(buffer.append({ type: 'task.completed', task: { id: '1' } }).sequence, 3)
  assert.deepEqual(
    buffer.replay(1).events.map(event => event.sequence),
    [2, 3],
  )
  assert.throws(
    () => buffer.replay(0),
    error => error.code === 'sequence_expired',
  )
})

test('paginates a replay window without advancing the underlying cursor', () => {
  const buffer = new GatewayClientReplayBuffer()
  for (let index = 0; index < 3; index += 1) {
    buffer.append({ type: 'task.updated', task: { id: String(index) } })
  }
  const first = buffer.replay(0, { limit: 2 })
  assert.equal(first.hasMore, true)
  assert.equal(first.nextSequence, 2)
  const second = buffer.replay(first.nextSequence, { limit: 2 })
  assert.equal(second.hasMore, false)
  assert.deepEqual(second.events.map(event => event.sequence), [3])
})
