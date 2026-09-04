import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'
import { createPrivateFileGatewayCredentialStore } from '../shared/gateway-file-credential-store.mjs'

test('terminal Gateway credentials use an owner-only revocable store', async t => {
  const directory = mkdtempSync(resolve(tmpdir(), 'qwaudio-cli-credential-'))
  const filePath = resolve(directory, 'credentials.json')
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const store = createPrivateFileGatewayCredentialStore({ filePath })
  await store.set('gateway/device', 'revocable-token')
  assert.equal(await store.get('gateway/device'), 'revocable-token')
  assert.equal(statSync(filePath).mode & 0o777, 0o600)
  assert.match(readFileSync(filePath, 'utf8'), /revocable-token/)
  assert.equal(await store.delete('gateway/device'), true)
  assert.equal(await store.get('gateway/device'), null)
})
