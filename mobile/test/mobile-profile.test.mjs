import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createGatewayDirectConnection,
  encodeGatewayBrowserDirectConnection,
  encodeGatewayBrowserPairingCode,
  encodeGatewayPairingCode,
} from '../../shared/gateway/remote-access.mjs'
import {
  mobileGatewayTransport,
  pairMobileGateway,
  parseMobileGatewayProfile,
} from '../src/mobile-profile.js'

const pairingCode = encodeGatewayPairingCode({
  version: 1,
  gateway_url: 'https://voice.example.test',
  pairing_code: 'one-time-code',
  expires_at: Date.now() + 60_000,
})

test('pairs a mobile profile without exposing backend configuration', async () => {
  const requests = []
  const profile = await pairMobileGateway(pairingCode, {
    deviceId: 'phone-one',
    clientInstanceId: 'mobile-client-one',
    request: async (url, body) => {
      requests.push({ url, body })
      return {
        status: 200,
        data: {
          access_token: 'qwa_revocable-mobile-token',
          device: { id: 'phone-one' },
        },
      }
    },
  })
  assert.equal(requests[0].url, 'https://voice.example.test/api/access/pair')
  assert.equal(requests[0].body.device.type, 'mobile')
  assert.deepEqual(profile, {
    gatewayUrl: 'https://voice.example.test',
    accessToken: 'qwa_revocable-mobile-token',
    deviceId: 'phone-one',
    clientInstanceId: 'mobile-client-one',
    label: 'Mobile',
  })
})

test('imports a direct connection code without an HTTPS pairing request', async () => {
  const direct = createGatewayDirectConnection({
    gatewayUrl: 'https://voice.example.test',
    deviceId: 'direct-phone',
    credentialId: 'device_key_direct',
    accessToken: 'qwa_direct-mobile-device-token',
    label: 'AI Passport',
  })
  const profile = await pairMobileGateway(encodeGatewayBrowserDirectConnection(direct), {
    clientInstanceId: 'mobile-direct-one',
    request: () => assert.fail('direct connection must not use HTTP'),
  })
  const { deviceId, ...profileData } = profile
  assert.match(deviceId, /^device_connection_[0-9a-f-]{36}$/u)
  assert.equal(deviceId.includes(direct.access_token), false)
  assert.deepEqual(profileData, {
    gatewayUrl: 'https://voice.example.test',
    accessToken: 'qwa_direct-mobile-device-token',
    clientInstanceId: 'mobile-direct-one',
    label: 'Mobile',
  })
})

test('pairs from the compact browser link encoded in the CLI QR code', async () => {
  const browserPairingCode = encodeGatewayBrowserPairingCode({
    version: 1,
    gateway_url: 'https://voice.example.test',
    pairing_code: 'browser-code',
    expires_at: Date.now() + 60_000,
  })
  const profile = await pairMobileGateway(browserPairingCode, {
    deviceId: 'phone-browser-link',
    request: async (_url, body) => ({
      status: 200,
      data: {
        access_token: 'qwa_revocable-browser-link-token',
        device: { id: body.device.id },
      },
    }),
  })
  assert.equal(profile.gatewayUrl, 'https://voice.example.test')
})

test('imports the short direct browser QR without an HTTP pairing request', async () => {
  const direct = createGatewayDirectConnection({
    gatewayUrl: 'https://voice.example.test',
    deviceId: 'browser-direct-phone',
    credentialId: 'device_key_browser_direct',
    accessToken: 'qwa_direct-browser-device-token',
  })
  const profile = await pairMobileGateway(encodeGatewayBrowserDirectConnection(direct), {
    clientInstanceId: 'mobile-browser-direct',
    request: () => assert.fail('direct browser QR must not use HTTP pairing'),
  })
  assert.equal(profile.gatewayUrl, 'https://voice.example.test')
  assert.equal(profile.accessToken, direct.access_token)
  assert.equal(profile.clientInstanceId, 'mobile-browser-direct')
})

test('keeps the paired client instance stable across native app restarts', () => {
  const stored = {
    gatewayUrl: 'https://voice.example.test',
    accessToken: 'qwa_revocable-mobile-token',
    deviceId: 'mobile-device-one',
    clientInstanceId: 'mobile-client-one',
    label: 'Mobile',
  }
  assert.equal(parseMobileGatewayProfile(stored)?.clientInstanceId, 'mobile-client-one')
  assert.equal(parseMobileGatewayProfile({ ...stored })?.clientInstanceId, 'mobile-client-one')
  assert.deepEqual(mobileGatewayTransport(stored), {
    gatewayUrl: 'https://voice.example.test',
    accessToken: 'qwa_revocable-mobile-token',
    clientType: 'mobile',
    clientLabel: 'Mobile',
    clientInstanceId: 'mobile-client-one',
  })
})

test('requires a secure hostname endpoint and complete stored credentials', async () => {
  const insecure = encodeGatewayPairingCode({
    version: 1,
    gateway_url: 'http://machine.test:3101',
    pairing_code: 'one-time-code',
    expires_at: Date.now() + 60_000,
  })
  await assert.rejects(
    pairMobileGateway(insecure, { request: async () => ({ status: 200 }) }),
    error => error.code === 'mobile_gateway_requires_https',
  )
  assert.equal(parseMobileGatewayProfile({ gatewayUrl: 'https://machine.test' }), null)
})

test('imports a tokenized direct LAN IPv4 connection', async () => {
  const direct = createGatewayDirectConnection({
    websocketUrl: 'ws://192.168.10.22:3101/api/realtime',
    deviceId: 'lan-device',
    credentialId: 'device_key_lan',
    accessToken: 'qwa_direct-lan-device-secret',
  })
  const profile = await pairMobileGateway(encodeGatewayBrowserDirectConnection(direct))
  assert.equal(profile.gatewayUrl, 'http://192.168.10.22:3101')
  assert.equal(profile.accessToken, direct.access_token)
})
