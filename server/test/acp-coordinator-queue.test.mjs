import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import test from 'node:test'
import { CoordinatorQueue } from '../src/backend/adapters/acp/coordinator-queue.mjs'

const tick = () => new Promise(resolve => setImmediate(resolve))

test('coordinator turns for one owner run in FIFO order with one stable key', async () => {
  const queue = new CoordinatorQueue()
  const first = await queue.acquire('owner')
  const acquired = []
  const second = queue.acquire('owner').then(lease => {
    acquired.push('second')
    return lease
  })
  const third = queue.acquire('owner').then(lease => {
    acquired.push('third')
    return lease
  })
  await tick()
  assert.deepEqual(acquired, [])

  first.release()
  const secondLease = await second
  assert.deepEqual(acquired, ['second'])
  assert.equal(secondLease.key, first.key)
  secondLease.release()
  const thirdLease = await third
  assert.deepEqual(acquired, ['second', 'third'])
  assert.equal(thirdLease.key, first.key)
  thirdLease.release()
  assert.equal(queue.owners.size, 0)
})

test('different owners have independent coordinator queues', async () => {
  const queue = new CoordinatorQueue()
  const first = await queue.acquire('first-owner')
  const other = await queue.acquire('other-owner')
  assert.equal(first.key, 'first-owner')
  assert.equal(other.key, 'other-owner')
  assert.equal(queue.owners.size, 2)
  first.release()
  assert.equal(queue.owners.size, 1)
  other.release()
  assert.equal(queue.owners.size, 0)
})

test('cancelling a queued turn removes it without interrupting the active turn or changing FIFO order', async () => {
  const queue = new CoordinatorQueue()
  const active = await queue.acquire('owner')
  const cancelled = new AbortController()
  const reason = new Error('cancelled queued turn')
  const skipped = queue.acquire('owner', { signal: cancelled.signal })
  const rejection = assert.rejects(skipped, error => error === reason)
  let nextStarted = false
  const next = queue.acquire('owner').then(lease => {
    nextStarted = true
    return lease
  })
  assert.equal(getEventListeners(cancelled.signal, 'abort').length, 1)
  cancelled.abort(reason)
  await rejection
  assert.equal(nextStarted, false)
  assert.equal(getEventListeners(cancelled.signal, 'abort').length, 0)

  active.release()
  const nextLease = await next
  assert.equal(nextStarted, true)
  nextLease.release()
  assert.equal(queue.owners.size, 0)
})

test('a signal already cancelled never enters the queue', async () => {
  const queue = new CoordinatorQueue()
  const controller = new AbortController()
  const reason = new Error('already cancelled')
  controller.abort(reason)
  await assert.rejects(queue.acquire('owner', { signal: controller.signal }), error => error === reason)
  assert.equal(queue.owners.size, 0)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
})

test('the caller owns an acquired lease until release even when its signal is cancelled', async () => {
  const queue = new CoordinatorQueue()
  const controller = new AbortController()
  const active = await queue.acquire('owner', { signal: controller.signal })
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  let nextStarted = false
  const next = queue.acquire('owner').then(lease => {
    nextStarted = true
    return lease
  })
  controller.abort()
  await tick()
  assert.equal(nextStarted, false)
  active.release()
  const nextLease = await next
  nextLease.release()
})

test('releasing an old lease twice cannot release its successor or a later queue', async () => {
  const queue = new CoordinatorQueue()
  const first = await queue.acquire('owner')
  const second = queue.acquire('owner')
  first.release()
  const active = await second
  let nextStarted = false
  const next = queue.acquire('owner').then(lease => {
    nextStarted = true
    return lease
  })
  first.release()
  await tick()
  assert.equal(nextStarted, false)
  active.release()
  const last = await next
  last.release()
  const fresh = await queue.acquire('owner')
  first.release()
  last.release()
  assert.equal(queue.owners.size, 1)
  fresh.release()
  assert.equal(queue.owners.size, 0)
})

test('closing rejects all pending turns, detaches listeners and never revives the queue', async () => {
  const queue = new CoordinatorQueue()
  const first = await queue.acquire('first-owner')
  const other = await queue.acquire('other-owner')
  const firstWaiter = new AbortController()
  const otherWaiter = new AbortController()
  const pending = [
    assert.rejects(queue.acquire('first-owner', { signal: firstWaiter.signal }), /queue is closed/),
    assert.rejects(queue.acquire('other-owner', { signal: otherWaiter.signal }), /queue is closed/),
  ]
  queue.close()
  queue.close()
  await Promise.all(pending)
  assert.equal(queue.owners.size, 0)
  assert.equal(getEventListeners(firstWaiter.signal, 'abort').length, 0)
  assert.equal(getEventListeners(otherWaiter.signal, 'abort').length, 0)
  first.release()
  first.release()
  other.release()
  firstWaiter.abort()
  otherWaiter.abort()
  await assert.rejects(queue.acquire('first-owner'), /queue is closed/)
  assert.equal(queue.owners.size, 0)
})
