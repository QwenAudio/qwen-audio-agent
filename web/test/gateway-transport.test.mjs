import assert from 'node:assert/strict'
import test from 'node:test'
import {
  configureGatewayTransport,
  createGatewayWebSocket,
  gatewayFetch,
  gatewayHttpUrl,
  gatewayRealtimeUrl,
} from '../src/gateway-transport.js'

test.afterEach(() => configureGatewayTransport())

test('keeps the existing same-origin browser transport by default', () => {
  assert.equal(gatewayHttpUrl('api/health'), 'api/health')
  assert.equal(
    gatewayRealtimeUrl('voice one', new URL('https://example.test/app/index.html')),
    'wss://example.test/app/api/realtime?sessionId=voice%20one',
  )
})

test('routes mobile HTTP and WebSocket traffic through a secure remote profile', async () => {
  configureGatewayTransport({
    gatewayUrl: 'https://voice.example.test',
    accessToken: 'qwa_example-device-token_1234567890',
    clientType: 'mobile',
  })
  const requests = []
  await gatewayFetch('api/health', { cache: 'no-store' }, async (url, init) => {
    requests.push({ url, init })
    return { ok: true }
  })
  assert.equal(requests[0].url, 'https://voice.example.test/api/health')
  assert.equal(
    requests[0].init.headers.get('authorization'),
    'Bearer qwa_example-device-token_1234567890',
  )
  assert.equal(
    gatewayRealtimeUrl('mobile-session'),
    'wss://voice.example.test/api/realtime?sessionId=mobile-session',
  )
  const sockets = []
  class FakeWebSocket {
    constructor(url, protocols) {
      sockets.push({ url, protocols })
    }
  }
  createGatewayWebSocket(gatewayRealtimeUrl('mobile-session'), {}, FakeWebSocket)
  assert.equal(sockets[0].protocols[0], 'qwaudio.gcp.v6')
  assert.match(sockets[0].protocols[1], /^qwaudio\.bearer\.qwa_/)
})

test('never sends browser credentials over an insecure remote socket', () => {
  configureGatewayTransport({
    gatewayUrl: 'http://machine.test:3101',
    accessToken: 'qwa_example-device-token_1234567890',
  })
  assert.throws(
    () => createGatewayWebSocket(gatewayRealtimeUrl('mobile'), {}, class {}),
    /secure WebSocket/,
  )
})
