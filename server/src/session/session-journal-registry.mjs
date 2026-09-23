import { readdirSync } from 'node:fs'
import { stat, unlink, rmdir, utimes } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { SessionJournal } from './session-journal.mjs'
import { readSessionJournalSync } from './session-journal-reader.mjs'
import { journalRetention, latestJournalTasks, needsJournalRecovery, recordBytes } from './session-journal-retention.mjs'

function pathSegment(value, fallback) {
  const text = String(value || '').trim()
  if (!text) return fallback
  // Injective and traversal-safe: unlike replacing punctuation with '_', this
  // cannot make two distinct owner/session ids share a journal directory.
  return Buffer.from(text, 'utf8').toString('base64url')
}

/** Owns per-owner/per-session journals without coupling them to a domain model. */
export class SessionJournalRegistry {
  constructor({
    directory, logger = null, retention,
    maxCachedJournals = 8, maxFiles = 256, maxTotalBytes = 128 * 1024 * 1024,
    maxAgeMs = 30 * 24 * 60 * 60 * 1000, maintenanceIntervalMs = 10 * 60 * 1000,
    maxQueuedOperations = 256, maxQueuedBytes = 16 * 1024 * 1024,
    now = () => Date.now(),
  } = {}) {
    if (!directory) throw new TypeError('directory is required')
    this.directory = resolve(directory)
    this.logger = logger
    this.journals = new Map()
    this.retention = journalRetention(retention)
    for (const [key, value] of Object.entries({ maxCachedJournals, maxFiles, maxTotalBytes, maxAgeMs, maintenanceIntervalMs, maxQueuedOperations, maxQueuedBytes })) {
      if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`invalid journal limit ${key}`)
      this[key] = value
    }
    this.now = now
    this.lastMaintenance = -Infinity
    this.operationQueue = Promise.resolve()
    this.queuedOperations = 0
    this.queuedBytes = 0
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
        retention: this.retention,
      })
      this.journals.set(key, journal)
    }
    this.journals.delete(key)
    this.journals.set(key, journal)
    this.trimCache(journal)
    return journal
  }

  trimCache(keep = null) {
    for (const [key, journal] of this.journals) {
      if (this.journals.size <= this.maxCachedJournals) break
      if (journal !== keep && !journal.pendingWrites && !journal.openPromise) this.journals.delete(key)
    }
  }

  enqueue(operation, bytes = 0) {
    if (this.queuedOperations >= this.maxQueuedOperations || this.queuedBytes + bytes > this.maxQueuedBytes) {
      return Promise.reject(Object.assign(new Error('Session journal write queue is full'), { code: 'SESSION_JOURNAL_BUSY' }))
    }
    this.queuedOperations += 1
    this.queuedBytes += bytes
    const result = this.operationQueue.then(operation).finally(() => {
      this.queuedOperations -= 1
      this.queuedBytes -= bytes
    })
    this.operationQueue = result.catch(() => {})
    return result
  }

  append({ ownerId, sessionId = 'main', event } = {}) {
    let bytes
    try { bytes = recordBytes(event) } catch (error) { return Promise.reject(error) }
    return this.enqueue(async () => {
      const journal = this.get(ownerId, sessionId)
      const result = await journal.append(event)
      if (this.now() - this.lastMaintenance >= this.maintenanceIntervalMs) {
        await this.prune(journal.filePath)
      }
      return result
    }, bytes).catch(error => {
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
    await this.operationQueue
    await Promise.all([...this.journals.values()].map(journal => journal.flush()))
    this.trimCache()
  }

  async read(ownerId, sessionId = 'main') {
    return this.enqueue(async () => {
      const journal = this.get(ownerId, sessionId)
      await journal.flush()
      await journal.open()
      return journal.list()
    })
  }

  maintain() { return this.enqueue(() => this.prune()) }

  async prune(keepPath = null) {
    this.lastMaintenance = this.now()
    const candidates = []
    let totalBytes = 0
    let files = 0
    for (const path of this.paths()) {
      try {
        const info = await stat(path)
        files += 1
        totalBytes += info.size
        const cached = [...this.journals.values()].find(journal => journal.filePath === path)
        if (path === keepPath || cached?.pendingWrites || cached?.openPromise) continue
        candidates.push({ path, info, cached })
      } catch (error) {
        // Never remove unreadable/corrupt files as part of retention.
        this.logger?.warn('session_journal.maintenance_failed', { path, error })
      }
    }
    candidates.sort((a, b) => a.info.mtimeMs - b.info.mtimeMs)
    let removed = 0
    for (const candidate of candidates) {
      const expired = this.now() - candidate.info.mtimeMs > this.maxAgeMs
      const overBudget = () => files > this.maxFiles || totalBytes > this.maxTotalBytes
      // Normal maintenance only stats retained files; do not parse the entire
      // history every ten minutes just to find that no cleanup is needed.
      if (!expired && !overBudget() && candidate.info.size <= this.retention.maxBytes) continue
      try {
        const decoded = readSessionJournalSync(candidate.path, { retention: this.retention })
        if (decoded.removed) {
          const journal = candidate.cached || new SessionJournal({
            filePath: candidate.path, sessionId: decoded.header.sessionId, retention: this.retention,
          })
          await journal.open()
          await utimes(candidate.path, candidate.info.atime, candidate.info.mtime)
          const updated = await stat(candidate.path)
          totalBytes += updated.size - candidate.info.size
          candidate.info = updated
        }
        if (!expired && !overBudget()) continue
        if (latestJournalTasks(decoded.events).some(needsJournalRecovery)) continue
        await unlink(candidate.path)
        files -= 1
        totalBytes -= candidate.info.size
        removed += 1
        for (const [key, journal] of this.journals) {
          if (journal.filePath === candidate.path) this.journals.delete(key)
        }
        // Remove only empty session directories, never recursively delete state.
        await rmdir(dirname(candidate.path)).catch(() => {})
      } catch (error) {
        this.logger?.warn('session_journal.prune_failed', { path: candidate.path, error })
      }
    }
    this.trimCache()
    if (removed) this.logger?.info('session_journal.pruned', { removed, files, bytes: totalBytes })
    if (files > this.maxFiles || totalBytes > this.maxTotalBytes) {
      this.logger?.warn('session_journal.retention_protected', { files, bytes: totalBytes })
    }
    return { removed, files, bytes: totalBytes }
  }

  readAllSync() {
    return [...this.iterateSync()]
  }

  *paths(directory = this.directory, onError = (error, path) => this.logger?.warn('session_journal.scan_failed', { path, error })) {
    let entries = []
    try { entries = readdirSync(directory, { withFileTypes: true }) } catch (error) {
      if (error.code !== 'ENOENT') onError(error, directory)
      return
    }
    for (const entry of entries) {
      const target = resolve(directory, entry.name)
      if (entry.isDirectory()) yield* this.paths(target, onError)
      else if (entry.isFile() && entry.name === 'session.jsonl') {
        yield target
      }
    }
  }

  // Startup projections consume one file at a time, rather than retaining
  // every parsed journal simultaneously. The array API remains for callers
  // that explicitly need a materialized snapshot.
  *iterateSync() {
    for (const target of this.paths()) {
      try {
        const decoded = readSessionJournalSync(target, { retention: this.retention })
        if (decoded.discardedBytes) {
          this.logger?.warn('session_journal.torn_tail', {
            path: target,
            discardedBytes: decoded.discardedBytes,
          })
        }
        yield { path: target, records: decoded.records }
      } catch (error) {
        this.logger?.warn('session_journal.read_failed', { path: target, error })
      }
    }
  }

  taskSnapshotsSync() {
    const snapshots = new Map()
    const revisions = new Map()
    for (const journalFile of this.iterateSync()) {
      for (const event of journalFile.records || []) {
        const task = event?.payload?.task
        if (event?.type !== 'qwaudio/task/event' || !task?.id) continue
        // seq is local to a journal, not a global revision. In particular, a
        // recycled short ID must not resurrect an older task from a long log.
        const revision = [Number(task.createdAt) || 0, Date.parse(event.time) || 0, event.seq]
        const previous = revisions.get(task.id)
        const different = previous ? revision.findIndex((value, index) => value !== previous[index]) : -1
        if (!previous || (different !== -1 && revision[different] > previous[different])) {
          snapshots.set(task.id, { ...task, journalSeq: event.seq })
          revisions.set(task.id, revision)
        }
      }
    }
    return [...snapshots.values()]
  }
}
