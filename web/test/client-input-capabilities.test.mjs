import assert from 'node:assert/strict'
import test from 'node:test'
import {
  clientInputCapabilities,
  supportsComposerInput,
} from '../../shared/client-input-capabilities.mjs'

test('WebUI advertises conversation inputs and live visual capture', () => {
  assert.deepEqual(clientInputCapabilities('web'), {
    text: true,
    audio: true,
    image: true,
    visualStream: true,
    resource: true,
  })
  assert.equal(supportsComposerInput('web'), true)
})
