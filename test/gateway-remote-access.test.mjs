import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createGatewayPairingCode,
  decodeGatewayPairingCode,
  encodeGatewayBrowserPairingCode,
  encodeGatewayPairingCode,
  parseGatewayConnectionProfile,
  parseGatewayEndpointDescriptor,
  parseGatewayPairingCode,
} from '../shared/gateway/remote-access.mjs'

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

test('pairing codes are versioned, bounded records without permanent credentials', () => {
  const pairingCode = createGatewayPairingCode({
    gatewayUrl: 'https://gateway.example.test',
    pairingCode: 'temporary-code',
    expiresAt: 1_800_000_000_000,
  })
  assert.deepEqual(parseGatewayPairingCode(pairingCode), pairingCode)
  assert.equal(pairingCode.version, 1)
  assert.equal('access_token' in pairingCode, false)
  const appUrl = new URL(encodeGatewayPairingCode(pairingCode))
  assert.equal(appUrl.protocol, 'qwaudio:')
  assert.equal(appUrl.hostname, 'connect')
  assert.equal(appUrl.searchParams.get('v'), '1')
  assert.equal(appUrl.searchParams.get('gateway'), pairingCode.gateway_url)
  assert.equal(appUrl.searchParams.get('code'), pairingCode.pairing_code)
  assert.equal(appUrl.searchParams.get('expires'), String(pairingCode.expires_at))
  assert.equal(appUrl.hash, '')
  assert.deepEqual(decodeGatewayPairingCode(appUrl), pairingCode)
  const browser = new URL(encodeGatewayBrowserPairingCode(pairingCode))
  assert.equal(browser.origin, pairingCode.gateway_url)
  assert.equal(browser.pathname, '/c')
  assert.equal(browser.searchParams.get('e'), pairingCode.expires_at.toString(36))
  assert.equal(decodeURIComponent(browser.hash.slice(1)), pairingCode.pairing_code)
  assert.deepEqual(decodeGatewayPairingCode(browser), pairingCode)
  assert.throws(
    () => decodeGatewayPairingCode(
      `qwaudio://connect#${encodeURIComponent(JSON.stringify(pairingCode))}`,
    ),
    error => error.code === 'gateway_pairing_code_invalid',
  )
  assert.throws(() => parseGatewayPairingCode({ ...pairingCode, version: 2 }))
  assert.throws(() => parseGatewayPairingCode({ ...pairingCode, backend: 'opencode' }))
})
