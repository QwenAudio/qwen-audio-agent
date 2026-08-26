import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { SessionJournal } from './session-journal.mjs'

function pathSegment(value, fallback) {
  const text = String(value || '').trim()
  if (!text) return fallback
  // Injective and traversal-safe: unlike replacing punctuation with '_', this
  // cannot make two distinct owner/session ids share a journal directory.
  return Buffer.from(text, 'utf8').toString('base64url')
}

/** Owns per-owner/per-session journals without coupling them to a domain model. */
export class SessionJournalRegistry {
  constructor({ directory, logger = null } = {}) {
    if (!directory) throw new TypeError('directory is required')
    this.directory = resolve(directory)
    this.logger = logger
    this.journals = new Map()
  }

  key(ownerId, sessionId) {
    return `${String(ownerId || 'personal')}\u0000${String(sessionId || 'main')}`
  }

  get(ownerId, sessionId = 'main') {
    const key = this.key(ownerId, sessionId)
    let journal = this.journals.get(key)
    if (!journal) {
      const owner = pathSegment(ownerId, 'personal')
      const session = pathSegment(sessionId, 'main')
      journal = new SessionJournal({
        filePath: resolve(this.directory, owner, session, 'session.jsonl'),
        sessionId: String(sessionId || 'main'),
        metadata: { ownerId: String(ownerId || 'personal') },
      })
      this.journals.set(key, journal)
    }
    return journal
  }

  append({ ownerId, sessionId = 'main', event } = {}) {
    const journal = this.get(ownerId, sessionId)
    return journal.append(event).catch(error => {
      this.logger?.warn('session_journal.append_failed', {
        ownerId,
        sessionId,
        eventType: event?.type,
        error,
      })
      return null
    })
  }

  async flush() {
    await Promise.all([...this.journals.values()].map(journal => journal.flush()))
  }

  async read(ownerId, sessionId = 'main') {
    const journal = this.get(ownerId, sessionId)
    await journal.flush()
    await journal.open()
    return journal.list()
  }

  readAllSync() {
    const records = []
    const walk = directory => {
      let entries = []
      try { entries = readdirSync(directory, { withFileTypes: true }) } catch { return }
      for (const entry of entries) {
        const target = resolve(directory, entry.name)
        if (entry.isDirectory()) walk(target)
        else if (entry.isFile() && entry.name === 'session.jsonl') {
          try {
            const parsed = readFileSync(target, 'utf8').split('\n').filter(Boolean)
              .map(line => JSON.parse(line))
            records.push({ path: target, records: parsed })
          } catch (error) {
            this.logger?.warn('session_journal.read_failed', { path: target, error })
          }
        }
      }
    }
    walk(this.directory)
    return records
  }

  taskSnapshotsSync() {
    const snapshots = new Map()
    for (const journalFile of this.readAllSync()) {
      for (const event of journalFile.records || []) {
        const task = event?.payload?.task
        if (event?.type !== 'qwaudio/task/event' || !task?.id) continue
        const previous = snapshots.get(task.id)
        if (!previous || Number(event.seq || 0) > Number(previous.journalSeq || 0)) {
          snapshots.set(task.id, { ...task, journalSeq: event.seq })
        }
      }
    }
    return [...snapshots.values()]
  }
}
