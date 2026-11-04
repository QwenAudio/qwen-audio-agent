import test from 'node:test'
import assert from 'node:assert/strict'
import { configureAsrReview } from '../runner/asr-review-options.mjs'

test('ASR bench flags are validated, persisted and default off', () => {
  const env = {}
  assert.equal(configureAsrReview(new Map(), env).enabled, false)
  const options = configureAsrReview(new Map([['asr-review', 'on'], ['asr-delegation', 'dual-query']]), env)
  assert.deepEqual(options, { enabled: true, delegation: 'dual-query' })
  assert.equal(env.QWEN_AUDIO_ASR_DELEGATION, 'dual-query')
  assert.throws(() => configureAsrReview(new Map([['asr-review', 'typo']]), {}))
})
