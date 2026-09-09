import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  desktopGatewayCredential,
  parseDesktopGatewayInput,
  prepareDesktopGatewayConnection,
} from '../src/gateway-connection.mjs'
import { clientSettingsPatch } from '../src/settings-config.mjs'
import { createSettingsStore } from '../src/settings-store.mjs'
import { GatewayConnectionProfileStore } from '../../shared/gateway/connection-profiles.mjs'
import {
  createGatewayDirectConnection,
  encodeGatewayBrowserDirectConnection,
  encodeGatewayBrowserPairingCode,
  encodeGatewayPairingCode,
} from '../../shared/gateway/remote-access.mjs'

const code = () => ({
  version: 1, gateway_url: 'https://gateway.example',
  pairing_code: 'one-use-secret', expires_at: Date.now() + 60_000,
})
const emptyProfiles = { resolve: async () => null }

function stores(t) {
  const root = mkdtempSync(join(tmpdir(), 'desktop-connect-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const secrets = new Map()
  const profiles = new GatewayConnectionProfileStore({
    filePath: join(root, 'connections.json'),
    credentialStore: {
      get: async key => secrets.get(key),
      set: async (key, value) => secrets.set(key, value),
      delete: async key => secrets.delete(key),
    },
  })
  const settings = createSettingsStore({ configDir: join(root, 'gateway'), clientDir: join(root, 'client'), env: {} })
  return { profiles, settings }
}

test('one field accepts local and remote origins', () => {
  for (const value of ['http://127.0.0.1:3101', 'http://localhost:3200/', 'https://[::1]:3101']) {
    assert.deepEqual(parseDesktopGatewayInput(` ${value} `), {
      origin: new URL(value).origin, remote: false, pairingCode: null,
    })
  }
  assert.deepEqual(parseDesktopGatewayInput('https://gateway.example/'), {
    origin: 'https://gateway.example', remote: true, pairingCode: null,
  })
})

test('imports a direct WSS connection code without an HTTP pairing or health request', async t => {
  const { profiles } = stores(t)
  const direct = createGatewayDirectConnection({
    gatewayUrl: 'https://voice.example.com',
    deviceId: 'direct-device',
    credentialId: 'device_key_direct',
    accessToken: 'AbCdEfGhIjKlMnOpQrStUv',
    label: 'Phone',
    issuedAt: 1_800_000_000_000,
  })
  const target = parseDesktopGatewayInput(encodeGatewayBrowserDirectConnection(direct))
  assert.equal(target.origin, 'https://voice.example.com')
  assert.equal(target.directConnection.access_token, direct.access_token)
  const result = await prepareDesktopGatewayConnection(target, {
    profileStore: profiles,
    clientInstanceId: 'desktop-instance',
    label: 'Desktop',
    fetchImpl: () => assert.fail('direct connection must not use HTTP'),
  })
  assert.deepEqual(result, { credential: direct.access_token, connected: true })
  const saved = await profiles.resolve('desktop')
  assert.equal(saved.credential, direct.access_token)
  assert.equal(saved.profile.gateway_url, 'https://voice.example.com')
  assert.match(saved.profile.credential_ref, /^gateway\/connection\//)
  assert.equal(JSON.stringify(saved.profile).includes(direct.access_token), false)
  assert.equal(readFileSync(profiles.filePath, 'utf8').includes(direct.access_token), false)
})

test('imports a tokenized direct LAN connection code', async t => {
  const { profiles } = stores(t)
  const direct = createGatewayDirectConnection({
    websocketUrl: 'ws://192.168.10.22:3101/api/realtime',
    deviceId: 'lan-device',
    credentialId: 'device_key_lan',
    accessToken: 'qwa_direct-lan-device-secret',
  })
  const target = parseDesktopGatewayInput(encodeGatewayBrowserDirectConnection(direct))
  assert.equal(target.origin, 'http://192.168.10.22:3101')
  assert.equal((await prepareDesktopGatewayConnection(target, {
    profileStore: profiles,
    clientInstanceId: 'desktop-lan',
  })).connected, true)
})

test('imports the short browser QR as a direct Gateway connection', () => {
  const direct = createGatewayDirectConnection({
    gatewayUrl: 'https://voice.example.com',
    deviceId: 'browser-device',
    credentialId: 'device_key_browser',
    accessToken: 'qwa_direct-browser-device-token',
  })
  const target = parseDesktopGatewayInput(encodeGatewayBrowserDirectConnection(direct))
  assert.equal(target.origin, 'https://voice.example.com')
  assert.equal(target.directConnection.access_token, direct.access_token)
})

for (const encode of [encodeGatewayPairingCode, encodeGatewayBrowserPairingCode]) {
  test(`decodes ${encode.name} before stripping URL parameters`, () => {
    const pairing = code()
    assert.deepEqual(parseDesktopGatewayInput(encode(pairing)), {
      origin: pairing.gateway_url, remote: true, pairingCode: pairing,
    })
  })

  test(`${encode.name} pairs, saves only the origin, and reconnects without pairing`, async t => {
    const { profiles, settings } = stores(t)
    const calls = []
    const fetchImpl = async (url, options) => {
      calls.push({ url, options })
      if (url.endsWith('/pair')) {
        assert.equal(JSON.parse(options.body).code, 'one-use-secret')
        assert.equal(JSON.parse(options.body).device.type, 'desktop')
        return Response.json({ device: { id: 'paired-device' }, access_token: 'private-device-token', owner_id: 'personal' })
      }
      assert.fail('remote connection must not perform an HTTP health preflight')
    }
    const target = parseDesktopGatewayInput(encode(code()))
    const options = { profileStore: profiles, clientInstanceId: 'desktop-device', label: 'Desktop', fetchImpl }
    const connection = await prepareDesktopGatewayConnection(target, options)
    assert.deepEqual(connection, { credential: 'private-device-token', connected: true })
    settings.save({ gatewayUrl: target.origin })
    const stored = readFileSync(settings.clientSettingsPath, 'utf8')
    assert.doesNotMatch(stored, /one-use-secret|private-device-token|qwaudio:/)
    assert.equal(settings.load().gatewayUrl, target.origin)
    await prepareDesktopGatewayConnection(parseDesktopGatewayInput(settings.load().gatewayUrl), options)
    assert.equal(calls.filter(call => call.url.endsWith('/pair')).length, 1)
    assert.equal(calls.length, 1)
  })
}

test('rejects malformed or unsafe URLs instead of silently dropping a credential or pairing payload', () => {
  for (const value of [
    '', 'not a url', 'ftp://gateway.example', 'http://gateway.example',
    'https://user:password@gateway.example', 'https://gateway.example/?token=secret',
    'https://gateway.example/#secret', 'https://gateway.example/another-path',
    'qwaudio://connect?gateway=https://gateway.example', 'https://gateway.example/c',
  ]) {
    assert.throws(() => parseDesktopGatewayInput(value), undefined, value)
  }
})

test('expired pairing codes fail before network or settings writes', async t => {
  const { profiles, settings } = stores(t)
  const original = settings.save({ gatewayUrl: 'http://127.0.0.1:3101' })
  await assert.rejects(prepareDesktopGatewayConnection(
    parseDesktopGatewayInput(encodeGatewayPairingCode({ ...code(), expires_at: 1 })), {
      profileStore: profiles, fetchImpl: () => assert.fail('must not fetch'),
    },
  ), { code: 'gateway_pairing_code_expired' })
  assert.equal(await profiles.resolve('desktop'), null)
  assert.deepEqual(settings.load(), original)
})

test('failed pairing leaves the saved profile and settings intact', async t => {
  const { profiles, settings } = stores(t)
  await profiles.save({ id: 'desktop', gateway_url: 'https://old.example', device_id: 'old', credential_ref: 'old', client_instance_id: 'desktop' }, 'old-secret')
  settings.save({ gatewayUrl: 'https://old.example' })
  await assert.rejects(prepareDesktopGatewayConnection(parseDesktopGatewayInput(encodeGatewayPairingCode(code())), {
    profileStore: profiles, clientInstanceId: 'desktop', label: 'Desktop',
    fetchImpl: async () => Response.json({ error: 'Pairing code already used', code: 'gateway_pairing_failed' }, { status: 403 }),
  }), /Pairing code already used/)
  assert.equal((await profiles.resolve('desktop')).credential, 'old-secret')
  assert.equal(settings.load().gatewayUrl, 'https://old.example')
})

test('credentials are matched to the exact Gateway origin, including a switch back to local', async t => {
  const { profiles } = stores(t)
  await profiles.save({ id: 'desktop', gateway_url: 'https://old.example', device_id: 'old', credential_ref: 'old', client_instance_id: 'desktop' }, 'old-secret')
  assert.equal(await desktopGatewayCredential('https://old.example', profiles), 'old-secret')
  assert.equal(await desktopGatewayCredential('https://new.example', profiles), '')
  assert.equal(await desktopGatewayCredential('http://127.0.0.1:3101', profiles), '')
})

test('legacy pairing also transitions directly to the single WSS runtime', async t => {
  const { profiles } = stores(t)
  await profiles.save({ id: 'desktop', gateway_url: 'https://old.example', device_id: 'old', credential_ref: 'old', client_instance_id: 'desktop' }, 'old-secret')
  const result = await prepareDesktopGatewayConnection(parseDesktopGatewayInput(encodeGatewayPairingCode(code())), {
    profileStore: profiles, clientInstanceId: 'desktop', label: 'Desktop',
    fetchImpl: async url => url.endsWith('/pair')
      ? Response.json({ device: { id: 'new' }, access_token: 'new-secret' })
      : assert.fail('legacy pairing must not add a health request'),
  })
  assert.deepEqual(result, { credential: 'new-secret', connected: true })
  assert.equal((await profiles.resolve('desktop')).credential, 'new-secret')
})

test('a bare remote origin requires a previously saved credential without probing HTTP', async () => {
  const target = parseDesktopGatewayInput('https://gateway.example')
  await assert.rejects(prepareDesktopGatewayConnection(target, {
    profileStore: emptyProfiles,
    fetchImpl: () => assert.fail('must not probe HTTP'),
  }), /需要认证/)
})

test('local Gateway detection distinguishes attaching from starting one', async () => {
  const target = parseDesktopGatewayInput('http://localhost:3101')
  const options = { profileStore: emptyProfiles, fetchImpl: async () => Response.json({ backend: { kind: 'none' } }) }
  assert.deepEqual(await prepareDesktopGatewayConnection(target, options), { credential: '', connected: true })
  options.fetchImpl = async () => { throw new Error('connection refused') }
  assert.deepEqual(await prepareDesktopGatewayConnection(target, options), { credential: '', connected: false })
})

test('remote settings apply client preferences without modifying local Gateway configuration', t => {
  const { settings } = stores(t)
  settings.save({ dashscopeApiKey: 'local-key', realtimeModel: 'local-model', agentProtocol: 'none' })
  const before = readFileSync(settings.path, 'utf8')
  const patch = clientSettingsPatch({
    gatewayUrl: 'https://gateway.example', orbSkin: 'goo', autoHideSeconds: 300,
    dashscopeApiKey: '', realtimeModel: 'different-model', agentProtocol: 'missing-agent',
    backendUrl: 'invalid-url', backendOwnership: 'external',
  })
  assert.doesNotThrow(() => settings.preview(patch))
  const result = settings.save(patch)
  assert.equal(result.gatewayUrl, 'https://gateway.example')
  assert.equal(result.orbSkin, 'goo')
  assert.equal(result.autoHideSeconds, 300)
  assert.equal(readFileSync(settings.path, 'utf8'), before)
})
