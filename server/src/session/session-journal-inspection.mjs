import { readFile, stat } from 'node:fs/promises'
import { SessionJournalRegistry } from './session-journal-registry.mjs'
import { decodeSessionJournal } from './session-journal-format.mjs'

/** Bounded, read-only inspection. Never repairs, opens or creates a journal. */
export async function inspectSessionJournals(directory, { maxBytes = 64 * 1024 * 1024, maxFileBytes = 8 * 1024 * 1024, maxFiles = 1_000 } = {}) {
  const result = { files: 0, bytes: 0, checked: 0, damaged: 0, tornTails: 0, skipped: 0, unreadable: 0, partial: false }
  let readBytes = 0
  const paths = new SessionJournalRegistry({ directory }).paths(directory, () => { result.unreadable += 1 })
  for (const path of paths) {
    if (result.files >= maxFiles) { result.partial = true; break }
    result.files += 1
    try {
      const info = await stat(path)
      result.bytes += info.size
      if (info.size > maxFileBytes || readBytes + info.size > maxBytes) {
        result.skipped += 1
        continue
      }
      readBytes += info.size
      const decoded = decodeSessionJournal(await readFile(path))
      result.checked += 1
      if (decoded.discardedBytes) result.tornTails += 1
    } catch {
      result.damaged += 1
    }
  }
  return result
}
