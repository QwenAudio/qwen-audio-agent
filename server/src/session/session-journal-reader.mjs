import { closeSync, openSync, readSync } from 'node:fs'
import { validateSessionLog } from '../../../shared/session-events.mjs'
import {
  compactJournalEvents, journalRetention, recordBytes, retainedJournalHeader,
} from './session-journal-retention.mjs'

/** Bounded streaming decoder for recovery. Never modifies its input file. */
export function readSessionJournalSync(filePath, { sessionId, retention } = {}) {
  const policy = journalRetention(retention)
  const fd = openSync(filePath, 'r')
  let header
  let events = []
  let bytes = 0
  let previousSeq = 0
  let removed = 0
  let validBytes = 0
  let totalBytes = 0
  let needsNewline = false
  let tail = Buffer.alloc(0)
  const consume = (raw, terminated) => {
    const text = raw.toString('utf8').trim()
    if (text) {
      let record
      try { record = JSON.parse(text) } catch (error) {
        if (!terminated && header) return false
        throw new TypeError('invalid committed session journal JSON', { cause: error })
      }
      if (!header) {
        validateSessionLog([record], { sessionId })
        header = record
        bytes = recordBytes(header) + 256 // space for retention metadata
      } else {
        validateSessionLog([header, record], { sessionId })
        if (record.seq <= previousSeq) throw new TypeError('invalid session event sequence')
        previousSeq = record.seq
        events.push(record)
        bytes += recordBytes(record)
        if (events.length > policy.maxEvents || bytes > policy.maxBytes) {
          const retained = compactJournalEvents(events, policy, recordBytes(header) + 256)
          removed += events.length - retained.length
          events = retained
          bytes = recordBytes(header) + 256 + events.reduce((sum, event) => sum + recordBytes(event), 0)
        }
      }
    }
    validBytes += raw.length + (terminated ? 1 : 0)
    needsNewline = !terminated
    return true
  }
  try {
    const buffer = Buffer.alloc(64 * 1024)
    let length
    while ((length = readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      totalBytes += length
      const input = Buffer.concat([tail, buffer.subarray(0, length)])
      let offset = 0
      let end
      while ((end = input.indexOf(10, offset)) !== -1) {
        if (end - offset > policy.maxBytes) throw new RangeError('session journal record exceeds byte limit')
        consume(input.subarray(offset, end), true)
        offset = end + 1
      }
      tail = Buffer.from(input.subarray(offset))
      if (tail.length > policy.maxBytes) throw new RangeError('session journal record exceeds byte limit')
    }
    if (tail.length) consume(tail, false)
    if (!header) throw new TypeError('session log is empty')
    header = retainedJournalHeader(header, removed)
    return {
      header, events, records: [header, ...events], removed,
      validBytes, discardedBytes: totalBytes - validBytes, needsNewline,
    }
  } finally {
    closeSync(fd)
  }
}
