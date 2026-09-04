import assert from 'node:assert/strict'
import test from 'node:test'
import {
  GATEWAY_WEBSOCKET_PROTOCOL,
  gatewayWebSocketBearer,
  gatewayWebSocketProtocols,
  selectGatewayWebSocketProtocol,
} from '../shared/gateway-websocket-auth.mjs'

const TOKEN = 'qwa_example-device-token_1234567890'

test('encodes a browser-safe WebSocket bearer without selecting the credential', () => {
  const protocols = gatewayWebSocketProtocols(TOKEN)
  assert.deepEqual(protocols, [
    GATEWAY_WEBSOCKET_PROTOCOL,
    `qwaudio.bearer.${TOKEN}`,
  ])
  assert.equal(gatewayWebSocketBearer(protocols.join(', ')), TOKEN)
  assert.equal(selectGatewayWebSocketProtocol(new Set(protocols)), GATEWAY_WEBSOCKET_PROTOCOL)
})

test('rejects malformed WebSocket bearer values', () => {
  assert.deepEqual(gatewayWebSocketProtocols(), [])
  assert.throws(() => gatewayWebSocketProtocols('not a token'))
  assert.equal(gatewayWebSocketBearer('qwaudio.bearer.short'), '')
  assert.equal(selectGatewayWebSocketProtocol(new Set(['other'])), false)
})
