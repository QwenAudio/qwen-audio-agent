import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ConversationSync } from '../src/conversation/conversation-sync.mjs'
import { SessionConversationHistory } from '../src/app/session-conversation-history.mjs'
import { SessionJournalRegistry } from '../src/session/session-journal-registry.mjs'

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
