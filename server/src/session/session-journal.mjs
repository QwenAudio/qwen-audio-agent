import { appendFile, mkdir, open, rename, unlink, truncate } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import {
  createSessionHeader,
  normalizeSessionEvent,
} from '../../../shared/session-events.mjs'
import { readSessionJournalSync } from './session-journal-reader.mjs'
import { compactJournalEvents, journalRetention, recordBytes, retainedJournalHeader } from './session-journal-retention.mjs'

function line(value) { return `${JSON.stringify(value)}\n` }

/**
 * Durable event journal for one logical Agent session, periodically compacted.
 * It deliberately does not know about TaskManager, ConversationSync or ACP;
 * those components consume the event stream and build their own projections.
 */
export class SessionJournal {
  constructor({ filePath, sessionId, metadata = {}, retention, now = () => new Date().toISOString() } = {}) {
    if (!filePath) throw new TypeError('filePath is required')
    if (!sessionId) throw new TypeError('sessionId is required')
    this.filePath = filePath
    this.sessionId = String(sessionId)
    this.metadata = { ...metadata }
    this.now = now
    this.retention = journalRetention(retention)
    this.header = createSessionHeader({ sessionId: this.sessionId, ...metadata })
    this.events = []
    this.eventIds = new Set()
    this.initialized = false
    this.openPromise = null
    this.writeQueue = Promise.resolve()
    this.bytes = recordBytes(this.header)
    this.pendingWrites = 0
  }

  async open() {
    if (this.initialized) return this
    if (!this.openPromise) {
      this.openPromise = this.openFile().finally(() => { this.openPromise = null })
    }
    return this.openPromise
  }

  async openFile() {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 })
    let validated
    try {
      validated = readSessionJournalSync(this.filePath, { sessionId: this.sessionId, retention: this.retention })
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      await appendFile(this.filePath, line(this.header), { encoding: 'utf8', mode: 0o600 })
      this.initialized = true
      return this
    }
    if (validated.removed) {
      await this.replaceFile(validated.header, validated.events)
    } else {
      if (validated.discardedBytes) await truncate(this.filePath, validated.validBytes)
      if (validated.needsNewline) await appendFile(this.filePath, '\n', 'utf8')
    }
    this.install(validated.header, validated.events)
    this.initialized = true
    return this
  }

  install(header, events) {
    this.header = header
    this.events = events
    this.bytes = recordBytes(header) + events.reduce((sum, event) => sum + recordBytes(event), 0)
    this.eventIds = new Set(events.map(event => event.eventId).filter(Boolean))
  }

  async replaceFile(header, events) {
    const temporary = `${this.filePath}.${randomUUID()}.tmp`
    let handle
    try {
      handle = await open(temporary, 'wx', 0o600)
      await handle.writeFile([header, ...events].map(line).join(''), 'utf8')
      await handle.sync()
      await handle.close()
      handle = null
      await rename(temporary, this.filePath)
    } finally {
      await handle?.close()
      await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error })
    }
  }

  append(event) {
    this.pendingWrites += 1
    const operation = this.writeQueue.then(async () => {
      await this.open()
      if (event?.eventId && this.eventIds.has(event.eventId)) {
        return this.events.find(item => item.eventId === event.eventId) || null
      }
      const normalized = normalizeSessionEvent(event, {
        sessionId: this.sessionId,
        seq: (this.events.at(-1)?.seq || 0) + 1,
        time: this.now(),
      })
      const size = recordBytes(normalized)
      if (this.events.length + 1 > this.retention.maxEvents || this.bytes + size + 256 > this.retention.maxBytes) {
        const candidates = [...this.events, normalized]
        const retained = compactJournalEvents(candidates, this.retention, recordBytes(this.header) + 256)
        const header = retainedJournalHeader(this.header, candidates.length - retained.length)
        await this.replaceFile(header, retained)
        this.install(header, retained)
        return normalized
      }
      try {
        await appendFile(this.filePath, line(normalized), { encoding: 'utf8', mode: 0o600 })
      } catch (error) {
        // An unsuccessful write can still leave bytes behind. Re-read and
        // repair before the next queued append instead of trusting memory.
        this.initialized = false
        throw error
      }
      this.events.push(normalized)
      this.bytes += size
      if (normalized.eventId) this.eventIds.add(normalized.eventId)
      return normalized
    }).finally(() => { this.pendingWrites -= 1 })
    this.writeQueue = operation.catch(() => {})
    return operation
  }

  async flush() { await this.writeQueue }
  list() { return [this.header, ...this.events].map(item => ({ ...item })) }
  eventsSince(seq = 0) { return this.events.filter(event => event.seq > seq).map(event => ({ ...event })) }

  project(reducer, initialState) {
    if (typeof reducer !== 'function') throw new TypeError('reducer must be a function')
    return this.events.reduce((state, event) => reducer(state, event), initialState)
  }
}

export async function loadSessionJournal(filePath, options = {}) {
  const journal = new SessionJournal({ filePath, ...options })
  await journal.open()
  return journal
}
