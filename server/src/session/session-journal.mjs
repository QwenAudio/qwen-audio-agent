import { appendFile, mkdir, readFile, truncate } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  createSessionHeader,
  normalizeSessionEvent,
} from '../../../shared/session-events.mjs'
import { decodeSessionJournal } from './session-journal-format.mjs'

function line(value) { return `${JSON.stringify(value)}\n` }

/**
 * Durable, append-only event journal for one logical Agent session.
 * It deliberately does not know about TaskManager, ConversationSync or ACP;
 * those components consume the event stream and build their own projections.
 */
export class SessionJournal {
  constructor({ filePath, sessionId, metadata = {}, now = () => new Date().toISOString() } = {}) {
    if (!filePath) throw new TypeError('filePath is required')
    if (!sessionId) throw new TypeError('sessionId is required')
    this.filePath = filePath
    this.sessionId = String(sessionId)
    this.metadata = { ...metadata }
    this.now = now
    this.header = createSessionHeader({ sessionId: this.sessionId, ...metadata })
    this.events = []
    this.eventIds = new Set()
    this.initialized = false
    this.openPromise = null
    this.writeQueue = Promise.resolve()
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
    let raw
    try { raw = await readFile(this.filePath) } catch (error) {
      if (error.code !== 'ENOENT') throw error
      await appendFile(this.filePath, line(this.header), { encoding: 'utf8', mode: 0o600 })
      this.initialized = true
      return this
    }
    const validated = decodeSessionJournal(raw, { sessionId: this.sessionId })
    if (validated.discardedBytes) await truncate(this.filePath, validated.validBytes)
    if (validated.needsNewline) await appendFile(this.filePath, '\n', 'utf8')
    this.header = validated.header
    this.events = validated.events
    this.eventIds.clear()
    this.events.forEach(event => { if (event.eventId) this.eventIds.add(event.eventId) })
    this.initialized = true
    return this
  }

  append(event) {
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
      try {
        await appendFile(this.filePath, line(normalized), { encoding: 'utf8', mode: 0o600 })
      } catch (error) {
        // An unsuccessful write can still leave bytes behind. Re-read and
        // repair before the next queued append instead of trusting memory.
        this.initialized = false
        throw error
      }
      this.events.push(normalized)
      if (normalized.eventId) this.eventIds.add(normalized.eventId)
      return normalized
    })
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
