import assert from 'node:assert/strict'
import test from 'node:test'
import { TurnCorrelation } from '../src/voice/turn-correlation.mjs'

test('correlates a late transcript with its original input item', () => {
  const turns = new TurnCorrelation()
  const first = { turnId: 'voice-100-1', turnGeneration: 1 }
  const second = { turnId: 'voice-200-2', turnGeneration: 2 }

  turns.remember('item-first', first)
  turns.remember('item-second', second)

  assert.deepEqual(
    turns.complete('item-first', second),
    { context: first, invalid: false },
  )
  assert.deepEqual(
    turns.resolve('item-first', second),
    first,
  )
})

test('keeps an invalid Smart Turn invalid for duplicate late events', () => {
  const turns = new TurnCorrelation()
  const invalid = { turnId: 'voice-100-1', turnGeneration: 1 }
  const current = { turnId: 'voice-200-2', turnGeneration: 2 }

  turns.remember('item-invalid', invalid)
  turns.invalidate('item-invalid')

  assert.deepEqual(
    turns.complete('item-invalid', current),
    { context: invalid, invalid: true },
  )
  assert.deepEqual(
    turns.complete('item-invalid', current),
    { context: invalid, invalid: true, duplicate: true },
  )
})

test('keeps an active Realtime item in one turn until transcription completes', () => {
  const turns = new TurnCorrelation()
  const first = { turnId: 'voice-100-1', turnGeneration: 1 }
  const reopened = { turnId: 'voice-200-2', turnGeneration: 2 }

  assert.deepEqual(turns.remember('item-reopened', first), first)
  assert.deepEqual(turns.complete('item-reopened', reopened), {
    context: first,
    invalid: false,
  })
  assert.deepEqual(turns.remember('item-reopened', reopened), first)
  assert.deepEqual(turns.resolve('item-reopened', reopened), first)

  assert.deepEqual(
    turns.remember('item-reopened', reopened, { replace: true }),
    reopened,
  )
  assert.equal(turns.isComplete('item-reopened'), false)
  assert.deepEqual(turns.resolve('item-reopened', first), reopened)
})

test('invalidates every older voice item when manual input takes priority', () => {
  const turns = new TurnCorrelation()
  turns.remember('item-oldest', {
    turnId: 'voice-100-1',
    turnGeneration: 1,
  })
  turns.remember('item-active', {
    turnId: 'voice-200-2',
    turnGeneration: 2,
  })
  turns.remember('item-current', {
    turnId: 'text-current',
    turnGeneration: 3,
  })

  turns.invalidateBeforeGeneration(3)

  assert.equal(turns.isInvalid('item-oldest'), true)
  assert.equal(turns.isInvalid('item-active'), true)
  assert.equal(turns.isInvalid('item-current'), false)
})
