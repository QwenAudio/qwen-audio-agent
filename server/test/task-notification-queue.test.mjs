import assert from 'node:assert/strict'
import test from 'node:test'
import { TaskNotificationQueue } from '../src/task/task-notification-queue.mjs'

function task({
  id,
  ownerId = 'owner',
  sessionId = 'voice',
  createdAt = 1,
  notificationStatus = 'pending',
  notificationClaimantId = null,
  notificationClaimedAt = null,
} = {}) {
  return {
    id,
    ownerId,
    sessionId,
    createdAt,
    notificationStatus,
    notificationClaimantId,
    notificationClaimedAt,
  }
}

function harness(records, { now = 100, claimTtlMs = 50 } = {}) {
  const tasks = new Map(records.map(item => [item.id, item]))
  const changes = []
  const delivered = []
  const queue = new TaskNotificationQueue({
    tasks,
    snapshot: item => ({ ...item }),
    claimTtlMs: () => claimTtlMs,
    onChanged: () => changes.push('changed'),
    onDelivered: item => delivered.push(item.id),
    now: () => now,
  })
  return { queue, tasks, changes, delivered }
}

test('claims only matching pending notifications in creation order', () => {
  const { queue, tasks, changes } = harness([
    task({ id: 'later', createdAt: 2 }),
    task({ id: 'earlier', createdAt: 1 }),
    task({ id: 'other-session', sessionId: 'other' }),
    task({ id: 'other-owner', ownerId: 'other' }),
  ])

  const claimed = queue.claim({
    ownerId: 'owner',
    sessionId: 'voice',
    claimantId: 'desktop',
  })

  assert.deepEqual(claimed.map(item => item.id), ['earlier', 'later'])
  assert.equal(tasks.get('earlier').notificationStatus, 'delivering')
  assert.equal(tasks.get('other-session').notificationStatus, 'pending')
  assert.equal(changes.length, 1)
})

test('renews, releases, and completes only the matching delivery lease', () => {
  const { queue, tasks, changes, delivered } = harness([
    task({
      id: 'work-one',
      notificationStatus: 'delivering',
      notificationClaimantId: 'desktop',
      notificationClaimedAt: 10,
    }),
  ], { now: 100 })

  assert.equal(queue.renew(['work-one'], { claimantId: 'other' }), 0)
  assert.equal(queue.renew(['work-one'], { claimantId: 'desktop' }), 1)
  assert.equal(tasks.get('work-one').notificationClaimedAt, 100)
  assert.equal(queue.release(['work-one'], { claimantId: 'desktop' }), 1)
  assert.equal(tasks.get('work-one').notificationStatus, 'pending')

  queue.claim({ ownerId: 'owner', claimantId: 'desktop' })
  assert.equal(queue.markDelivered(['work-one'], { claimantId: 'desktop' }), 1)
  assert.equal(tasks.get('work-one').notificationStatus, 'delivered')
  assert.equal(tasks.get('work-one').notificationDeliveredAt, 100)
  assert.deepEqual(delivered, ['work-one'])
  assert.equal(changes.length, 3)
})

test('reclaims an expired lease but preserves a live lease', () => {
  const { queue, tasks, changes } = harness([
    task({
      id: 'expired',
      notificationStatus: 'delivering',
      notificationClaimantId: 'stale',
      notificationClaimedAt: 10,
    }),
    task({
      id: 'live',
      notificationStatus: 'delivering',
      notificationClaimantId: 'active',
      notificationClaimedAt: 80,
    }),
  ], { now: 100, claimTtlMs: 50 })

  assert.equal(queue.reclaimExpired(), 1)
  assert.equal(tasks.get('expired').notificationStatus, 'pending')
  assert.equal(tasks.get('live').notificationStatus, 'delivering')
  assert.equal(changes.length, 1)
})

test('checkpoints delivery before publishing its acknowledgement event', () => {
  const records = [task({
    id: 'work-one',
    notificationStatus: 'delivering',
    notificationClaimantId: 'desktop',
    notificationClaimedAt: 90,
  })]
  const tasks = new Map(records.map(item => [item.id, item]))
  const order = []
  const queue = new TaskNotificationQueue({
    tasks,
    snapshot: item => ({ ...item }),
    claimTtlMs: () => 50,
    now: () => 100,
    onChanged: () => order.push('checkpoint'),
    onDelivered: () => order.push('event'),
  })

  assert.equal(queue.markDelivered(
    ['work-one'],
    { claimantId: 'desktop' },
  ), 1)
  assert.deepEqual(order, ['checkpoint', 'event'])
})
