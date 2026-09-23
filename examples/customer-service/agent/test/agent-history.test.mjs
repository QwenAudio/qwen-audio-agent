import assert from 'node:assert/strict'
import test from 'node:test'
import { AgentHistory } from '../agent-history.mjs'

test('history keeps 50 complete turns and reserves space for the next request', () => {
  const history = new AgentHistory()
  for (let i = 0; i < 55; i++) history.append('one', `request-${i}`, `reply-${i}`)
  assert.equal(history.contexts.get('one').length, 50)
  const messages = history.messages('one')
  assert.equal(messages.length, 98)
  assert.deepEqual(messages[0], { role: 'user', content: 'request-6' })
  assert.deepEqual(messages.at(-1), { role: 'assistant', content: 'reply-54' })
  for (let i = 0; i < messages.length; i += 2) {
    assert.equal(messages[i].role, 'user')
    assert.equal(messages[i + 1].role, 'assistant')
  }
})

test('history isolates contexts, returns copies, and bounds inactive contexts', () => {
  const history = new AgentHistory({ maxTurns: 2, maxContexts: 2 })
  history.append('one', 'one', 'answer-one')
  history.append('two', 'two', 'answer-two')
  assert.deepEqual(history.messages('unknown'), [])
  history.messages('one')[0].content = 'mutation'
  assert.equal(history.messages('one')[0].content, 'one')
  history.append('one', 'latest-one', 'latest-answer')
  history.append('three', 'three', 'answer-three')
  assert.deepEqual(history.messages('two'), [])
  assert.equal(history.messages('one')[0].content, 'latest-one')
})

test('a missing context is never shared and invalid history limits fail early', () => {
  const history = new AgentHistory({ maxTurns: 1 })
  history.append('', 'private', 'reply')
  assert.equal(history.contexts.size, 0)
  history.append('one', 'one', 'reply')
  assert.deepEqual(history.messages('one'), [])
  for (const value of [0, -1, Infinity, 1.5]) {
    assert.throws(() => new AgentHistory({ maxTurns: value }), TypeError)
    assert.throws(() => new AgentHistory({ maxContexts: value }), TypeError)
  }
})

test('history metadata follows the same turn window and cannot be mutated by callers', () => {
  const history = new AgentHistory({ maxTurns: 2 })
  const metadata = { sources: [{ url: 'https://example.com' }] }
  history.append('one', 'research', 'report', metadata)
  metadata.sources.length = 0
  const copy = history.metadata('one')
  assert.equal(copy[0].sources.length, 1)
  copy[0].sources.length = 0
  assert.equal(history.metadata('one')[0].sources.length, 1)
  history.append('one', 'follow-up', 'reply')
  assert.deepEqual(history.metadata('one'), [{}])
})
