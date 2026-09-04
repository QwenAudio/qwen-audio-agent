import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  createMemoryGatewayCredentialStore,
  GatewayConnectionProfileStore,
} from '../shared/gateway-connection-profiles.mjs'

function profile(id, overrides = {}) {
  return {
    id,
    gateway_url: 'https://voice.example.test',
    device_id: `device_${id}`,
    credential_ref: `gateway/device_${id}`,
    client_instance_id: `client_${id}`,
    ...overrides,
  }
}

test('connection profile persistence never serializes credentials', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'qwaudio-profiles-'))
  const filePath = join(directory, 'gateway-connections.json')
  const credentials = createMemoryGatewayCredentialStore()
  const store = new GatewayConnectionProfileStore({ filePath, credentialStore: credentials })
  await store.save(profile('phone'), 'device-secret')

  assert.equal(store.list().length, 1)
  assert.equal((await store.resolve('phone')).credential, 'device-secret')
  assert.doesNotMatch(readFileSync(filePath, 'utf8'), /device-secret/)
  assert.equal(await store.remove('phone'), true)
  assert.equal(await store.resolve('phone'), null)
  assert.equal(await credentials.get('gateway/device_phone'), null)
})

test('connection profiles update credentials and metadata by profile id', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'qwaudio-profiles-'))
  const filePath = join(directory, 'gateway-connections.json')
  const store = new GatewayConnectionProfileStore({
    filePath,
    credentialStore: createMemoryGatewayCredentialStore(),
  })
  await store.save(profile('desktop'), 'first')
  await store.save(profile('desktop', { label: 'Remote desktop' }), 'second')
  assert.equal(store.list().length, 1)
  assert.equal((await store.resolve('desktop')).credential, 'second')
})
