import assert from 'node:assert/strict'
import test from 'node:test'
import {
  GatewayClientCapability,
  GatewayClientProtocolEvent,
  createGatewaySessionHello,
} from '../../shared/gateway-client-protocol.mjs'
import { GatewayClientProtocolSession } from '../src/transport/gateway-client-protocol-session.mjs'
import { GatewayClientReplayBuffer } from '../src/transport/gateway-client-replay-buffer.mjs'

test('shares a bounded Task replay cursor across protocol connections', () => {
  const replayBuffer = new GatewayClientReplayBuffer()
  const first = new GatewayClientProtocolSession({
    sessionId: 'replay-test',
    replayBuffer,
    createEventId: (() => {
      let index = 0
      return () => `evt_gateway_${++index}`
    })(),
  })
  first.receive(createGatewaySessionHello({
    eventId: 'evt_hello_1',
    clientInstanceId: 'client-1',
    capabilities: [GatewayClientCapability.SESSION_REPLAY],
  }))
  const running = first.encode({ type: 'task.running', task: { id: 'task-1' } })
  const progress = first.encode({ type: 'task.progress', task: { id: 'task-1' } })
  assert.equal(running.sequence, 1)
  assert.equal(progress.sequence, 2)
  assert.equal(first.encode({ type: 'audio.delta', audio: 'AA==', sampleRate: 24000 }).sequence, undefined)

  const second = new GatewayClientProtocolSession({
    sessionId: 'replay-test',
    replayBuffer,
    createEventId: () => 'evt_gateway_replay',
  })
  second.receive(createGatewaySessionHello({
    eventId: 'evt_hello_2',
    clientInstanceId: 'client-2',
    capabilities: [GatewayClientCapability.SESSION_REPLAY],
  }))
  const outcome = second.receive({
    type: GatewayClientProtocolEvent.SESSION_REPLAY,
    event_id: 'evt_client_replay',
    after_sequence: 1,
    limit: 50,
  })
  assert.equal(outcome.reply.type, GatewayClientProtocolEvent.SESSION_REPLAY_RESULT)
  assert.equal(outcome.reply.request_event_id, 'evt_client_replay')
  assert.deepEqual(outcome.reply.events.map(event => event.sequence), [2])
  assert.equal(outcome.reply.has_more, false)
})

