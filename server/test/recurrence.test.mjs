import assert from 'node:assert/strict'
import test from 'node:test'
import {
  nextOccurrenceAt,
  normalizeRecurrence,
  normalizeTimeZone,
} from '../src/task/recurrence.mjs'

test('normalizes supported recurrence values and rejects unknown values', () => {
  assert.equal(normalizeRecurrence('DAILY'), 'daily')
  assert.equal(normalizeRecurrence('weekdays'), 'weekdays')
  assert.equal(normalizeRecurrence('monthly'), 'once')
  assert.equal(normalizeRecurrence(), 'once')
})

test('calculates the next daily and weekly occurrence in UTC', () => {
  const at = Date.parse('2026-01-01T09:30:00.123Z')
  const now = Date.parse('2026-01-01T10:00:00.000Z')

  assert.equal(
    nextOccurrenceAt(at, 'daily', { now, timeZone: 'UTC' }),
    Date.parse('2026-01-02T09:30:00.123Z'),
  )
  assert.equal(
    nextOccurrenceAt(at, 'weekly', { now, timeZone: 'UTC' }),
    Date.parse('2026-01-08T09:30:00.123Z'),
  )
})

test('returns the initial occurrence when it is still in the future', () => {
  const at = Date.parse('2026-01-08T09:30:00.000Z')
  const now = Date.parse('2026-01-01T10:00:00.000Z')

  assert.equal(
    nextOccurrenceAt(at, 'daily', { now, timeZone: 'UTC' }),
    at,
  )
  assert.equal(
    nextOccurrenceAt(at, 'weekly', { now, timeZone: 'UTC' }),
    at,
  )
})

test('locates a future daily occurrence after a long outage', () => {
  const at = Date.parse('2010-01-01T09:30:00.000Z')
  const now = Date.parse('2026-01-01T10:00:00.000Z')

  assert.equal(
    nextOccurrenceAt(at, 'daily', { now, timeZone: 'UTC' }),
    Date.parse('2026-01-02T09:30:00.000Z'),
  )
})

test('skips weekends for weekday recurrence and coalesces missed days', () => {
  const friday = Date.parse('2026-01-09T09:30:00.000Z')
  const mondayAfternoon = Date.parse('2026-01-12T15:00:00.000Z')
  const next = nextOccurrenceAt(friday, 'weekdays', {
    now: mondayAfternoon,
    timeZone: 'UTC',
  })

  assert.equal(next, Date.parse('2026-01-13T09:30:00.000Z'))
})

test('preserves local wall-clock time across a timezone offset', () => {
  const at = Date.parse('2026-01-10T15:30:00.000Z')
  const next = nextOccurrenceAt(at, 'daily', {
    now: at + 1_000,
    timeZone: 'America/New_York',
  })

  assert.equal(next, Date.parse('2026-01-11T15:30:00.000Z'))
})

test('moves a nonexistent DST time forward and preserves times after the transition', () => {
  const beforeSpringForward = Date.parse('2026-03-07T07:30:00.000Z')
  const afterGap = nextOccurrenceAt(beforeSpringForward, 'daily', {
    now: beforeSpringForward + 1_000,
    timeZone: 'America/New_York',
  })
  assert.equal(afterGap, Date.parse('2026-03-08T07:30:00.000Z'))

  const afterSpringForward = Date.parse('2026-03-07T08:30:00.000Z')
  const nextAfterTransition = nextOccurrenceAt(afterSpringForward, 'daily', {
    now: afterSpringForward + 1_000,
    timeZone: 'America/New_York',
  })
  assert.equal(nextAfterTransition, Date.parse('2026-03-08T07:30:00.000Z'))
})

test('falls back to UTC for an invalid timezone', () => {
  assert.equal(normalizeTimeZone('not/a-timezone'), 'UTC')
  const at = Date.parse('2026-01-01T09:30:00.000Z')
  assert.equal(
    nextOccurrenceAt(at, 'daily', {
      now: at + 1_000,
      timeZone: 'not/a-timezone',
    }),
    Date.parse('2026-01-02T09:30:00.000Z'),
  )
})
