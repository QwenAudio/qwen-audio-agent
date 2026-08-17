import assert from 'node:assert/strict'
import test from 'node:test'
import {
  canSubmitText,
  draftAfterTextAcknowledgement,
  matchesTextAcknowledgement,
  textMessageEvent,
} from '../src/text-input.js'

test('builds a trimmed text message without enabling text-only responses', () => {
  assert.deepEqual(textMessageEvent('  帮我整理今天的安排  '), {
    type: 'text.message',
    text: '帮我整理今天的安排',
  })
  assert.equal('textOnly' in textMessageEvent('hello'), false)
})

test('rejects empty text messages', () => {
  assert.equal(textMessageEvent('   '), null)
  assert.equal(textMessageEvent(null), null)
})

test('allows submission while the Gateway is writable without microphone access', () => {
  const ready = {
    text: 'hello',
    gatewayConnected: true,
    ownershipBusy: false,
    outputActive: false,
    submitting: false,
  }

  assert.equal(canSubmitText(ready), true)
  assert.equal(canSubmitText({ ...ready, text: '  ' }), false)
  assert.equal(canSubmitText({ ...ready, gatewayConnected: false }), false)
  assert.equal(canSubmitText({ ...ready, ownershipBusy: true }), false)
  assert.equal(canSubmitText({ ...ready, outputActive: true }), false)
  assert.equal(canSubmitText({ ...ready, submitting: true }), false)
})

test('matches only the pending user transcript acknowledgement', () => {
  const pending = '整理今天的安排'
  assert.equal(matchesTextAcknowledgement({
    type: 'transcript.final',
    role: 'user',
    content: pending,
  }, pending), true)
  assert.equal(matchesTextAcknowledgement({
    type: 'transcript.final',
    role: 'assistant',
    content: pending,
  }, pending), false)
  assert.equal(matchesTextAcknowledgement({
    type: 'transcript.delta',
    role: 'user',
    content: pending,
  }, pending), false)
})

test('clears an acknowledged draft but preserves edits made while pending', () => {
  assert.equal(draftAfterTextAcknowledgement('  hello  ', 'hello'), '')
  assert.equal(draftAfterTextAcknowledgement('next message', 'hello'), 'next message')
})
