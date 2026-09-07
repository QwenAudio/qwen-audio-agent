import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const manifestUrl = new URL(
  '../android/app/src/main/AndroidManifest.xml',
  import.meta.url,
)

test('Android declares every permission requested by WebView audio capture', async () => {
  const manifest = await readFile(manifestUrl, 'utf8')
  assert.match(manifest, /android\.permission\.RECORD_AUDIO/)
  assert.match(manifest, /android\.permission\.MODIFY_AUDIO_SETTINGS/)
})
