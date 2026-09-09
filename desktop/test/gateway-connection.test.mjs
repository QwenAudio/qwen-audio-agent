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
      assert.equal(options.headers.Authorization, 'Bearer private-device-token')
      // The remote model need not match any local setting.
      return Response.json({ backend: { kind: 'qwen-code', ok: true }, realtimeProvider: 'speech-to-speech' })
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
    assert.equal(calls.length, 3)
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

test('a failed health check after pairing preserves the previous saved connection', async t => {
  const { profiles } = stores(t)
  await profiles.save({ id: 'desktop', gateway_url: 'https://old.example', device_id: 'old', credential_ref: 'old', client_instance_id: 'desktop' }, 'old-secret')
  await assert.rejects(prepareDesktopGatewayConnection(parseDesktopGatewayInput(encodeGatewayPairingCode(code())), {
    profileStore: profiles, clientInstanceId: 'desktop', label: 'Desktop',
    fetchImpl: async url => url.endsWith('/pair')
      ? Response.json({ device: { id: 'new' }, access_token: 'new-secret' })
      : Response.json({ error: 'unavailable' }, { status: 503 }),
  }), /无法连接 Gateway/)
  assert.equal((await profiles.resolve('desktop')).credential, 'old-secret')
})

test('remote connection failures surface authentication or connectivity errors', async () => {
  const target = parseDesktopGatewayInput('https://gateway.example')
  for (const status of [401, 403, 500, 200]) {
    await assert.rejects(prepareDesktopGatewayConnection(target, {
      profileStore: emptyProfiles,
      fetchImpl: async () => Response.json({ error: 'not a Gateway health response' }, { status }),
    }), status === 401 || status === 403 ? /需要认证/ : /无法连接 Gateway/)
  }
  await assert.rejects(prepareDesktopGatewayConnection(target, {
    profileStore: emptyProfiles, fetchImpl: async () => { throw new Error('network timeout') },
  }), /无法连接 Gateway/)
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
