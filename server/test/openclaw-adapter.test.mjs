import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { PACKAGE_VERSION } from '../src/core/package-version.mjs'
import {
  OpenClawAcpDelegationAdapter,
} from '../src/agent/openclaw-adapter.mjs'

class FakeWebSocket extends EventEmitter {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSED = 3
  static requests = []
  static waitResponses = []

  constructor(url) {
    super()
    this.url = url
    this.readyState = FakeWebSocket.OPEN
    queueMicrotask(() => this.emit('message', JSON.stringify({
      type: 'event',
      event: 'connect.challenge',
    })))
  }

  send(raw) {
    const request = JSON.parse(raw)
    FakeWebSocket.requests.push(request)
    let payload = {}
    if (request.method === 'agent.wait') {
      payload = FakeWebSocket.waitResponses.shift()
    }
    if (request.method === 'chat.history') {
      payload = {
        messages: [
          { role: 'assistant', content: 'authoritative child result' },
        ],
      }
    }
    queueMicrotask(() => this.emit('message', JSON.stringify({
      type: 'res',
      id: request.id,
      ok: true,
      payload,
    })))
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED
    queueMicrotask(() => this.emit('close'))
  }
}

test('waits for the exact OpenClaw run and reads its Session history', async () => {
  FakeWebSocket.requests = []
  FakeWebSocket.waitResponses = [
    { status: 'timeout' },
    { status: 'ok' },
  ]
  const adapter = new OpenClawAcpDelegationAdapter({
    baseUrl: 'http://127.0.0.1:18789',
    token: 'secret',
    WebSocketImpl: FakeWebSocket,
  })

  const result = await adapter.wait({
    runId: 'run-one',
    sessionId: 'agent:child:one',
  })

  assert.equal(result.content, 'authoritative child result')
  const requests = FakeWebSocket.requests.filter(item => (
    item.method !== 'connect'
  ))
  assert.deepEqual(requests.map(item => item.method), [
    'agent.wait',
    'agent.wait',
    'chat.history',
  ])
  assert.equal(requests[0].params.runId, 'run-one')
  assert.equal(requests[2].params.sessionKey, 'agent:child:one')
  assert.equal(
    FakeWebSocket.requests[0].params.auth.token,
    'secret',
  )
  assert.equal(
    FakeWebSocket.requests[0].params.client.version,
    PACKAGE_VERSION,
  )
  assert.equal(FakeWebSocket.requests[0].params.minProtocol, 3)
  assert.equal(FakeWebSocket.requests[0].params.maxProtocol, 4)
  assert.deepEqual(FakeWebSocket.requests[0].params.scopes, [
    'operator.read',
    'operator.write',
    'operator.admin',
  ])
})

test('cancels an OpenClaw child by run and Session identity', async () => {
  FakeWebSocket.requests = []
  const adapter = new OpenClawAcpDelegationAdapter({
    baseUrl: 'http://127.0.0.1:18789',
    WebSocketImpl: FakeWebSocket,
  })

  await adapter.cancel({
    runId: 'run-two',
    sessionId: 'agent:child:two',
  })

  const abort = FakeWebSocket.requests.find(item => item.method === 'chat.abort')
  assert.deepEqual(abort.params, {
    runId: 'run-two',
    sessionKey: 'agent:child:two',
  })
})
