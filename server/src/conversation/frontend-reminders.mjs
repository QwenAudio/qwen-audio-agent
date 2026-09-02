import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'
import {
  replaceFileSync,
  withFileTransaction,
} from '../../../shared/file-transaction-lock.mjs'

export const REMINDER_STORE_VERSION = 1
export const MAX_REMINDERS_PER_OWNER = 100
export const MAX_REMINDER_TEXT_CHARS = 500
export const MAX_REMINDER_OWNER_ID_CHARS = 200
export const MAX_REMINDER_TIMEZONE_CHARS = 100

export const ReminderKind = Object.freeze({
  REMINDER: 'reminder',
  TASK: 'task',
})

export const ReminderRecurrence = Object.freeze({
  ONCE: 'once',
  DAILY: 'daily',
  WEEKLY: 'weekly',
  WEEKDAYS: 'weekdays',
})

export const ReminderStatus = Object.freeze({
  ACTIVE: 'active',
  FIRING: 'firing',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
  FAILED: 'failed',
})

const KINDS = new Set(Object.values(ReminderKind))
const RECURRENCES = new Set(Object.values(ReminderRecurrence))
const STATUSES = new Set(Object.values(ReminderStatus))
const TERMINAL_STATUSES = new Set([
  ReminderStatus.COMPLETED,
  ReminderStatus.CANCELLED,
  ReminderStatus.FAILED,
])

function clean(value, maxChars) {
  return [...String(value ?? '').replace(/\s+/g, ' ').trim()]
    .slice(0, maxChars)
    .join('')
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function timestamp(value, code = 'invalid_execute_at') {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new ReminderStoreError(code, 'reminder time must be a non-negative integer')
  }
  return number
}

function ownerId(value) {
  const normalized = clean(value, MAX_REMINDER_OWNER_ID_CHARS)
  if (!normalized) {
    throw new ReminderStoreError('invalid_owner', 'reminder owner is required')
  }
  if (String(value ?? '').trim().length > MAX_REMINDER_OWNER_ID_CHARS) {
    throw new ReminderStoreError('invalid_owner', 'reminder owner is too long')
  }
  return normalized
}

function reminderId(value) {
  const source = String(value ?? '').trim()
  const normalized = clean(source, 120)
  if (!normalized || [...source].length > 120) {
    throw new ReminderStoreError('invalid_id', 'reminder id is invalid')
  }
  return normalized
}

function reminderText(value) {
  const source = String(value ?? '').trim()
  const normalized = clean(source, MAX_REMINDER_TEXT_CHARS)
  if (!normalized) {
    throw new ReminderStoreError('invalid_text', 'reminder text is required')
  }
  if ([...source].length > MAX_REMINDER_TEXT_CHARS) {
    throw new ReminderStoreError('invalid_text', 'reminder text is too long')
  }
  return normalized
}

function reminderKind(value) {
  const normalized = String(value || ReminderKind.REMINDER).trim().toLowerCase()
  if (!KINDS.has(normalized)) {
    throw new ReminderStoreError('invalid_kind', `unsupported reminder kind: ${normalized}`)
  }
  return normalized
}

function recurrence(value) {
  const normalized = String(value || ReminderRecurrence.ONCE).trim().toLowerCase()
  if (!RECURRENCES.has(normalized)) {
    throw new ReminderStoreError(
      'invalid_recurrence',
      `unsupported reminder recurrence: ${normalized}`,
    )
  }
  return normalized
}

function timezone(value) {
  const source = String(value || 'UTC').trim()
  if (!source || source.length > MAX_REMINDER_TIMEZONE_CHARS) {
    throw new ReminderStoreError('invalid_timezone', 'reminder timezone is invalid')
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: source }).format(0)
  } catch {
    throw new ReminderStoreError('invalid_timezone', `unknown reminder timezone: ${source}`)
  }
  return source
}

function cloneReminder(reminder) {
  return reminder ? { ...reminder } : null
}

export class ReminderStoreError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ReminderStoreError'
    this.code = code
  }
}

/**
 * Durable, owner-scoped storage for frontend reminders.
 *
 * This store deliberately does not know about the Realtime provider, the
 * TaskManager, or any backend Agent. A later runtime can use claimDue() and
 * complete()/fail() to connect the store to announcements or WorkSubmissionPort
 * without putting scheduling policy into persistence.
 */
export class FrontendReminderStore {
  constructor({
    filePath = null,
    maxOwners = 1000,
    maxRemindersPerOwner = MAX_REMINDERS_PER_OWNER,
    ownerTtlMs = 0,
    now = () => Date.now(),
    idFactory = () => `rem_${randomUUID()}`,
    onWarning = warning => console.warn(warning.message),
  } = {}) {
    this.filePath = filePath
    this.maxOwners = Math.max(1, Number(maxOwners) || 1000)
    this.maxRemindersPerOwner = Math.max(
      1,
      Number(maxRemindersPerOwner) || MAX_REMINDERS_PER_OWNER,
    )
    this.ownerTtlMs = Math.max(0, Number(ownerTtlMs) || 0)
    this.now = now
    this.idFactory = idFactory
    this.onWarning = onWarning
    this.reminders = new Map()
    this.ownerAccess = new Map()
    this.warning = null
    this.persistenceDisabled = false
    this.loadedMtimeMs = 0
    this.loadedContentHash = ''
    if (filePath) this.load()
  }

  fileMtimeMs() {
    try {
      return statSync(this.filePath).mtimeMs
    } catch (error) {
      if (error.code === 'ENOENT') return 0
      throw error
    }
  }

  fileContentHash() {
    try {
      return createHash('sha1').update(readFileSync(this.filePath)).digest('hex')
    } catch {
      return ''
    }
  }

  refreshIfChanged() {
    if (!this.filePath || this.persistenceDisabled) return
    const mtimeMs = this.fileMtimeMs()
    if (mtimeMs === this.loadedMtimeMs
      && this.fileContentHash() === this.loadedContentHash) return
    this.reminders = new Map()
    this.ownerAccess = new Map()
    this.load()
  }

  writeTransaction(action) {
    return withFileTransaction(this.filePath, () => {
      // Reload after acquiring the lock. This prevents a second Gateway from
      // having its write silently overwritten by this instance's stale cache.
      if (this.filePath && !this.persistenceDisabled) {
        this.reminders = new Map()
        this.ownerAccess = new Map()
        this.load()
      }
      return action()
    })
  }

  setWarning(message, quarantinePath = null) {
    this.warning = { message, quarantinePath, at: this.now() }
    try {
      this.onWarning?.(this.warning)
    } catch {
      // Diagnostics must never prevent the voice service from starting.
    }
  }

  disablePersistence(message) {
    this.persistenceDisabled = true
    this.setWarning(`${message}；已禁用提醒持久化，服务将继续运行。`)
  }

  quarantine(reason) {
    const quarantinePath = `${this.filePath}.corrupt-${this.now()}`
    try {
      renameSync(this.filePath, quarantinePath)
      this.setWarning(
        `${reason}；原文件已隔离为 ${quarantinePath}，服务将使用空提醒继续运行。`,
        quarantinePath,
      )
    } catch (error) {
      this.persistenceDisabled = true
      this.setWarning(
        `${reason}；隔离失败（${error.message}），已禁用提醒持久化以保护原文件。`,
      )
    }
  }

  normalizePersisted(raw, storedOwnerId) {
    if (!plainObject(raw)) return null
    let id
    let text
    let kind
    let repeat
    let zone
    let nextFireAt
    try {
      id = reminderId(raw.id)
      text = reminderText(raw.text)
      kind = reminderKind(raw.kind)
      repeat = recurrence(raw.recurrence)
      zone = timezone(raw.timezone)
      nextFireAt = timestamp(raw.nextFireAt)
    } catch {
      return null
    }
    const status = STATUSES.has(raw.status)
      ? raw.status
      : ReminderStatus.ACTIVE
    const createdAt = Number.isSafeInteger(raw.createdAt) && raw.createdAt >= 0
      ? raw.createdAt
      : this.now()
    const updatedAt = Number.isSafeInteger(raw.updatedAt) && raw.updatedAt >= 0
      ? raw.updatedAt
      : createdAt
    const lastFiredAt = Number.isSafeInteger(raw.lastFiredAt) && raw.lastFiredAt >= 0
      ? raw.lastFiredAt
      : null
    const fireCount = Number.isSafeInteger(raw.fireCount) && raw.fireCount >= 0
      ? raw.fireCount
      : 0
    const lastError = raw.lastError
      ? clean(raw.lastError, 500)
      : null
    let safeOwnerId
    try {
      safeOwnerId = ownerId(storedOwnerId)
    } catch {
      return null
    }
    return {
      id,
      ownerId: safeOwnerId,
      text,
      kind,
      timezone: zone,
      recurrence: repeat,
      nextFireAt,
      // A process can die after claiming but before delivering. Re-opening a
      // firing reminder as active makes it retryable instead of losing it.
      status: status === ReminderStatus.FIRING
        ? ReminderStatus.ACTIVE
        : status,
      createdAt,
      updatedAt,
      lastFiredAt,
      fireCount,
      lastError,
    }
  }

  load() {
    if (!this.filePath || this.persistenceDisabled) return
    let raw
    try {
      raw = readFileSync(this.filePath, 'utf8')
    } catch (error) {
      if (error.code === 'ENOENT') {
        this.loadedMtimeMs = 0
        this.loadedContentHash = ''
        return
      }
      this.disablePersistence(`无法读取提醒文件：${error.message}`)
      return
    }
    this.loadedMtimeMs = this.fileMtimeMs()
    this.loadedContentHash = createHash('sha1').update(raw).digest('hex')
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      this.quarantine(`提醒文件不是有效的 JSON：${error.message}`)
      return
    }
    if (
      !plainObject(parsed)
      || parsed.version !== REMINDER_STORE_VERSION
      || !plainObject(parsed.owners)
      || !plainObject(parsed.ownerAccess)
    ) {
      this.quarantine('提醒文件格式或版本无效')
      return
    }
    Object.entries(parsed.owners).slice(0, this.maxOwners).forEach(([storedOwnerId, entries]) => {
      if (!plainObject(entries)) return
      const ownerReminders = new Map()
      Object.entries(entries)
        .slice(0, this.maxRemindersPerOwner)
        .forEach(([storedId, rawReminder]) => {
          const reminder = this.normalizePersisted(
            { ...rawReminder, id: rawReminder?.id || storedId },
            storedOwnerId,
          )
          if (!reminder || ownerReminders.has(reminder.id)) return
          ownerReminders.set(reminder.id, reminder)
        })
      if (!ownerReminders.size) return
      let safeOwnerId
      try {
        safeOwnerId = ownerId(storedOwnerId)
      } catch {
        return
      }
      this.reminders.set(safeOwnerId, ownerReminders)
      const access = Number(parsed.ownerAccess[storedOwnerId])
      this.ownerAccess.set(
        safeOwnerId,
        Number.isSafeInteger(access) && access >= 0 ? access : this.now(),
      )
    })
    this.pruneOwners({ persist: false })
  }

  persist() {
    if (!this.filePath) return true
    if (this.persistenceDisabled) return false
    try {
      const owners = Object.create(null)
      this.reminders.forEach((entries, safeOwnerId) => {
        owners[safeOwnerId] = Object.create(null)
        entries.forEach((reminder, id) => {
          owners[safeOwnerId][id] = reminder
        })
      })
      mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 })
      const temporary = `${this.filePath}.${process.pid}.tmp`
      const body = `${JSON.stringify({
        version: REMINDER_STORE_VERSION,
        owners,
        ownerAccess: Object.fromEntries(this.ownerAccess),
      }, null, 2)}\n`
      writeFileSync(temporary, body, { encoding: 'utf8', mode: 0o600 })
      replaceFileSync(temporary, this.filePath)
      chmodSync(this.filePath, 0o600)
      this.loadedMtimeMs = this.fileMtimeMs()
      this.loadedContentHash = createHash('sha1').update(body).digest('hex')
      return true
    } catch (error) {
      this.disablePersistence(`无法保存提醒文件：${error.message}`)
      return false
    }
  }

  pruneOwners({ persist = true } = {}) {
    const now = this.now()
    let changed = false
    this.ownerAccess.forEach((lastAccessedAt, safeOwnerId) => {
      if (!(this.ownerTtlMs > 0) || now - lastAccessedAt < this.ownerTtlMs) return
      this.ownerAccess.delete(safeOwnerId)
      changed = this.reminders.delete(safeOwnerId) || changed
    })
    while (this.reminders.size > this.maxOwners) {
      const oldest = [...this.reminders.keys()]
        .sort((left, right) => (
          Number(this.ownerAccess.get(left) || 0)
          - Number(this.ownerAccess.get(right) || 0)
        ))[0]
      if (!oldest) break
      this.reminders.delete(oldest)
      this.ownerAccess.delete(oldest)
      changed = true
    }
    if (changed && persist) this.persist()
    return changed
  }

  touch(safeOwnerId) {
    if (this.reminders.has(safeOwnerId)) this.ownerAccess.set(safeOwnerId, this.now())
  }

  health() {
    let reminderCount = 0
    this.reminders.forEach(entries => { reminderCount += entries.size })
    return {
      ok: !this.warning,
      persistenceEnabled: Boolean(this.filePath) && !this.persistenceDisabled,
      warning: this.warning,
      owners: this.reminders.size,
      reminders: reminderCount,
    }
  }

  create(safeOwnerId, {
    text,
    executeAt,
    execute_at: legacyExecuteAt,
    timezone: zone = 'UTC',
    recurrence: repeat = ReminderRecurrence.ONCE,
    kind = ReminderKind.REMINDER,
  } = {}) {
    return this.writeTransaction(() => {
      const owner = ownerId(safeOwnerId)
      const reminderTextValue = reminderText(text)
      const nextFireAt = timestamp(executeAt ?? legacyExecuteAt)
      const reminderKindValue = reminderKind(kind)
      const recurrenceValue = recurrence(repeat)
      const timezoneValue = timezone(zone)
      this.pruneOwners({ persist: false })
      const entries = this.reminders.get(owner) || new Map()
      if (entries.size >= this.maxRemindersPerOwner) {
        throw new ReminderStoreError(
          'owner_limit',
          `owner has reached the ${this.maxRemindersPerOwner} reminder limit`,
        )
      }
      const now = this.now()
      let id
      for (let attempts = 0; attempts < 10; attempts += 1) {
        id = reminderId(this.idFactory())
        if (!entries.has(id)) break
      }
      if (!id || entries.has(id)) {
        throw new ReminderStoreError('id_exhausted', 'unable to allocate a reminder id')
      }
      const reminder = {
        id,
        ownerId: owner,
        text: reminderTextValue,
        kind: reminderKindValue,
        timezone: timezoneValue,
        recurrence: recurrenceValue,
        nextFireAt,
        status: ReminderStatus.ACTIVE,
        createdAt: now,
        updatedAt: now,
        lastFiredAt: null,
        fireCount: 0,
        lastError: null,
      }
      const previousEntries = this.reminders.get(owner)
      const previousAccess = this.ownerAccess.get(owner)
      entries.set(id, reminder)
      this.reminders.set(owner, entries)
      this.ownerAccess.set(owner, now)
      this.pruneOwners({ persist: false })
      if (!this.persist()) {
        if (previousEntries) this.reminders.set(owner, previousEntries)
        else this.reminders.delete(owner)
        if (previousAccess === undefined) this.ownerAccess.delete(owner)
        else this.ownerAccess.set(owner, previousAccess)
        throw new ReminderStoreError(
          'persistence_unavailable',
          'reminder persistence is unavailable',
        )
      }
      return cloneReminder(reminder)
    })
  }

  get(safeOwnerId, id) {
    this.refreshIfChanged()
    const owner = ownerId(safeOwnerId)
    this.pruneOwners({ persist: false })
    this.touch(owner)
    return cloneReminder(this.reminders.get(owner)?.get(String(id)))
  }

  list(safeOwnerId, { statuses = null } = {}) {
    this.refreshIfChanged()
    const owner = ownerId(safeOwnerId)
    this.pruneOwners({ persist: false })
    this.touch(owner)
    const allowed = statuses == null
      ? null
      : new Set(statuses.map(value => String(value)))
    return [...(this.reminders.get(owner)?.values() || [])]
      .filter(reminder => !allowed || allowed.has(reminder.status))
      .sort((left, right) => (
        left.nextFireAt - right.nextFireAt
        || left.createdAt - right.createdAt
        || left.id.localeCompare(right.id)
      ))
      .map(cloneReminder)
  }

  due({ at = this.now(), ownerId: requestedOwner = null, limit = Infinity } = {}) {
    const timestampNow = timestamp(at, 'invalid_now')
    const owner = requestedOwner == null ? null : ownerId(requestedOwner)
    const max = Number.isFinite(Number(limit))
      ? Math.max(0, Math.floor(Number(limit)))
      : Infinity
    this.refreshIfChanged()
    this.pruneOwners({ persist: false })
    const result = []
    const owners = owner
      ? [[owner, this.reminders.get(owner)]]
      : [...this.reminders.entries()]
    for (const [, entries] of owners) {
      for (const reminder of entries?.values() || []) {
        if (
          reminder.status === ReminderStatus.ACTIVE
          && reminder.nextFireAt <= timestampNow
        ) {
          result.push(cloneReminder(reminder))
        }
      }
    }
    return result
      .sort((left, right) => left.nextFireAt - right.nextFireAt || left.id.localeCompare(right.id))
      .slice(0, max)
  }

  claimDue({ at = this.now(), ownerId: requestedOwner = null, limit = Infinity } = {}) {
    const timestampNow = timestamp(at, 'invalid_now')
    const owner = requestedOwner == null ? null : ownerId(requestedOwner)
    const max = Number.isFinite(Number(limit))
      ? Math.max(0, Math.floor(Number(limit)))
      : Infinity
    return this.writeTransaction(() => {
      this.pruneOwners({ persist: false })
      const owners = owner
        ? [[owner, this.reminders.get(owner)]]
        : [...this.reminders.entries()]
      const due = []
      for (const [, entries] of owners) {
        for (const reminder of entries?.values() || []) {
          if (
            reminder.status === ReminderStatus.ACTIVE
            && reminder.nextFireAt <= timestampNow
          ) due.push(reminder)
        }
      }
      due.sort((left, right) => left.nextFireAt - right.nextFireAt || left.id.localeCompare(right.id))
      const claimed = due.slice(0, max)
      const previous = claimed.map(reminder => ({ ...reminder }))
      claimed.forEach(reminder => {
        reminder.status = ReminderStatus.FIRING
        reminder.lastFiredAt = timestampNow
        reminder.fireCount += 1
        reminder.updatedAt = timestampNow
      })
      if (claimed.length && !this.persist()) {
        claimed.forEach((reminder, index) => Object.assign(reminder, previous[index]))
        throw new ReminderStoreError(
          'persistence_unavailable',
          'reminder persistence is unavailable',
        )
      }
      return claimed.map(cloneReminder)
    })
  }

  cancel(safeOwnerId, id) {
    return this.writeTransaction(() => {
      const owner = ownerId(safeOwnerId)
      const entries = this.reminders.get(owner)
      const reminder = entries?.get(String(id))
      if (!reminder) return null
      if (TERMINAL_STATUSES.has(reminder.status)) return cloneReminder(reminder)
      const previous = { ...reminder }
      reminder.status = ReminderStatus.CANCELLED
      reminder.updatedAt = this.now()
      reminder.lastError = null
      if (!this.persist()) {
        Object.assign(reminder, previous)
        throw new ReminderStoreError(
          'persistence_unavailable',
          'reminder persistence is unavailable',
        )
      }
      return cloneReminder(reminder)
    })
  }

  complete(safeOwnerId, id, { nextFireAt = null, at = this.now() } = {}) {
    return this.writeTransaction(() => {
      const owner = ownerId(safeOwnerId)
      const reminder = this.reminders.get(owner)?.get(String(id))
      if (!reminder) return null
      if (reminder.status !== ReminderStatus.FIRING) {
        throw new ReminderStoreError(
          'invalid_transition',
          `cannot complete reminder in ${reminder.status} state`,
        )
      }
      const timestampNow = timestamp(at, 'invalid_now')
      const next = nextFireAt == null ? null : timestamp(nextFireAt)
      if (reminder.recurrence !== ReminderRecurrence.ONCE && next == null) {
        throw new ReminderStoreError(
          'next_fire_required',
          'recurring reminders require the next fire time',
        )
      }
      if (reminder.recurrence === ReminderRecurrence.ONCE && next != null) {
        throw new ReminderStoreError(
          'unexpected_next_fire',
          'one-time reminders cannot be rescheduled',
        )
      }
      const previous = { ...reminder }
      reminder.status = next == null ? ReminderStatus.COMPLETED : ReminderStatus.ACTIVE
      reminder.nextFireAt = next == null ? reminder.nextFireAt : next
      reminder.updatedAt = timestampNow
      reminder.lastError = null
      if (!this.persist()) {
        Object.assign(reminder, previous)
        throw new ReminderStoreError(
          'persistence_unavailable',
          'reminder persistence is unavailable',
        )
      }
      return cloneReminder(reminder)
    })
  }

  fail(safeOwnerId, id, error, { at = this.now() } = {}) {
    return this.writeTransaction(() => {
      const owner = ownerId(safeOwnerId)
      const reminder = this.reminders.get(owner)?.get(String(id))
      if (!reminder) return null
      if (reminder.status !== ReminderStatus.FIRING) {
        throw new ReminderStoreError(
          'invalid_transition',
          `cannot fail reminder in ${reminder.status} state`,
        )
      }
      const previous = { ...reminder }
      reminder.status = ReminderStatus.FAILED
      reminder.updatedAt = timestamp(at, 'invalid_now')
      reminder.lastError = clean(error, 500) || 'reminder failed'
      if (!this.persist()) {
        Object.assign(reminder, previous)
        throw new ReminderStoreError(
          'persistence_unavailable',
          'reminder persistence is unavailable',
        )
      }
      return cloneReminder(reminder)
    })
  }
}
