import assert from 'node:assert/strict'
import test from 'node:test'
import { recentDelegationHistory } from '../src/frontend/tools/delegation-history.mjs'

test('captures ten recent customer turns with assistant replies in order', () => {
  const messages = Array.from({ length: 12 }, (_, index) => [
    { role: 'user', content: `customer ${index}` },
    { role: 'assistant', content: `reply ${index}` },
  ]).flat()
  const history = recentDelegationHistory(messages, 10)
  assert.equal(history.length, 20)
  assert.deepEqual(history[0], { role: 'user', content: 'customer 2' })
  assert.deepEqual(history.at(-1), { role: 'assistant', content: 'reply 11' })
  assert.deepEqual(recentDelegationHistory(messages, 0), [])
})

test('drops internal messages and bounds long dialogue', () => {
  const history = recentDelegationHistory([
    { role: 'assistant', content: 'old preface' },
    { role: 'tool', content: 'secret tool result' },
    { role: 'user', content: 'a'.repeat(2_000) },
    { role: 'assistant', content: 'b'.repeat(2_000) },
  ], 10)
  assert.equal(history.length, 2)
  assert.equal(history[0].content.length, 1_000)
  assert.equal(history[1].content.length, 1_000)
})
