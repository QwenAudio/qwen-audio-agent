import assert from 'node:assert/strict'
import test from 'node:test'
import { TaskManager } from '../src/task/task-manager.mjs'

test('journal snapshot supersedes a stale compact task projection', () => {
  const manager = new TaskManager({ runner: async () => ({ content: 'ok' }) })
  const created = manager.create({ ownerId: 'owner', sessionId: 'voice', objective: 'work' })
  const snapshot = {
    id: created.id,
    status: 'completed',
    scope: 'user',
    kind: 'work',
    ownerId: 'owner',
    sessionId: 'voice',
    turnId: null,
    objective: 'work',
    createdAt: Date.now() - 1000,
    startedAt: Date.now() - 900,
    completedAt: Date.now() - 100,
    elapsedMs: 800,
    result: 'ok',
    error: null,
    message: null,
    artifacts: [],
    activity: [],
    delegation: null,
    authorization: null,
    notificationStatus: 'none',
    notificationDeliveredAt: null,
    schedule: null,
    timeoutMs: null,
  }
  assert.equal(manager.restoreFromJournalSnapshots([snapshot]), 1)
  assert.equal(manager.get(created.id).status, 'completed')
})
