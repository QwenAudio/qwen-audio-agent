import assert from 'node:assert/strict'
import test from 'node:test'
import { ConversationSync } from '../src/conversation/conversation-sync.mjs'
import {
  captureCoordinatorConversation,
  conversationDelta,
} from '../src/core/work-conversation-context.mjs'

const context = { ownerId: 'owner', sessionId: 'voice' }

function record(sync, id, content, options = {}) {
  return sync.record({
    ...context, id, content, role: 'user', source: 'voice-user',
    createdAt: 1_000, ...options,
  })
}

function snapshot(sync, options = {}) {
  return sync.coordinatorSnapshot({ ...context, ...options })
}

test('captures only final human inputs and natural assistant presentations', () => {
  const sync = new ConversationSync()
  record(sync, 'voice', 'a final spoken input')
  record(sync, 'typed', 'a final typed input', { source: 'text-user' })
  record(sync, 'direct', 'a natural answer', { role: 'assistant', source: 'realtime-direct' })
  record(sync, 'presented', 'a spoken result', { role: 'assistant', source: 'agent-presentation' })
  record(sync, 'raw', 'private backend result', { role: 'assistant', source: 'agent-result' })
  record(sync, 'tool', 'raw tool output', { role: 'tool', source: 'tool-result' })
  record(sync, 'wrong-role', 'not human input', { role: 'assistant', source: 'voice-user' })
  record(sync, 'partial', 'not final', { final: false })

  const captured = snapshot(sync)
  assert.deepEqual(captured.messages.map(message => message.id), ['voice', 'typed', 'direct', 'presented'])
  assert.equal(captured.cursor.messageId, 'presented')
  assert.deepEqual(Object.keys(captured.messages[0]).sort(), ['id', 'role', 'content', 'position'].sort())
  assert.equal(conversationDelta(captured).text, [
    'User: a final spoken input', 'User: a final typed input',
    'Assistant: a natural answer', 'Assistant: a spoken result',
  ].join('\n'))
})

test('a partial never consumes a position and same-id final updates retain their position', () => {
  const sync = new ConversationSync()
  assert.equal(record(sync, 'input', 'part', { final: false }), null)
  assert.deepEqual(snapshot(sync).messages, [])
  const initial = record(sync, 'input', 'complete', { final: true })
  record(sync, 'input', 'accidental partial overwrite', { final: false })
  const updated = record(sync, 'input', 'complete corrected', { createdAt: 5_000 })
  assert.equal(updated.historyPosition, initial.historyPosition)
  assert.equal(snapshot(sync).messages[0].content, 'complete corrected')
  const next = record(sync, 'next', 'next input', { createdAt: 1 })
  assert.equal(next.historyPosition, initial.historyPosition + 1)
})

test('excludes current user input but consumes its position; snapshot cannot include later text', () => {
  const sync = new ConversationSync()
  record(sync, 'previous', 'previous input', { turnId: 'previous-turn' })
  const current = record(sync, 'current', 'current objective', { turnId: 'current-turn' })
  const captured = snapshot(sync, { excludeTurnId: 'current-turn' })
  record(sync, 'previous', 'changed after submission')
  record(sync, 'future', 'future conversation')

  const first = conversationDelta(JSON.parse(JSON.stringify(captured)))
  assert.equal(first.text, 'User: previous input')
  assert.equal(first.cursor.position, current.historyPosition)
  const next = conversationDelta(snapshot(sync), JSON.parse(JSON.stringify(first.cursor)))
  assert.equal(next.text, 'User: future conversation')
})

test('older queued snapshots cannot rewind or replay an acknowledged newer snapshot', () => {
  const sync = new ConversationSync()
  record(sync, 'one', 'first')
  const older = snapshot(sync)
  record(sync, 'two', 'second')
  const newer = snapshot(sync)
  const acknowledged = conversationDelta(newer).cursor

  for (const candidate of [older, newer]) {
    const result = conversationDelta(candidate, acknowledged)
    assert.equal(result.text, '')
    assert.equal(result.stale, true)
    assert.deepEqual(result.cursor, acknowledged)
  }
  record(sync, 'three', 'third')
  assert.equal(conversationDelta(snapshot(sync), acknowledged).text, 'User: third')
})

test('retry uses the same frozen snapshot until delivery is acknowledged', () => {
  const sync = new ConversationSync()
  record(sync, 'one', 'first')
  const firstCursor = conversationDelta(snapshot(sync)).cursor
  record(sync, 'two', 'second')
  const pending = snapshot(sync)
  const attempt = conversationDelta(pending, firstCursor)
  record(sync, 'three', 'not part of this attempt')
  assert.deepEqual(conversationDelta(pending, firstCursor), attempt)
  assert.equal(conversationDelta(pending, attempt.cursor).text, '')
})

test('captures owner-isolated history and scopes cursor comparisons by frontend session', () => {
  const sync = new ConversationSync()
  record(sync, 'one', 'our conversation')
  record(sync, 'other-owner', 'private other owner', { ownerId: 'someone-else' })
  const captured = snapshot(sync)
  assert.equal(conversationDelta(captured, {
    sessionId: 'different-session', messageId: 'unrelated', position: 9_999_999,
  }).text, 'User: our conversation')
  assert.deepEqual(snapshot(sync, { sessionId: 'empty-session' }).messages, [])
  assert.deepEqual(snapshot(sync, { ownerId: 'someone-else' }).messages.map(message => message.id), ['other-owner'])
})

test('keeps the newest whole messages within the formatted-text budget', () => {
  const sync = new ConversationSync()
  record(sync, 'old', 'A'.repeat(40))
  record(sync, 'middle', 'B'.repeat(30), { role: 'assistant', source: 'realtime-direct' })
  record(sync, 'new', 'C'.repeat(20))
  const result = conversationDelta(snapshot(sync, { maxChars: 68 }))
  assert.deepEqual(result.messages.map(message => message.id), ['middle', 'new'])
  assert.equal(result.text.length, 68)
  assert.equal(result.truncated, true)
  assert.equal(result.messages[0].content, 'B'.repeat(30))
})

test('truncates a single overlong newest message without splitting Unicode surrogate pairs', () => {
  const sync = new ConversationSync()
  record(sync, 'old', 'old')
  record(sync, 'long', '😀'.repeat(2_000))
  const result = conversationDelta(snapshot(sync, { maxChars: 10_000 }))
  assert.deepEqual(result.messages.map(message => message.id), ['long'])
  assert.ok(result.text.length <= 2_000)
  assert.match(result.text, /…$/)
  assert.ok(!/[\uD800-\uDBFF]…$/.test(result.text))
  assert.equal(result.truncated, true)
})

test('zero and tiny budgets remain bounded and still advance the delivery cursor', () => {
  const sync = new ConversationSync()
  const message = record(sync, 'one', 'content')
  for (const maxChars of [0, 2, 6, 7]) {
    const result = conversationDelta(snapshot(sync, { maxChars }))
    assert.ok(result.text.length <= maxChars)
    assert.equal(result.cursor.position, message.historyPosition)
  }
})

test('a pruned cursor yields only the available bounded suffix, with no history refill', () => {
  const sync = new ConversationSync({ maxMessages: 2 })
  record(sync, 'one', 'first')
  const cursor = conversationDelta(snapshot(sync)).cursor
  record(sync, 'two', 'second')
  record(sync, 'three', 'third')
  const result = conversationDelta(snapshot(sync), cursor)
  assert.equal(result.gap, true)
  assert.equal(result.text, 'User: second\nUser: third')
  assert.equal(result.cursor.messageId, 'three')
})

test('the pure capture helper filters partials and orders stable positions, not ephemeral seq', () => {
  const captured = captureCoordinatorConversation([
    { id: 'late', role: 'user', source: 'text-user', content: 'late', historyPosition: 2, seq: 1 },
    { id: 'early', role: 'user', source: 'voice-user', content: 'early', historyPosition: 1, seq: 100 },
    { id: 'partial', role: 'user', source: 'voice-user', content: 'part', historyPosition: 3, final: false },
  ], { sessionId: 'voice' })
  assert.equal(conversationDelta(captured).text, 'User: early\nUser: late')
  assert.equal(captured.cursor.position, 2)
})
