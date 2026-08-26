import assert from 'node:assert/strict'
import test from 'node:test'
import { ConversationSync } from '../src/conversation/conversation-sync.mjs'
import { recordTaskResult } from '../src/conversation/task-result-projector.mjs'

test('records terminal work results identically', () => {
  const sync = new ConversationSync()
  for (const id of ['first', 'second']) {
    recordTaskResult({
      conversationSync: sync,
      ownerId: 'personal',
      sessionId: 'main',
      task: {
        id,
        status: 'completed',
        result: `${id} result`,
        turnId: `turn-${id}`,
      },
    })
  }

  assert.deepEqual(
    sync.list({ ownerId: 'personal', sessionId: 'main' })
      .map(message => ({
        id: message.id,
        content: message.content,
        source: message.source,
      })),
    [
      {
        id: 'agent:first',
        content: 'first result',
        source: 'agent-result',
      },
      {
        id: 'agent:second',
        content: 'second result',
        source: 'agent-result',
      },
    ],
  )
})

test('deduplicates a terminal result recorded again during reconnect claim', () => {
  const sync = new ConversationSync()
  const input = {
    conversationSync: sync,
    ownerId: 'personal',
    sessionId: 'main',
    task: {
      id: 'same',
      status: 'failed',
      error: '任务失败',
      turnId: 'turn-same',
    },
  }
  recordTaskResult(input)
  recordTaskResult(input)

  assert.equal(sync.list({ ownerId: 'personal', sessionId: 'main' }).length, 1)
  assert.equal(
    sync.list({ ownerId: 'personal', sessionId: 'main' })[0].turnId,
    null,
  )
})
