import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

test('bundled assets use the fixed native origins supported by each platform', () => {
  const { server } = JSON.parse(readFileSync(
    new URL('../capacitor.config.json', import.meta.url), 'utf8',
  ))
  // WKWebView cannot register HTTP(S) as a custom resource scheme.
  assert.equal(`${server.iosScheme}://${server.hostname}`, 'capacitor://qwaudio.local')
  assert.equal(`${server.androidScheme}://${server.hostname}`, 'https://qwaudio.local')
})
