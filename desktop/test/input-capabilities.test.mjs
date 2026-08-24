import assert from 'node:assert/strict'
import test from 'node:test'
import {
  clientInputCapabilities,
  supportsComposerInput,
} from '../../shared/client-input-capabilities.mjs'

test('desktop connection supports the conversation panel inputs', () => {
  assert.deepEqual(clientInputCapabilities('desktop'), {
    text: true,
    audio: true,
    image: true,
    resource: true,
  })
  assert.equal(supportsComposerInput('desktop'), true)
})
