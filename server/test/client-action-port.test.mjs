import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ClientActionName,
  ClientActionPort,
} from '../src/client/client-action-port.mjs'
import {
  PresenceController,
  PresenceState,
} from '../src/client/presence-controller.mjs'
import {
  GatewayClientCapability,
  GatewayClientProtocolEvent,
} from '../../shared/gateway-client-protocol.mjs'

test('correlates a supported Client Action request and result', async () => {
  const sent = []
  let port
  port = new ClientActionPort({
    getCapabilities: () => [GatewayClientCapability.CLIENT_ACTION_ENTER_SLEEP],
    createEventId: () => 'evt_gateway_action',
    send: event => {
      sent.push(event)
      queueMicrotask(() => port.receive({
        type: GatewayClientProtocolEvent.CLIENT_ACTION_RESULT,
        event_id: 'evt_client_result',
        request_event_id: event.event_id,
        status: 'completed',
        output: { state: 'hidden' },
      }))
    },
  })

  const result = await port.request(ClientActionName.ENTER_SLEEP)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].type, GatewayClientProtocolEvent.CLIENT_ACTION_REQUEST)
  assert.equal(sent[0].name, ClientActionName.ENTER_SLEEP)
  assert.equal(result.output.state, 'hidden')
})

test('deduplicates a pending action and fails closed without capability', async () => {
  let resolveAction
  let calls = 0
  const port = new ClientActionPort({
    getCapabilities: () => [GatewayClientCapability.CLIENT_ACTION_ENTER_SLEEP],
    send: () => { calls += 1 },
  })
  const first = port.request(ClientActionName.ENTER_SLEEP, {}, {
    idempotencyKey: 'presence.sleep',
  })
  const pending = [...port.pendingById.values()][0]
  resolveAction = () => port.receive({
    type: GatewayClientProtocolEvent.CLIENT_ACTION_RESULT,
    event_id: 'evt_client_result',
    request_event_id: pending.requestId,
    status: 'completed',
  })
  const duplicate = port.request(ClientActionName.ENTER_SLEEP, {}, {
    idempotencyKey: 'presence.sleep',
  })
  assert.equal(first, duplicate)
  assert.equal(calls, 1)
  resolveAction()
  await first

  const unsupported = new ClientActionPort({ getCapabilities: () => [] })
  await assert.rejects(
    unsupported.request(ClientActionName.ENTER_SLEEP),
    error => error.code === 'client_action_unsupported',
  )
})

test('propagates Client Action failure and never treats it as completion', async () => {
  let port
  port = new ClientActionPort({
    getCapabilities: () => [GatewayClientCapability.CLIENT_ACTION_ENTER_SLEEP],
    send: event => queueMicrotask(() => port.receive({
      type: GatewayClientProtocolEvent.CLIENT_ACTION_RESULT,
      event_id: 'evt_client_failure',
      request_event_id: event.event_id,
      status: 'failed',
      error: { code: 'desktop_hide_failed', message: 'window refused to hide' },
    })),
  })
  await assert.rejects(
    port.request(ClientActionName.ENTER_SLEEP),
    error => error.code === 'desktop_hide_failed',
  )
})

test('PresenceController commits sleeping after one completed Client Action', async () => {
  let finish
  let actionCalls = 0
  let committed = 0
  const controller = new PresenceController({
    clientActions: {
      supports: () => true,
      request: () => {
        actionCalls += 1
        return new Promise(resolve => { finish = resolve })
      },
      close() {},
    },
    onSleeping: () => { committed += 1 },
  })

  const first = controller.requestSleep({ source: 'tool' })
  const duplicate = controller.requestSleep({ source: 'timeout' })
  assert.equal(first, duplicate)
  assert.equal(controller.state, PresenceState.SLEEP_REQUESTED)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(actionCalls, 1)
  finish({ status: 'completed' })
  await first
  assert.equal(controller.state, PresenceState.SLEEPING)
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(committed, 1)
  assert.equal((await controller.requestSleep()).duplicate, true)
  controller.wake()
  assert.equal(controller.state, PresenceState.ACTIVE)
})
