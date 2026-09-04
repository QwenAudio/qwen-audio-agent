import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createGatewayInvitation,
  decodeGatewayInvitation,
  defineGatewayEndpointPublisher,
  encodeGatewayInvitation,
  parseGatewayConnectionProfile,
  parseGatewayEndpointDescriptor,
  parseGatewayInvitation,
} from '../shared/gateway-remote-access.mjs'

test('endpoint publisher contract is small and provider-neutral', async () => {
  const publisher = defineGatewayEndpointPublisher({
    id: 'test-publisher',
    inspect: async () => ({ available: true }),
    publish: async () => ({ url: 'https://gateway.example.test' }),
    unpublish: async () => ({ published: false }),
  })
  assert.equal(publisher.id, 'test-publisher')
  assert.deepEqual(await publisher.inspect(), { available: true })
  assert.throws(() => defineGatewayEndpointPublisher({
    id: 'incomplete',
    inspect: async () => ({}),
  }), /requires publish/)
})

test('remote endpoint descriptors normalize an origin and preserve publisher neutrality', () => {
  assert.deepEqual(parseGatewayEndpointDescriptor({
    url: 'https://gateway.example.ts.net/',
    secure: true,
    publisher: 'tailscale',
  }), {
    version: 1,
    url: 'https://gateway.example.ts.net',
    transport: 'websocket',
    secure: true,
    publisher: 'tailscale',
  })
})

test('remote endpoint descriptors reject contaminated or inconsistent URLs', () => {
  for (const url of [
    'wss://gateway.example.test',
    'https://user:secret@gateway.example.test',
    'https://gateway.example.test/path',
    'https://gateway.example.test?token=secret',
    'https://gateway.example.test/#secret',
  ]) {
    assert.throws(() => parseGatewayEndpointDescriptor({
      url,
      secure: true,
      publisher: 'manual',
    }))
  }
  assert.throws(() => parseGatewayEndpointDescriptor({
    url: 'http://gateway.example.test',
    secure: true,
    publisher: 'manual',
  }))
})

test('connection profiles store a credential reference and never a credential', () => {
  const profile = parseGatewayConnectionProfile({
    id: 'phone',
    gateway_url: 'https://gateway.example.test',
    device_id: 'device_phone',
    credential_ref: 'secure-store/device_phone',
    client_instance_id: 'mobile_phone',
    label: 'My phone',
  })
  assert.equal(profile.gateway_url, 'https://gateway.example.test')
  assert.equal(profile.credential_ref, 'secure-store/device_phone')
  assert.throws(() => parseGatewayConnectionProfile({
    ...profile,
    access_token: 'must-not-be-serialized',
  }))
})

test('invitations are versioned, bounded records without permanent credentials', () => {
  const invitation = createGatewayInvitation({
    gatewayUrl: 'https://gateway.example.test',
    pairingCode: 'temporary-code',
    expiresAt: 1_800_000_000_000,
  })
  assert.deepEqual(parseGatewayInvitation(invitation), invitation)
  assert.equal(invitation.version, 1)
  assert.equal('access_token' in invitation, false)
  assert.deepEqual(decodeGatewayInvitation(encodeGatewayInvitation(invitation)), invitation)
  assert.throws(() => parseGatewayInvitation({ ...invitation, version: 2 }))
  assert.throws(() => parseGatewayInvitation({ ...invitation, backend: 'opencode' }))
})
