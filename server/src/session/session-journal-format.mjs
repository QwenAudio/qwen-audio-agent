import { validateSessionLog } from '../../../shared/session-events.mjs'

/** One decoder for replay and append recovery; only an uncommitted tail may be discarded. */
export function decodeSessionJournal(value, options = {}) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8')
  const records = []
  let offset = 0
  let line = 0
  let validBytes = bytes.length
  while (offset < bytes.length) {
    const newline = bytes.indexOf(10, offset)
    const end = newline === -1 ? bytes.length : newline
    const text = bytes.subarray(offset, end).toString('utf8').trim()
    line += 1
    if (text) {
      try {
        records.push(JSON.parse(text))
      } catch (error) {
        if (newline !== -1) {
          throw new TypeError(`invalid JSON at line ${line}`, { cause: error })
        }
        validBytes = offset
        break
      }
    }
    offset = end + 1
  }
  // Validate before a caller repairs the file. A bad header, sequence or
  // committed record must never cause a destructive "recovery".
  const validated = validateSessionLog(records, options)
  return {
    ...validated,
    records,
    validBytes,
    discardedBytes: bytes.length - validBytes,
    needsNewline: validBytes > 0 && bytes[validBytes - 1] !== 10,
  }
}
