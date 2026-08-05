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
    { context: invalid, invalid: true },
  )
})

test('keeps the first turn assigned to a repeated Realtime item id', () => {
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
})
