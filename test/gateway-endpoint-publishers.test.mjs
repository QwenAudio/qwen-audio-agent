import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createGatewayEndpointPublisherRegistry,
  createLocalGatewayEndpointPublisher,
  createManualGatewayEndpointPublisher,
} from '../shared/gateway-endpoint-publishers.mjs'

test('local and manual endpoint publishers return canonical descriptors', async () => {
  const registry = createGatewayEndpointPublisherRegistry([
    createLocalGatewayEndpointPublisher({ url: 'http://127.0.0.1:3210/' }),
    createManualGatewayEndpointPublisher({ url: 'https://voice.example.test/' }),
  ])
  assert.equal((await registry.publish('local')).url, 'http://127.0.0.1:3210')
  assert.deepEqual(await registry.publish('manual'), {
    version: 1,
    url: 'https://voice.example.test',
    transport: 'websocket',
    secure: true,
    publisher: 'manual',
  })
  assert.equal((await registry.inspect('local')).published, true)
})

test('publisher registry rejects duplicate, unknown, and mislabeled implementations', async () => {
  const local = createLocalGatewayEndpointPublisher()
  assert.throws(
    () => createGatewayEndpointPublisherRegistry([local, local]),
    /Duplicate/,
  )
  const registry = createGatewayEndpointPublisherRegistry([{
    id: 'broken',
    inspect: async () => ({}),
    publish: async () => ({
      url: 'https://voice.example.test',
      secure: true,
      publisher: 'someone-else',
    }),
    unpublish: async () => ({}),
  }])
  await assert.rejects(registry.publish('broken'), /returned someone-else/)
  assert.throws(() => registry.inspect('missing'), error => (
    error.code === 'gateway_endpoint_publisher_unknown'
  ))
})
