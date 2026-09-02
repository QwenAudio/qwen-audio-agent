import assert from 'node:assert/strict'
import test from 'node:test'
import {
  SessionPermissionPolicy,
} from '../src/voice/session-permission-policy.mjs'

test('keeps automatic permission scoped to one owner and frontend session', () => {
  const policy = new SessionPermissionPolicy()

  assert.equal(policy.mode('owner-one', 'voice-one'), 'ask')
  policy.applyDecision('owner-one', 'voice-one', 'always')
  assert.equal(policy.shouldAutoAllow('owner-one', 'voice-one'), true)
  assert.equal(policy.shouldAutoAllow('owner-one', 'voice-two'), false)
  assert.equal(policy.shouldAutoAllow('owner-two', 'voice-one'), false)

  policy.applyDecision('owner-one', 'voice-one', 'reject')
  assert.equal(policy.mode('owner-one', 'voice-one'), 'ask')

  policy.applyDecision('owner-one', 'voice-one', 'once')
  assert.equal(policy.mode('owner-one', 'voice-one'), 'ask')
})

test('expires inactive frontend permission sessions', () => {
  let now = 100
  const policy = new SessionPermissionPolicy({
    ttlMs: 50,
    now: () => now,
  })
  policy.applyDecision('owner', 'voice', 'always')
  now = 151

  assert.equal(policy.shouldAutoAllow('owner', 'voice'), false)
})
