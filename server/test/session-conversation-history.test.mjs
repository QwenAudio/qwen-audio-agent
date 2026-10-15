import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ConversationSync } from '../src/conversation/conversation-sync.mjs'
import { SessionConversationHistory } from '../src/app/session-conversation-history.mjs'
import { SessionJournalRegistry } from '../src/session/session-journal-registry.mjs'
import { conversationDelta } from '../src/core/work-conversation-context.mjs'

test('restores the same recent messages for the UI and Realtime after restart', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'qwaudio-conversation-history-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const firstRegistry = new SessionJournalRegistry({ directory })
  const firstSync = new ConversationSync()
  const firstHistory = new SessionConversationHistory({
    conversationSync: firstSync,
    sessionJournal: firstRegistry,
  })
  firstHistory.start()

  for (let index = 1; index <= 44; index += 1) {
    firstSync.record({
      ownerId: 'owner',
      sessionId: 'desktop',
      id: `message-${index}`,
      role: index % 2 ? 'user' : 'assistant',
      content: `message ${index}`,
      source: index % 2 ? 'voice-user' : 'realtime-direct',
    })
  }
  await firstRegistry.flush()
  firstHistory.close()

  const restoredSync = new ConversationSync()
  const restoredHistory = new SessionConversationHistory({
    conversationSync: restoredSync,
    sessionJournal: new SessionJournalRegistry({ directory }),
  })
  assert.equal(restoredHistory.start(), 40)

  const realtimeMessages = restoredSync.frontendContext({
    ownerId: 'owner',
    sessionId: 'desktop',
  })
  const visibleMessages = await restoredHistory.messages({
    ownerId: 'owner',
    sessionId: 'desktop',
  })
  const expected = Array.from({ length: 40 }, (_, index) => `message ${index + 5}`)
  assert.deepEqual(realtimeMessages.map(message => message.content), expected)
  assert.deepEqual(visibleMessages.map(message => message.content), expected)
  assert.deepEqual(
    visibleMessages.map(message => message.id),
    realtimeMessages.map(message => message.id),
  )
  restoredHistory.close()
})

test('keeps internal task results out of the durable frontend projection', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'qwaudio-conversation-projection-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const registry = new SessionJournalRegistry({ directory })
  const sync = new ConversationSync()
  const history = new SessionConversationHistory({
    conversationSync: sync,
    sessionJournal: registry,
  })
  history.start()
  sync.record({
    ownerId: 'owner', sessionId: 'desktop', id: 'raw-result',
    role: 'assistant', content: 'internal result', source: 'agent-result', taskId: 'task-1',
  })
  sync.record({
    ownerId: 'owner', sessionId: 'desktop', id: 'presentation',
    role: 'assistant', content: 'visible result', source: 'agent-presentation', taskId: 'task-1',
  })
  await registry.flush()

  assert.deepEqual(
    (await history.messages({ ownerId: 'owner', sessionId: 'desktop' }))
      .map(message => message.content),
    ['visible result'],
  )
  history.close()
})

test('restores durable conversation positions and does not replay acknowledged history', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'qwaudio-conversation-cursor-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const registry = new SessionJournalRegistry({ directory })
  const sync = new ConversationSync()
  const history = new SessionConversationHistory({ conversationSync: sync, sessionJournal: registry })
  const context = { ownerId: 'owner', sessionId: 'desktop' }
  history.start()
  // An unrelated session makes process-local seq differ after restoration.
  sync.record({ ...context, sessionId: 'other', id: 'other', role: 'user', source: 'voice-user', content: 'other', createdAt: 100 })
  const first = sync.record({ ...context, id: 'first', role: 'user', source: 'voice-user', content: 'first', createdAt: 1_000 })
  const cursor = JSON.parse(JSON.stringify(conversationDelta(sync.coordinatorSnapshot(context)).cursor))
  sync.record({ ...context, id: 'second', role: 'assistant', source: 'agent-presentation', content: 'second', taskId: 'task', createdAt: 1_000 })
  // This highest position is omitted by the frontend projection on restore.
  const hidden = sync.record({ ...context, id: 'hidden', role: 'assistant', source: 'agent-result', content: 'hidden raw result', taskId: 'task', createdAt: 9_000 })
  await registry.flush()
  history.close()

  const restoredRegistry = new SessionJournalRegistry({ directory })
  const restoredSync = new ConversationSync()
  for (let index = 0; index < 3; index += 1) {
    restoredSync.record({ ...context, sessionId: 'temporary', id: `temporary-${index}`, role: 'user', source: 'voice-user', content: 'unrelated', createdAt: 10 })
  }
  const restoredHistory = new SessionConversationHistory({ conversationSync: restoredSync, sessionJournal: restoredRegistry })
  restoredHistory.start()
  const messages = restoredSync.list(context)
  assert.notEqual(messages[0].seq, first.seq)
  assert.equal(messages[0].historyPosition, first.historyPosition)
  assert.deepEqual(messages.map(message => message.content), ['first', 'second'])
  assert.equal(conversationDelta(restoredSync.coordinatorSnapshot(context), cursor).text, 'Assistant: second')
  // A wall-clock rollback cannot reuse a persisted (even hidden) position.
  const third = restoredSync.record({ ...context, id: 'third', role: 'user', source: 'text-user', content: 'third', createdAt: 1 })
  assert.equal(third.historyPosition, hidden.historyPosition + 1)
  await restoredRegistry.flush()
  restoredHistory.close()
})
