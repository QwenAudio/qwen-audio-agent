import assert from 'node:assert/strict'
import test from 'node:test'
import { isApprovalForPreview } from '../authorization-reply.mjs'

test('accepts plain and matching detailed approval, not a changed request', () => {
  const preview = 'Return item 8551474201 in order #W3069600 to credit_card_1565124'
  assert.equal(isApprovalForPreview('Yes, I approve.', preview), true)
  assert.equal(isApprovalForPreview('Yes, I approve the return of item 8551474201 in order #W3069600.', preview), true)
  assert.equal(isApprovalForPreview('Yes, I approve order #W9999999.', preview), false)
  assert.equal(isApprovalForPreview('Yes, but send it to gift_card_7250692 instead.', preview), false)
  assert.equal(isApprovalForPreview('Wait, return the more expensive tablet to a gift card instead.', preview), false)
  assert.equal(isApprovalForPreview('I want a different item.', preview), false)
})
