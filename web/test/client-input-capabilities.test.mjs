import assert from 'node:assert/strict'
import test from 'node:test'
import {
  clientInputCapabilities,
  supportsComposerInput,
} from '../../shared/client-input-capabilities.mjs'

test('WebUI advertises text, audio, image, observation, and resource input', () => {
  assert.deepEqual(clientInputCapabilities('web'), {
    text: true,
    audio: true,
    image: true,
    observation: true,
    resource: true,
  })
  assert.equal(supportsComposerInput('web'), true)
})
