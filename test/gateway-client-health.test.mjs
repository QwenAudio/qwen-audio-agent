import assert from 'node:assert/strict'
import test from 'node:test'
import { readGatewayHealth } from '../shared/gateway-client.mjs'

test('Gateway health helper sends a native Client credential when provided', async () => {
  let options
  const health = await readGatewayHealth('https://gateway.example.test', async (_url, value) => {
    options = value
    return { json: async () => ({ backend: { enabled: false } }) }
  }, { accessToken: 'device-token' })
  assert.equal(health.backend.enabled, false)
  assert.equal(options.headers.Authorization, 'Bearer device-token')
})
