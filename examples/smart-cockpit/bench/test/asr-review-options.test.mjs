import test from 'node:test'
import assert from 'node:assert/strict'
import { configureAsrReview } from '../runner/asr-review-options.mjs'

test('ASR bench flags are validated, persisted and default off', () => {
  const env = {}
  assert.equal(configureAsrReview(new Map(), env).enabled, false)
  const options = configureAsrReview(new Map([['asr-review', 'on'], ['asr-delegation', 'dual-query']]), env)
  assert.deepEqual(options, { enabled: true, frontend: true, backend: true, delegation: 'dual-query' })
  assert.equal(env.QWEN_AUDIO_ASR_DELEGATION, 'dual-query')
  assert.throws(() => configureAsrReview(new Map([['asr-review', 'typo']]), {}))
})

test('CLI supports separate switches including overriding legacy on with both off', () => {
  const env = { QWEN_AUDIO_ASR_REVIEW: 'on' }
  const options = configureAsrReview(new Map([['asr-frontend-review', 'off'], ['asr-delegation-review', 'off']]), env)
  assert.equal(options.enabled, false)
  assert.equal(options.frontend, false)
  assert.equal(options.backend, false)
})
