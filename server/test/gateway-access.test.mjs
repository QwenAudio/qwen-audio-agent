import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'
import {
  GatewayAccessManager,
  GatewayDeviceRegistry,
  isLoopbackRequest,
  parseGatewayAccessKeys,
} from '../src/access/gateway-access.mjs'
import { IdentityManager } from '../src/core/identity.mjs'

const SECRET = 'test-secret-that-is-longer-than-thirty-two-characters'
const ACCESS_TOKEN = 'remote-access-token-with-at-least-24-characters'

function request({
  host = 'gateway.example.test',
  remoteAddress = '192.0.2.10',
  authorization,
  cookie,
} = {}) {
  return {
    headers: { host, authorization, cookie },
    socket: { remoteAddress },
  }
}

function response() {
  return {
    headers: {},
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value
    },
  }
}

function runtime(options = {}) {
  const identityManager = new IdentityManager({
    secret: SECRET,
    mode: 'personal',
    personalOwnerId: 'user_personal',
  })
  return new GatewayAccessManager({
    identityManager,
    secret: SECRET,
    configuredKeys: parseGatewayAccessKeys({
      accessToken: ACCESS_TOKEN,
      personalOwnerId: 'user_personal',
    }),
    ...options,
  })
}

test('parses a personal access token and explicit multi-owner access keys', () => {
  const keys = parseGatewayAccessKeys({
    accessToken: ACCESS_TOKEN,
    personalOwnerId: 'user_personal',
    accessKeys: JSON.stringify([{
      token: 'second-remote-token-with-at-least-24-characters',
      owner_id: 'user_second',
      label: 'Second user',
    }]),
  })
  assert.deepEqual(keys.map(key => key.ownerId), ['user_personal', 'user_second'])
  assert.equal('token' in keys[0], false)
  assert.throws(() => parseGatewayAccessKeys({ accessToken: 'too-short' }), /24/)
})

test('keeps loopback access zero-config and requires credentials remotely', () => {
  const access = runtime()
  const local = request({ host: '127.0.0.1:3101', remoteAddress: '127.0.0.1' })
  assert.equal(isLoopbackRequest(local), true)
  assert.deepEqual(access.resolveUpgrade(local), {
    ownerId: 'user_personal',
    access: 'local',
  })
  assert.equal(access.resolveUpgrade(request()), null)
})

test('exchanges a remote Bearer credential for a revocable HTTP-only session', () => {
  const access = runtime()
  const res = response()
  const identity = access.resolveHttp(request({
    authorization: `Bearer ${ACCESS_TOKEN}`,
  }), res)
  assert.equal(identity.ownerId, 'user_personal')
  assert.equal(identity.access, 'remote')
  assert.match(res.headers['set-cookie'], /qwen_audio_agent_access=/)
  assert.match(res.headers['set-cookie'], /HttpOnly/)
  assert.doesNotMatch(res.headers['set-cookie'], new RegExp(ACCESS_TOKEN))

  const cookie = res.headers['set-cookie'].split(';')[0]
  assert.equal(access.resolveUpgrade(request({ cookie })).ownerId, 'user_personal')
})

test('redeems one-time pairing tickets into persisted, revocable device tokens', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'qwa-access-'))
  try {
    const registry = new GatewayDeviceRegistry({
      filePath: resolve(directory, 'devices.json'),
    })
    const access = runtime({ deviceRegistry: registry })
    const ticket = access.createPairingTicket()
    const paired = access.redeemPairingTicket(ticket.code, {
      device: { id: 'phone-one', type: 'mobile', label: 'My phone' },
    })
    assert.equal(paired.device.id, 'phone-one')
    assert.equal(paired.device.type, 'mobile')
    assert.equal(access.redeemPairingTicket(ticket.code), null)
    const pairedIdentity = access.resolveUpgrade(request({
      authorization: `Bearer ${paired.token}`,
    }))
    assert.equal(pairedIdentity.ownerId, 'user_personal')
    assert.equal(pairedIdentity.credentialId, paired.credentialId)
    assert.equal(pairedIdentity.clientType, 'mobile')

    const restored = new GatewayDeviceRegistry({
      filePath: resolve(directory, 'devices.json'),
    })
    assert.equal(restored.list()[0].label, 'My phone')
    assert.equal(restored.revoke('phone-one'), true)
    const restarted = runtime({ deviceRegistry: restored })
    assert.equal(restarted.resolveUpgrade(request({
      authorization: `Bearer ${paired.token}`,
    })), null)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('accepts a remote browser credential in the WebSocket subprotocol header', () => {
  const access = runtime()
  const identity = access.resolveUpgrade(request({
    authorization: undefined,
    host: 'gateway.example.test',
  }))
  assert.equal(identity, null)
  const authenticated = access.resolveUpgrade({
    ...request(),
    headers: {
      ...request().headers,
      'sec-websocket-protocol': `qwaudio.gcp.v6, qwaudio.bearer.${ACCESS_TOKEN}`,
    },
  })
  assert.equal(authenticated.ownerId, 'user_personal')
  assert.equal(authenticated.access, 'remote')
})
