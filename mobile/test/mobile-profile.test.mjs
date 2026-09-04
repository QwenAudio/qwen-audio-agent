import assert from 'node:assert/strict'
import test from 'node:test'
import { encodeGatewayInvitation } from '../../shared/gateway-remote-access.mjs'
import { pairMobileGateway, parseMobileGatewayProfile } from '../src/mobile-profile.js'

const invitation = encodeGatewayInvitation({
  version: 1,
  gateway_url: 'https://machine.tailnet.ts.net',
  pairing_code: 'one-time-code',
  expires_at: Date.now() + 60_000,
})

test('pairs a mobile profile without exposing backend configuration', async () => {
  const requests = []
  const profile = await pairMobileGateway(invitation, {
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
  assert.equal(requests[0].url, 'https://machine.tailnet.ts.net/api/access/pair')
  assert.equal(requests[0].body.device.type, 'mobile')
  assert.deepEqual(profile, {
    gatewayUrl: 'https://machine.tailnet.ts.net',
    accessToken: 'qwa_revocable-mobile-token',
    deviceId: 'phone-one',
    clientInstanceId: 'mobile-client-one',
    label: 'Mobile',
  })
})

test('requires a secure remote endpoint and complete stored credentials', async () => {
  const insecure = encodeGatewayInvitation({
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
