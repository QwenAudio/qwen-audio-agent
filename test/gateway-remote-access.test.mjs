import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createGatewayInvitation,
  decodeGatewayInvitation,
  encodeGatewayBrowserInvitation,
  encodeGatewayInvitation,
  parseGatewayConnectionProfile,
  parseGatewayEndpointDescriptor,
  parseGatewayInvitation,
} from '../shared/gateway-remote-access.mjs'

test('remote endpoint descriptors expose only transport-neutral connection data', () => {
  assert.deepEqual(parseGatewayEndpointDescriptor({
    url: 'https://gateway.example.ts.net/',
    secure: true,
  }), {
    version: 1,
    url: 'https://gateway.example.ts.net',
    transport: 'websocket',
    secure: true,
  })
  assert.throws(() => parseGatewayEndpointDescriptor({
    url: 'https://gateway.example.test',
    secure: true,
    publisher: 'implementation-detail',
  }))
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
    }))
  }
  assert.throws(() => parseGatewayEndpointDescriptor({
    url: 'http://gateway.example.test',
    secure: true,
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
  const browser = new URL(encodeGatewayBrowserInvitation(invitation))
  assert.equal(browser.origin, invitation.gateway_url)
  assert.equal(browser.pathname, '/connect')
  assert.ok(browser.hash.length > 1)
  assert.throws(() => parseGatewayInvitation({ ...invitation, version: 2 }))
  assert.throws(() => parseGatewayInvitation({ ...invitation, backend: 'opencode' }))
})
