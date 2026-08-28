import assert from 'node:assert/strict'
import test from 'node:test'
import { GatewayClient } from '../shared/gateway-client-sdk.mjs'
import {
  GatewayReferenceClientType,
  gatewayReferenceClientCapabilities,
} from '../shared/gateway-client-profiles.mjs'
import {
  GatewayClientCapability,
  GatewayClientProtocolEvent,
} from '../shared/gateway-client-protocol.mjs'

class ConformanceSocket {
  constructor() {
    this.readyState = 0
    this.listeners = new Map()
    this.sent = []
  }

  addEventListener(type, listener) {
    const current = this.listeners.get(type) || []
    current.push(listener)
    this.listeners.set(type, current)
  }

  emit(type, value = {}) {
    for (const listener of this.listeners.get(type) || []) listener(value)
  }

  open() { this.readyState = 1; this.emit('open') }
  send(raw) { this.sent.push(JSON.parse(raw)) }
  close() { this.readyState = 3 }
  receive(value) { this.emit('message', { data: JSON.stringify(value) }) }
}

for (const clientType of Object.values(GatewayReferenceClientType)) {
  test(`${clientType} satisfies the reference Gateway Client conformance flow`, async () => {
    const socket = new ConformanceSocket()
    let recovery
    const client = new GatewayClient({
      url: 'ws://gateway.test/api/realtime',
      createSocket: () => socket,
      clientType,
      clientInstanceId: `${clientType}-conformance`,
      capabilities: gatewayReferenceClientCapabilities(clientType),
      reconnect: false,
      onRecovery: value => { recovery = value },
      onAction: async () => ({ status: 'completed' }),
    }).start()
    socket.open()
    const hello = socket.sent[0]
    assert.equal(hello.type, GatewayClientProtocolEvent.SESSION_HELLO)
    assert.equal(hello.client.type, clientType)
    socket.receive({
      type: GatewayClientProtocolEvent.SESSION_READY,
      event_id: `evt_${clientType}_ready`,
      request_event_id: hello.event_id,
      protocol_version: '6.0.0',
      session_id: 'main',
      capabilities: hello.capabilities,
    })
    await new Promise(resolve => setImmediate(resolve))
    const tasks = socket.sent.find(event => event.type === GatewayClientProtocolEvent.TASK_LIST)
    socket.receive({
      type: GatewayClientProtocolEvent.TASK_LIST_RESULT,
      event_id: `evt_${clientType}_tasks`,
      request_event_id: tasks.event_id,
      tasks: [],
    })
    await new Promise(resolve => setImmediate(resolve))
    const history = socket.sent.find(event => (
      event.type === GatewayClientProtocolEvent.CONVERSATION_HISTORY
    ))
    socket.receive({
      type: GatewayClientProtocolEvent.CONVERSATION_HISTORY_RESULT,
      event_id: `evt_${clientType}_history`,
      request_event_id: history.event_id,
      messages: [],
    })
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(recovery, { events: [], tasks: [], messages: [] })
    assert.equal(
      client.supports(GatewayClientCapability.CLIENT_ACTION_ENTER_SLEEP),
      clientType === GatewayReferenceClientType.DESKTOP,
    )
    client.stop()
  })
}

