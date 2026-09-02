const RECURRENCE_VALUES = new Set([
  'once',
  'daily',
  'weekly',
  'weekdays',
])

const FORMATTERS = new Map()

export function normalizeRecurrence(value) {
  const recurrence = String(value || '').trim().toLowerCase()
  return RECURRENCE_VALUES.has(recurrence) ? recurrence : 'once'
}

export function normalizeTimeZone(value) {
  const timeZone = String(value || '').trim()
  if (!timeZone) return 'UTC'
  try {
    formatterFor(timeZone)
    return timeZone
  } catch {
    return 'UTC'
  }
}

function formatterFor(timeZone) {
  let formatter = FORMATTERS.get(timeZone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
    FORMATTERS.set(timeZone, formatter)
  }
  return formatter
}

function localParts(at, timeZone) {
  const parts = Object.create(null)
  for (const part of formatterFor(timeZone).formatToParts(new Date(at))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value)
  }
  return parts
}

function wallClockEpoch(parts) {
  return Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  )
}

function addCalendarDays(parts, days) {
  const date = new Date(Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day + days,
  ))
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
    millisecond: parts.millisecond,
  }
}

function weekday(parts) {
  return new Date(Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
  )).getUTCDay()
}

function offsetsAround(at, timeZone) {
  const offsets = new Set()
  const dayMs = 86_400_000
  const hourMs = 3_600_000
  for (let delta = -3 * dayMs; delta <= 3 * dayMs; delta += hourMs) {
    const probe = at + delta
    offsets.add(wallClockEpoch(localParts(probe, timeZone)) - probe)
  }
  return [...offsets]
}

/**
 * Convert a wall-clock date in an IANA timezone back to an instant.
 *
 * A local time can be ambiguous or nonexistent around a timezone transition.
 * Check all offsets observed around the target date so repeated hours choose
 * the earliest valid instant and skipped hours move forward past the gap.
 */
function zonedPartsToEpoch(parts, timeZone) {
  const target = wallClockEpoch(parts)
  const exact = []
  const after = []
  const before = []
  for (const offset of offsetsAround(target, timeZone)) {
    const candidate = target - offset
    const actual = localParts(candidate, timeZone)
    const actualWallClock = wallClockEpoch(actual)
    if (actualWallClock === target) exact.push(candidate)
    else if (actualWallClock > target) after.push({ candidate, actualWallClock })
    else before.push({ candidate, actualWallClock })
  }
  if (exact.length) return Math.min(...exact) + parts.millisecond
  if (after.length) {
    after.sort((left, right) => (
      left.actualWallClock - right.actualWallClock
      || left.candidate - right.candidate
    ))
    return after[0].candidate + parts.millisecond
  }
  before.sort((left, right) => (
    right.actualWallClock - left.actualWallClock
    || right.candidate - left.candidate
  ))
  return (before[0]?.candidate ?? target) + parts.millisecond
}

/**
 * Return the first occurrence strictly after `now` for a recurring schedule.
 * Missed occurrences are coalesced into one catch-up event, then the next
 * future calendar occurrence is scheduled.
 */
export function nextOccurrenceAt(
  at,
  recurrence,
  { now = Date.now(), timeZone = 'UTC' } = {},
) {
  const start = Number(at)
  const current = Number(now)
  const normalized = normalizeRecurrence(recurrence)
  if (
    normalized === 'once'
    || !Number.isFinite(start)
    || !Number.isFinite(current)
  ) return null

  const zone = normalizeTimeZone(timeZone)
  const initial = new Date(start)
  const startParts = {
    ...localParts(start, zone),
    millisecond: initial.getUTCMilliseconds(),
  }
  const step = normalized === 'weekly' ? 7 : 1
  let days = step

  // A guard protects the scheduler if a future recurrence mode is added but
  // its calendar rules are not wired here yet.
  for (let attempt = 0; attempt < 3700; attempt += 1) {
    const candidateParts = addCalendarDays(startParts, days)
    if (
      normalized !== 'weekdays'
      || ![0, 6].includes(weekday(candidateParts))
    ) {
      const candidate = zonedPartsToEpoch(candidateParts, zone)
      if (candidate > current) return candidate
    }
    days += step
  }
  return null
}
