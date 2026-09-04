import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'
import { createElectronGatewayCredentialStore } from '../src/gateway-credential-store.mjs'

test('desktop Gateway credentials are encrypted at rest', async t => {
  const directory = mkdtempSync(resolve(tmpdir(), 'qwaudio-desktop-credential-'))
  const filePath = resolve(directory, 'credentials.json')
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const safeStorage = {
    encryptString: value => Buffer.from(`encrypted:${value}`),
    decryptString: value => value.toString().replace(/^encrypted:/, ''),
  }
  const store = createElectronGatewayCredentialStore({ filePath, safeStorage })
  await store.set('gateway/device', 'secret-device-token')
  assert.equal(await store.get('gateway/device'), 'secret-device-token')
  assert.doesNotMatch(readFileSync(filePath, 'utf8'), /secret-device-token/)
  assert.equal(await store.delete('gateway/device'), true)
  assert.equal(await store.get('gateway/device'), null)
})
