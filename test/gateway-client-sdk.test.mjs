import assert from 'node:assert/strict'
import test from 'node:test'
import { GatewayClient } from '../shared/gateway-client-sdk.mjs'
import {
  GatewayClientCapability,
  GatewayClientProtocolEvent,
} from '../shared/gateway-client-protocol.mjs'

class FakeSocket {
  constructor() {
    this.readyState = 0
    this.listeners = new Map()
    this.sent = []
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || []
    listeners.push(listener)
    this.listeners.set(type, listeners)
  }

  emit(type, value = {}) {
    for (const listener of this.listeners.get(type) || []) listener(value)
  }

  open() {
    this.readyState = 1
    this.emit('open')
  }

  receive(value) {
    this.emit('message', { data: JSON.stringify(value) })
  }

  send(value) { this.sent.push(JSON.parse(value)) }
  close() { this.readyState = 3 }
}

test('reference Client negotiates once and correlates runtime commands', async () => {
  const socket = new FakeSocket()
  const client = new GatewayClient({
    url: 'ws://gateway.test/api/realtime',
    createSocket: () => socket,
    clientInstanceId: 'sdk-test',
    capabilities: [GatewayClientCapability.TASK_COMMANDS],
    reconnect: false,
  }).start()
  socket.open()
  assert.equal(socket.sent[0].type, GatewayClientProtocolEvent.SESSION_HELLO)
  socket.receive({
    type: GatewayClientProtocolEvent.SESSION_READY,
    event_id: 'evt_gateway_ready',
    request_event_id: socket.sent[0].event_id,
    protocol_version: '6.0.0',
    session_id: 'main',
    capabilities: [GatewayClientCapability.TASK_COMMANDS],
  })
  await new Promise(resolve => setImmediate(resolve))
  const recoveryRequest = socket.sent.find(event => event.type === 'task.list')
  socket.receive({
    type: GatewayClientProtocolEvent.TASK_LIST_RESULT,
    event_id: 'evt_gateway_tasks',
    request_event_id: recoveryRequest.event_id,
    tasks: [],
  })
  await new Promise(resolve => setImmediate(resolve))

  const pending = client.request(GatewayClientProtocolEvent.TASK_GET, {
    task_id: 'task-1',
  })
  const request = socket.sent.at(-1)
  socket.receive({
    type: GatewayClientProtocolEvent.TASK_GET_RESULT,
    event_id: 'evt_gateway_task',
    request_event_id: request.event_id,
    task: {
      id: 'task-1', workState: 'working', status: 'running', kind: 'work',
      objective: 'test', createdAt: 1, elapsedMs: 1,
    },
  })
  assert.equal((await pending).task.id, 'task-1')
  client.stop()
})

test('reference Client envelopes direct runtime events with event_id', () => {
  const socket = new FakeSocket()
  const client = new GatewayClient({
    url: 'ws://gateway.test/api/realtime',
    createSocket: () => socket,
    clientInstanceId: 'sdk-direct-event-test',
    reconnect: false,
  }).start()
  socket.open()

  client.send({ type: 'input.unmute' })
  assert.equal(socket.sent.at(-1).type, 'input.unmute')
  assert.match(socket.sent.at(-1).event_id, /^evt_client_/)

  client.send({
    type: 'playback.started',
    event_id: 'evt_client_supplied',
    responseId: 'response-1',
  })
  assert.equal(socket.sent.at(-1).event_id, 'evt_client_supplied')
  client.stop()
})

test('reference Client initializes and updates the output voice through GCP', async () => {
  const socket = new FakeSocket()
  const client = new GatewayClient({
    url: 'ws://gateway.test/api/realtime',
    createSocket: () => socket,
    clientInstanceId: 'sdk-output-voice-test',
    capabilities: [GatewayClientCapability.SESSION_OUTPUT_VOICE],
    configure: { outputVoice: 'longanlufeng' },
    reconnect: false,
  }).start()

  socket.open()

  assert.equal(socket.sent[0].connection.output_voice, 'longanlufeng')
  socket.receive({
    type: GatewayClientProtocolEvent.SESSION_READY,
    event_id: 'evt_gateway_voice_ready',
    request_event_id: socket.sent[0].event_id,
    protocol_version: '6.0.0',
    session_id: 'main',
    capabilities: [GatewayClientCapability.SESSION_OUTPUT_VOICE],
  })
  await new Promise(resolve => setImmediate(resolve))

  const pending = client.updateOutputVoice('longanqian')
  const request = socket.sent.at(-1)
  assert.equal(request.type, GatewayClientProtocolEvent.SESSION_OUTPUT_VOICE_UPDATE)
  assert.equal(request.voice, 'longanqian')
  socket.receive({
    type: GatewayClientProtocolEvent.SESSION_OUTPUT_VOICE_UPDATED,
    event_id: 'evt_gateway_voice_updated',
    request_event_id: request.event_id,
    voice: 'longanqian',
    changed: true,
    reconnecting: true,
  })
  assert.deepEqual(await pending, {
    type: GatewayClientProtocolEvent.SESSION_OUTPUT_VOICE_UPDATED,
    event_id: 'evt_gateway_voice_updated',
    request_event_id: request.event_id,
    voice: 'longanqian',
    changed: true,
    reconnecting: true,
  })
  client.stop()
})

test('reference Client rejects output voice updates without negotiated support', async () => {
  const client = new GatewayClient({
    url: 'ws://gateway.test/api/realtime',
    createSocket: () => new FakeSocket(),
    reconnect: false,
  })

  await assert.rejects(
    client.updateOutputVoice('longanqian'),
    error => error.code === 'capability_not_negotiated',
  )
})

test('reference Client executes negotiated Actions and deduplicates replayed events', async () => {
  const socket = new FakeSocket()
  const received = []
  const client = new GatewayClient({
    url: 'ws://gateway.test/api/realtime',
    createSocket: () => socket,
    clientInstanceId: 'sdk-action-test',
    capabilities: [GatewayClientCapability.CLIENT_ACTION_ENTER_SLEEP],
    reconnect: false,
    onEvent: event => received.push(event),
    onAction: async () => ({ status: 'completed' }),
  }).start()
  socket.open()
  socket.receive({
    type: GatewayClientProtocolEvent.SESSION_READY,
    event_id: 'evt_gateway_ready',
    request_event_id: socket.sent[0].event_id,
    protocol_version: '6.0.0',
    session_id: 'main',
    capabilities: [GatewayClientCapability.CLIENT_ACTION_ENTER_SLEEP],
  })
  socket.receive({
    type: GatewayClientProtocolEvent.CLIENT_ACTION_REQUEST,
    event_id: 'evt_gateway_action',
    name: 'desktop.presence.enter_sleep',
  })
  await new Promise(resolve => setImmediate(resolve))
  const result = socket.sent.at(-1)
  assert.equal(result.type, GatewayClientProtocolEvent.CLIENT_ACTION_RESULT)
  assert.equal(result.request_event_id, 'evt_gateway_action')

  socket.receive({ type: 'task.running', event_id: 'evt_task_1', sequence: 1 })
  socket.receive({ type: 'task.running', event_id: 'evt_task_1', sequence: 1 })
  assert.equal(received.length, 1)
  client.stop()
})

test('reference Client reconnects, replays from its cursor, then reconciles snapshots', async () => {
  const sockets = []
  const received = []
  let recovered
  const client = new GatewayClient({
    url: 'ws://gateway.test/api/realtime',
    createSocket: () => {
      const socket = new FakeSocket()
      sockets.push(socket)
      return socket
    },
    clientInstanceId: 'sdk-reconnect-test',
    capabilities: [
      GatewayClientCapability.SESSION_REPLAY,
      GatewayClientCapability.TASK_COMMANDS,
      GatewayClientCapability.CONVERSATION_HISTORY,
    ],
    reconnectMinMs: 50,
    reconnectMaxMs: 50,
    onEvent: event => received.push(event),
    onRecovery: value => { recovered = value },
  }).start()
  const first = sockets[0]
  first.open()
  first.receive({
    type: GatewayClientProtocolEvent.SESSION_READY,
    event_id: 'evt_ready_1',
    request_event_id: first.sent[0].event_id,
    protocol_version: '6.0.0',
    session_id: 'main',
    capabilities: [],
  })
  first.receive({ type: 'task.running', event_id: 'evt_task_1', sequence: 1 })
  first.readyState = 3
  first.emit('close')
  await new Promise(resolve => setTimeout(resolve, 60))

  const second = sockets[1]
  second.open()
  second.receive({
    type: GatewayClientProtocolEvent.SESSION_READY,
    event_id: 'evt_ready_2',
    request_event_id: second.sent[0].event_id,
    protocol_version: '6.0.0',
    session_id: 'main',
    capabilities: [
      GatewayClientCapability.SESSION_REPLAY,
      GatewayClientCapability.TASK_COMMANDS,
      GatewayClientCapability.CONVERSATION_HISTORY,
    ],
  })
  await new Promise(resolve => setImmediate(resolve))
  const replay = second.sent.find(event => event.type === GatewayClientProtocolEvent.SESSION_REPLAY)
  assert.equal(replay.after_sequence, 1)
  second.receive({
    type: GatewayClientProtocolEvent.SESSION_REPLAY_RESULT,
    event_id: 'evt_replay_result',
    request_event_id: replay.event_id,
    events: [{ type: 'task.completed', event_id: 'evt_task_2', sequence: 2 }],
    earliest_sequence: 1,
    latest_sequence: 2,
    next_sequence: 2,
    has_more: false,
  })
  await new Promise(resolve => setImmediate(resolve))
  const tasks = second.sent.find(event => event.type === GatewayClientProtocolEvent.TASK_LIST)
  second.receive({
    type: GatewayClientProtocolEvent.TASK_LIST_RESULT,
    event_id: 'evt_tasks_result',
    request_event_id: tasks.event_id,
    tasks: [],
  })
  await new Promise(resolve => setImmediate(resolve))
  const history = second.sent.find(event => event.type === GatewayClientProtocolEvent.CONVERSATION_HISTORY)
  second.receive({
    type: GatewayClientProtocolEvent.CONVERSATION_HISTORY_RESULT,
    event_id: 'evt_history_result',
    request_event_id: history.event_id,
    messages: [],
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(received.map(event => event.sequence), [1, 2])
  assert.deepEqual(recovered.events.map(event => event.sequence), [2])
  client.stop()
})
