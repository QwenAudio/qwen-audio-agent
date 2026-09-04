import assert from 'node:assert/strict'
import test from 'node:test'
import { gatewayBrowserPairingPage } from '../src/access/browser-pairing-page.mjs'

test('browser pairing shell keeps credentials in the URL fragment', () => {
  const html = gatewayBrowserPairingPage()
  assert.match(html, /location\.hash/)
  assert.match(html, /\/api\/access\/pair/)
  assert.match(html, /location\.replace\('\/'\)/)
  assert.doesNotMatch(html, /access_token/)
  assert.doesNotMatch(html, /localStorage/)
})
