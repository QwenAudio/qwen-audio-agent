import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'

import { createFlowStore } from '../src/observability/flow-store.mjs'
import { FlowRecorder } from '../src/observability/flow-recorder.mjs'

function tempDirectory() {
  return mkdtempSync(resolve(tmpdir(), 'flow-store-'))
}

const DAY = 86_400_000
const AT = Date.parse('2026-08-10T09:00:00Z')

function event(overrides = {}) {
  return {
    flowId: 'turn-1',
    at: AT,
    layer: 'gateway',
    type: 'task.running',
    ...overrides,
  }
}

test('writes events as one json line each, only when flushed', async () => {
  const directory = tempDirectory()
  const store = createFlowStore({ directory, flushIntervalMs: 5 })
  store.append(event())
  store.append(event({ type: 'task.completed' }))
  // Writes are batched on purpose: an observability aid must not put a file
  // write on the path of every event.
  assert.equal(readdirSync(directory).length, 0, 'nothing written before a flush')

  await store.flush()
  const [name] = readdirSync(directory)
  assert.equal(name, 'flow-2026-08-10.jsonl', 'one file per day')
  const lines = readFileSync(resolve(directory, name), 'utf8').trim().split('\n')
  assert.equal(lines.length, 2)
  assert.equal(JSON.parse(lines[1]).type, 'task.completed')
})

test('splits a batch that spans midnight into both days', async () => {
  const directory = tempDirectory()
  const store = createFlowStore({ directory })
  store.append(event({ at: Date.parse('2026-08-10T23:59:59Z') }))
  store.append(event({ at: Date.parse('2026-08-11T00:00:01Z') }))
  await store.flush()
  assert.deepEqual(readdirSync(directory).sort(),
    ['flow-2026-08-10.jsonl', 'flow-2026-08-11.jsonl'])
})

test('stops appending once a day exceeds its size cap', async () => {
  const directory = tempDirectory()
  const store = createFlowStore({ directory, maxFileBytes: 200 })
  for (let index = 0; index < 40; index += 1) {
    store.append(event({ type: `step-${index}` }))
    await store.flush()
  }
  const size = readFileSync(resolve(directory, 'flow-2026-08-10.jsonl'), 'utf8').length
  // A day of heavy use must not grow without bound.
  assert.ok(size < 1000, `expected a bounded file, got ${size} bytes`)
})

test('a failed write is reported and never thrown', async () => {
  const warnings = []
  // A path that cannot be a directory makes mkdir fail.
  const blocker = resolve(tempDirectory(), 'file')
  writeFileSync(blocker, 'x')
  const store = createFlowStore({
    directory: resolve(blocker, 'flow'),
    onWarning: warning => warnings.push(warning),
  })
  store.append(event())
  await store.flush()
  assert.equal(warnings.length, 1, 'losing a trace line must not disturb the caller')
  assert.match(warnings[0], /无法写入链路记录/)
})

test('reads history back newest first, within the same bounds as memory', async () => {
  const directory = tempDirectory()
  const store = createFlowStore({ directory })
  for (const flowId of ['a', 'b', 'c']) {
    store.append(event({ flowId, at: AT }))
  }
  await store.flush()

  const all = await store.loadRecent({ maxFlows: 10, maxEventsPerFlow: 10 })
  assert.equal(all.length, 3)

  const limited = await store.loadRecent({ maxFlows: 2, maxEventsPerFlow: 10 })
  assert.equal(new Set(limited.map(e => e.flowId)).size, 2,
    'loading history cannot exceed what the page would hold anyway')
})

test('skips a truncated final line from an interrupted write', async () => {
  const directory = tempDirectory()
  const store = createFlowStore({ directory })
  store.append(event())
  await store.flush()
  const path = resolve(directory, 'flow-2026-08-10.jsonl')
  writeFileSync(path, `${readFileSync(path, 'utf8')}{"flowId":"broken`)

  const loaded = await store.loadRecent()
  assert.equal(loaded.length, 1, 'a half-written line is skipped, the rest survives')
})

test('returns nothing when no history exists', async () => {
  const store = createFlowStore({ directory: resolve(tempDirectory(), 'missing') })
  assert.deepEqual(await store.loadRecent(), [])
  assert.equal(await store.prune(), 0)
})

test('prunes files past the retention window and keeps the rest', async () => {
  const directory = tempDirectory()
  const store = createFlowStore({
    directory,
    retentionDays: 2,
    now: () => AT,
  })
  store.append(event({ at: AT }))
  store.append(event({ at: AT - 5 * DAY }))
  store.append(event({ at: AT - 1 * DAY }))
  await store.flush()
  assert.equal(readdirSync(directory).length, 3)

  const removed = await store.prune()
  assert.equal(removed, 1)
  assert.ok(!readdirSync(directory).includes('flow-2026-08-05.jsonl'))
  assert.ok(readdirSync(directory).includes('flow-2026-08-10.jsonl'))
})

// Restoring is not recording: these events already happened, so their own
// timestamps must survive and subscribers must not hear about them as if they
// were live.
test('restores history into the recorder without re-stamping or notifying', () => {
  const recorder = new FlowRecorder()
  const heard = []
  recorder.subscribe(item => heard.push(item))

  recorder.restore([
    event({ flowId: 'turn-1', at: AT, type: 'task.accepted', sessionId: 'main' }),
    event({ flowId: 'turn-1', at: AT + 1000, type: 'task.completed' }),
  ])

  const flow = recorder.get('turn-1')
  assert.deepEqual(flow.events.map(e => e.at), [AT, AT + 1000], 'timestamps kept')
  assert.equal(flow.sessionId, 'main')
  assert.equal(flow.startedAt, AT)
  assert.equal(flow.updatedAt, AT + 1000)
  assert.deepEqual(heard, [], 'restored history is not a live event')
})

test('restore drops heartbeats and malformed entries, and honours the flow cap', () => {
  const recorder = new FlowRecorder({ maxFlows: 2 })
  recorder.restore([
    event({ type: 'task.progress' }),
    { at: AT },
    null,
    event({ flowId: 'a' }),
    event({ flowId: 'b' }),
    event({ flowId: 'c' }),
  ])
  assert.equal(recorder.get('turn-1'), null, 'a heartbeat carries nothing worth keeping')
  assert.equal(recorder.list().length, 2)
  recorder.restore('not an array')
  assert.equal(recorder.list().length, 2)
})
