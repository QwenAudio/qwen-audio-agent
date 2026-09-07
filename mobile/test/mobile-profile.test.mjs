import assert from 'node:assert/strict'
import test from 'node:test'
import {
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

test('requires a secure remote endpoint and complete stored credentials', async () => {
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
