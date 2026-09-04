import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createGatewayPairingTicket,
  pairGatewayInvitation,
  pairGatewayDevice,
} from '../shared/gateway-access-client.mjs'

function jsonResponse(body, { status = 200 } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

test('Gateway access Client helpers use the access control endpoints', async () => {
  const requests = []
  const fetchImpl = async (url, options) => {
    requests.push({ url, options })
    if (url.endsWith('/api/access/pairing-tickets')) {
      return jsonResponse({ code: 'pair-code', expiresAt: 1234 }, { status: 201 })
    }
    return jsonResponse({
      access_token: 'device-token',
      owner_id: 'user_personal',
      device: { id: 'phone-one' },
    })
  }

  const ticket = await createGatewayPairingTicket('http://127.0.0.1:3101', fetchImpl)
  const paired = await pairGatewayDevice('https://gateway.example.test', {
    code: ticket.code,
    device: { id: 'phone-one', type: 'mobile' },
  }, fetchImpl)

  assert.equal(paired.access_token, 'device-token')
  assert.equal(requests[0].url, 'http://127.0.0.1:3101/api/access/pairing-tickets')
  assert.equal(requests[1].url, 'https://gateway.example.test/api/access/pair')
  assert.deepEqual(JSON.parse(requests[1].options.body), {
    code: 'pair-code',
    device: { id: 'phone-one', type: 'mobile' },
  })
})

test('Gateway access Client helpers preserve structured errors', async () => {
  await assert.rejects(
    pairGatewayDevice('https://gateway.example.test', { code: 'bad' }, async () => (
      jsonResponse({ error: 'expired', code: 'pairing_invalid' }, { status: 401 })
    )),
    error => error.code === 'pairing_invalid' && error.message === 'expired',
  )
})

test('a Gateway invitation pairs and persists through credential abstractions', async () => {
  const saved = []
  const result = await pairGatewayInvitation({
    version: 1,
    gateway_url: 'https://gateway.example.test',
    pairing_code: 'temporary-code',
    expires_at: 2_000,
  }, {
    device: { id: 'phone-one', type: 'mobile', label: 'Phone' },
    clientInstanceId: 'mobile-one',
    profileStore: { save: async (...args) => { saved.push(args); return args[0] } },
    now: 1_000,
    fetchImpl: async () => jsonResponse({
      access_token: 'device-token',
      owner_id: 'user_personal',
      device: { id: 'phone-one' },
    }),
  })
  assert.equal(result.profile.id, 'phone-one')
  assert.equal(result.profile.client_instance_id, 'mobile-one')
  assert.equal(saved[0][1], 'device-token')
  await assert.rejects(
    pairGatewayInvitation({
      version: 1,
      gateway_url: 'https://gateway.example.test',
      pairing_code: 'expired',
      expires_at: 999,
    }, { profileStore: { save: async () => {} }, now: 1_000 }),
    error => error.code === 'gateway_invitation_expired',
  )
})
