// Keeping a flow trace across a restart.
//
// Records live in memory, which means a restart erases exactly the interaction
// someone was about to look at. That happened: a failing round was lost because
// the Gateway was restarted before anyone read it, and the investigation had to
// fall back to the backend's own database.
//
// Persistence is a second, separate switch on purpose. "In memory only, cleared
// on restart" is a privacy property of the default, and a trace holds what the
// user said, what the backend was asked and what it answered. Turning on
// analysis must not silently start writing that to disk.
import { appendFile, mkdir, readdir, readFile, stat, unlink } from 'node:fs/promises'
import { resolve } from 'node:path'

export const DEFAULT_RETENTION_DAYS = 7
export const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024
// Writes are batched rather than issued per event: a trace can produce a burst
// of events, and an observability aid must not put a file write on the path of
// every one of them.
const FLUSH_INTERVAL_MS = 1000

function dayStamp(at) {
  return new Date(at).toISOString().slice(0, 10)
}

export function createFlowStore({
  directory,
  retentionDays = DEFAULT_RETENTION_DAYS,
  maxFileBytes = DEFAULT_MAX_FILE_BYTES,
  flushIntervalMs = FLUSH_INTERVAL_MS,
  now = () => Date.now(),
  onWarning = () => {},
} = {}) {
  const pending = []
  let timer = null
  let writing = false

  const fileFor = at => resolve(directory, `flow-${dayStamp(at)}.jsonl`)

  async function flush() {
    if (writing || pending.length === 0) return
    writing = true
    const batch = pending.splice(0, pending.length)
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 })
      // Group by day so a batch spanning midnight lands in both files rather
      // than all in the first one.
      const byFile = new Map()
      for (const event of batch) {
        const path = fileFor(event.at || now())
        byFile.set(path, (byFile.get(path) || '') + `${JSON.stringify(event)}\n`)
      }
      for (const [path, text] of byFile) {
        const size = await stat(path).then(s => s.size).catch(() => 0)
        // A single day of heavy use should not grow without bound. Past the cap
        // the day's file stops accepting more rather than being rotated into
        // ever more files: the recent past is what gets analysed.
        if (size >= maxFileBytes) continue
        await appendFile(path, text, { encoding: 'utf8', mode: 0o600 })
      }
    } catch (error) {
      // Losing a trace line must never disturb the interaction that produced
      // it. Say so once and carry on.
      onWarning(`无法写入链路记录：${error.message}`)
    } finally {
      writing = false
    }
  }

  return {
    append(event) {
      if (!event) return
      pending.push(event)
      if (timer) return
      timer = setTimeout(() => {
        timer = null
        flush()
      }, flushIntervalMs)
      // Never hold the process open for a trace file.
      timer.unref?.()
    },

    flush,

    // Newest first, bounded by the same limits the in-memory recorder uses, so
    // loading a day of history cannot exceed what the page would hold anyway.
    async loadRecent({ maxFlows = 50, maxEventsPerFlow = 500 } = {}) {
      let files = []
      try {
        files = (await readdir(directory))
          .filter(name => /^flow-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
          .sort()
          .reverse()
      } catch {
        return []
      }
      const flows = new Map()
      for (const name of files) {
        let text = ''
        try {
          text = await readFile(resolve(directory, name), 'utf8')
        } catch (error) {
          onWarning(`无法读取链路记录 ${name}：${error.message}`)
          continue
        }
        // Read a file back to front: the most recent events matter most, and a
        // truncated final line from an interrupted write is simply skipped.
        const lines = text.split('\n').filter(Boolean).reverse()
        for (const line of lines) {
          let event = null
          try {
            event = JSON.parse(line)
          } catch {
            continue
          }
          if (!event?.flowId) continue
          if (!flows.has(event.flowId) && flows.size >= maxFlows) continue
          const list = flows.get(event.flowId) || []
          if (list.length >= maxEventsPerFlow) continue
          list.unshift(event)
          flows.set(event.flowId, list)
        }
        if (flows.size >= maxFlows) break
      }
      // Chronological across all flows, which is what the recorder expects to
      // receive.
      return [...flows.values()].flat().sort((a, b) => (a.at || 0) - (b.at || 0))
    },

    async prune() {
      const cutoff = dayStamp(now() - retentionDays * 86_400_000)
      let files = []
      try {
        files = await readdir(directory)
      } catch {
        return 0
      }
      let removed = 0
      for (const name of files) {
        const match = name.match(/^flow-(\d{4}-\d{2}-\d{2})\.jsonl$/)
        if (!match || match[1] >= cutoff) continue
        try {
          await unlink(resolve(directory, name))
          removed += 1
        } catch (error) {
          onWarning(`无法清理链路记录 ${name}：${error.message}`)
        }
      }
      return removed
    },
  }
}
