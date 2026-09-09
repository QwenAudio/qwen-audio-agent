import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createSessionHeader,
  normalizeSessionEvent,
  SessionEventType,
} from '../../shared/session-events.mjs'
import { SessionJournal } from '../../server/src/session/session-journal.mjs'
import { SessionJournalRegistry } from '../../server/src/session/session-journal-registry.mjs'

const DEFAULT_EVENT_COUNTS = [10_000, 100_000]
const DEFAULT_SESSION_COUNT = 100
const WRITE_BATCH_SIZE = 5_000

function usage() {
  console.log(`Usage: node --expose-gc scripts/bench/session-journal.mjs [options]

Options:
  --events=10k,100k,1m  Event counts to measure (default: 10k,100k)
  --sessions=100        Number of journals retained by the registry (default: 100)
  --keep                Keep generated journals and print their directory
  --help                Show this help

The benchmark measures cold open, eventsSince, list, one append, and registry
retention. It prints JSON so results can be compared across revisions.
`)
}

function parseCount(value, label) {
  const text = String(value).trim().toLowerCase()
  const multiplier = text.endsWith('m') ? 1_000_000 : text.endsWith('k') ? 1_000 : 1
  const number = Number(text.replace(/[km]$/, '')) * multiplier
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new RangeError(`${label} must be a positive integer or use k/m suffixes`)
  }
  return number
}

function parseArgs(argv) {
  const options = {
    eventCounts: DEFAULT_EVENT_COUNTS,
    sessionCount: DEFAULT_SESSION_COUNT,
    keep: false,
  }
  for (const argument of argv) {
    if (argument === '--help') {
      usage()
      process.exit(0)
    }
    if (argument === '--keep') {
      options.keep = true
      continue
    }
    const match = /^(--events|--sessions)=(.+)$/.exec(argument)
    if (!match) throw new Error(`Unknown option: ${argument}`)
    if (match[1] === '--events') {
      options.eventCounts = match[2].split(',').map((value, index) => parseCount(value, `events[${index}]`))
    } else {
      options.sessionCount = parseCount(match[2], 'sessions')
    }
  }
  return options
}

function line(value) {
  return `${JSON.stringify(value)}\n`
}

function rounded(value) {
  return Math.round(value * 100) / 100
}

function memorySnapshot() {
  const memory = process.memoryUsage()
  return {
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    externalBytes: memory.external,
  }
}

function collectGarbage() {
  if (typeof globalThis.gc === 'function') globalThis.gc()
}

async function createJournalFixture(directory, eventCount) {
  const filePath = join(directory, `session-${eventCount}.jsonl`)
  await writeFile(filePath, line(createSessionHeader({
    sessionId: `benchmark-${eventCount}`,
    benchmarkEventCount: eventCount,
  })), 'utf8')

  let batch = ''
  for (let index = 1; index <= eventCount; index += 1) {
    const event = normalizeSessionEvent({
      type: SessionEventType.USER_MESSAGE,
      eventId: `benchmark-event-${index}`,
      payload: {
        content: `benchmark event ${index}`,
        index,
      },
    }, {
      sessionId: `benchmark-${eventCount}`,
      seq: index,
      time: new Date(index * 1_000).toISOString(),
    })
    batch += line(event)
    if (index % WRITE_BATCH_SIZE === 0) {
      await appendFile(filePath, batch, 'utf8')
      batch = ''
    }
  }
  if (batch) await appendFile(filePath, batch, 'utf8')
  return filePath
}

async function measureJournal(directory, eventCount, sessionCount) {
  const filePath = await createJournalFixture(directory, eventCount)
  const sessionId = `benchmark-${eventCount}`
  const result = { eventCount }

  collectGarbage()
  const beforeOpen = memorySnapshot()
  const journal = new SessionJournal({ filePath, sessionId })
  let started = performance.now()
  await journal.open()
  result.openMs = rounded(performance.now() - started)
  result.memoryAfterOpen = memorySnapshot()
  result.memoryDeltaOpen = {
    rssBytes: result.memoryAfterOpen.rssBytes - beforeOpen.rssBytes,
    heapUsedBytes: result.memoryAfterOpen.heapUsedBytes - beforeOpen.heapUsedBytes,
  }

  started = performance.now()
  const since = journal.eventsSince(Math.floor(eventCount / 2))
  result.eventsSinceMs = rounded(performance.now() - started)
  result.eventsSinceCount = since.length
  result.memoryAfterEventsSince = memorySnapshot()

  started = performance.now()
  const snapshot = journal.list()
  result.listMs = rounded(performance.now() - started)
  result.listCount = snapshot.length
  result.memoryAfterList = memorySnapshot()

  started = performance.now()
  await journal.append({
    type: SessionEventType.TURN_END,
    payload: { reason: 'benchmark' },
  })
  result.appendMs = rounded(performance.now() - started)
  result.appendedSeq = journal.events.at(-1)?.seq

  const registry = new SessionJournalRegistry({ directory })
  started = performance.now()
  for (let index = 0; index < sessionCount; index += 1) {
    registry.get('benchmark-owner', `session-${index}`)
  }
  result.registryGetMs = rounded(performance.now() - started)
  result.registryRetainedJournals = registry.journals.size
  result.memoryAfterRegistry = memorySnapshot()
  return result
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const directory = await mkdtemp(join(tmpdir(), 'qwaudio-session-benchmark-'))
  try {
    const results = []
    for (const eventCount of options.eventCounts) {
      results.push(await measureJournal(directory, eventCount, options.sessionCount))
    }
    console.log(JSON.stringify({
      node: process.version,
      platform: process.platform,
      eventCounts: options.eventCounts,
      sessionCount: options.sessionCount,
      gcAvailable: typeof globalThis.gc === 'function',
      results,
      directory: options.keep ? directory : undefined,
    }, null, 2))
  } finally {
    if (!options.keep) await rm(directory, { recursive: true, force: true })
  }
}

main().catch(error => {
  console.error(error.stack || error)
  process.exitCode = 1
})
