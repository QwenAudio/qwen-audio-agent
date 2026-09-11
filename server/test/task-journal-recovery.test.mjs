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
    createdAt: created.createdAt,
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

test('an older journal lifetime cannot replace a reused task ID in the compact snapshot', () => {
  const manager = new TaskManager()
  const created = manager.createScheduled({
    ownerId: 'owner', sessionId: 'new-session', objective: 'new work',
    schedule: { at: Date.now() + 60_000 },
  })
  assert.equal(manager.restoreFromJournalSnapshots([{
    ...created, sessionId: 'old-session', createdAt: created.createdAt - 60_000,
    objective: 'old work', status: 'completed', journalSeq: 10_000,
  }]), 0)
  assert.equal(manager.get(created.id).objective, 'new work')
  assert.equal(manager.get(created.id).status, 'scheduled')
})

test('journal reconciliation preserves the recurring series anchor', () => {
  const manager = new TaskManager({
    store: { load: () => [], save: () => {} },
  })
  const firstAt = Date.parse('2026-03-07T07:30:00.000Z')
  const created = manager.createScheduled({
    objective: '每日提醒',
    ownerId: 'owner',
    sessionId: 'voice',
    turnId: 'turn-1',
    schedule: {
      at: Date.parse('2026-03-08T07:30:00.000Z'),
      recurrence: 'daily',
      timeZone: 'America/New_York',
    },
    recurrenceStartAt: firstAt,
  })

  assert.equal(manager.restoreFromJournalSnapshots([{ ...created }]), 1)
  assert.equal(manager.tasks.get(created.id).recurrenceStartAt, firstAt)
})
