import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { createSessionHeader, normalizeSessionEvent } from '../../shared/session-events.mjs'
import { SessionJournal } from '../src/session/session-journal.mjs'
import { SessionJournalRegistry } from '../src/session/session-journal-registry.mjs'
import { readSessionJournalSync } from '../src/session/session-journal-reader.mjs'
import { replaySession } from '../src/session/session-replay.mjs'

const retention = { maxEvents: 20, maxBytes: 16 * 1024, maxMessages: 5, maxTerminalTasks: 5 }
async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'qwa-journal-retention-'))
  t.after(() => rm(path, { recursive: true, force: true }))
  return path
}
const taskEvent = (id, status, extra = {}) => ({
  type: 'qwaudio/task/event', taskId: id,
  payload: { task: { id, status, ...extra } },
})

test('compaction bounds memory/disk and retains task recovery, messages and increasing sequence across restart', async t => {
  const filePath = join(await directory(t), 'session.jsonl')
  const journal = new SessionJournal({ filePath, sessionId: 'test', retention })
  await journal.append(taskEvent('active', 'delegated'))
  await journal.append(taskEvent('scheduled', 'scheduled'))
  await journal.append(taskEvent('unheard', 'completed', { notificationStatus: 'delivering' }))
  await journal.append({ type: 'user/message', payload: { messageId: 'hello', content: 'hello' } })
  for (let i = 0; i < 300; i++) await journal.append(taskEvent('progress', 'running', { progress: i }))
  await journal.append(taskEvent('progress', 'cancelled'))
  assert.ok(journal.events.length <= retention.maxEvents)
  assert.ok(journal.eventIds.size <= retention.maxEvents)
  assert.ok((await stat(filePath)).size <= retention.maxBytes)
  assert.ok(journal.header.retention.discardedEvents > 0)
  const replay = replaySession(journal.list())
  assert.deepEqual(replay.tasks.map(task => task.status), ['delegated', 'scheduled', 'completed', 'cancelled'])
  assert.equal(replay.messages[0].content, 'hello')
  const next = new SessionJournal({ filePath, sessionId: 'test', retention })
  const lastSeq = journal.events.at(-1).seq
  assert.equal((await next.append({ type: 'turn/end' })).seq, lastSeq + 1)
})

test('byte limits apply even when the event count is low', async t => {
  const filePath = join(await directory(t), 'session.jsonl')
  const journal = new SessionJournal({ filePath, sessionId: 'test', retention })
  for (let i = 0; i < 30; i++) await journal.append({ type: 'turn/end', payload: { text: 'x'.repeat(3000) } })
  assert.ok((await stat(filePath)).size <= retention.maxBytes)
  const before = await readFile(filePath)
  await assert.rejects(journal.append({ type: 'user/message', payload: { content: 'x'.repeat(20000) } }), { code: 'SESSION_JOURNAL_CAPACITY' })
  assert.deepEqual(await readFile(filePath), before)
})

test('failed atomic replacement leaves disk and memory unchanged and retry uses the next sequence', async t => {
  const filePath = join(await directory(t), 'session.jsonl')
  const journal = new SessionJournal({ filePath, sessionId: 'test', retention: { ...retention, maxEvents: 3 } })
  for (let i = 0; i < 3; i++) await journal.append({ type: 'turn/end' })
  const before = await readFile(filePath)
  const replace = journal.replaceFile.bind(journal)
  journal.replaceFile = async () => { throw new Error('disk full') }
  await assert.rejects(journal.append({ type: 'turn/end' }), /disk full/)
  assert.deepEqual(await readFile(filePath), before)
  assert.equal(journal.events.at(-1).seq, 3)
  journal.replaceFile = replace
  assert.equal((await journal.append({ type: 'turn/end' })).seq, 4)
})

test('streaming legacy recovery retains bounded history and validates corruption before rewriting', async t => {
  const filePath = join(await directory(t), 'session.jsonl')
  const header = createSessionHeader({ sessionId: 'test' })
  const records = [header, ...Array.from({ length: 1000 }, (_, i) => normalizeSessionEvent({
    type: 'turn/end', payload: { text: '中文'.repeat(30) },
  }, { sessionId: 'test', seq: i + 1 }))]
  const raw = records.map(JSON.stringify).join('\n') + '\n'
  await writeFile(filePath, raw)
  const view = readSessionJournalSync(filePath, { retention })
  assert.ok(view.events.length <= retention.maxEvents)
  assert.equal(view.events.at(-1).seq, 1000)
  assert.equal(await readFile(filePath, 'utf8'), raw)
  await writeFile(filePath, raw + '{bad}\n')
  await assert.rejects(new SessionJournal({ filePath, sessionId: 'test', retention }).open(), /committed/)
  assert.equal(await readFile(filePath, 'utf8'), raw + '{bad}\n')
  await writeFile(filePath, raw)
  const journal = new SessionJournal({ filePath, sessionId: 'test', retention })
  await journal.open()
  assert.ok((await stat(filePath)).size <= retention.maxBytes)
  assert.equal((await journal.append({ type: 'turn/end' })).seq, 1001)
})

test('registry serializes concurrent writes and bounds idle journal cache', async t => {
  const registry = new SessionJournalRegistry({ directory: await directory(t), retention, maxCachedJournals: 2 })
  await Promise.all(Array.from({ length: 60 }, (_, i) => registry.append({
    ownerId: 'owner', sessionId: `session-${i % 5}`, event: { type: 'turn/end' },
  })))
  await registry.flush()
  assert.ok(registry.journals.size <= 2)
  for (let i = 0; i < 5; i++) {
    const records = await registry.read('owner', `session-${i}`)
    assert.equal(records.at(-1).seq, 12)
  }
})

test('maintenance prunes expired/quota-exceeding inactive files but protects recovery and corrupt files', async t => {
  const root = await directory(t)
  const registry = new SessionJournalRegistry({ directory: root, retention, maxFiles: 2, maxAgeMs: 1000 })
  for (const [sessionId, event] of [
    ['old', { type: 'turn/end' }],
    ['active', taskEvent('active', 'running')],
    ['pending', taskEvent('pending', 'completed', { notificationStatus: 'pending' })],
    ['corrupt', { type: 'turn/end' }],
  ]) {
    await registry.append({ ownerId: 'owner', sessionId, event })
    const path = registry.get('owner', sessionId).filePath
    if (sessionId === 'corrupt') await writeFile(path, 'invalid\n')
    await utimes(path, new Date(0), new Date(0))
  }
  const summary = await registry.maintain()
  assert.equal(summary.removed, 1)
  assert.equal(summary.files, 3)
  const paths = [...registry.paths()]
  assert.equal(paths.length, 3)
  assert.equal(registry.taskSnapshotsSync().length, 2)
})

test('pending write queue has a bounded size instead of accumulating event payloads', async t => {
  const registry = new SessionJournalRegistry({ directory: await directory(t), maxQueuedOperations: 2 })
  const gate = Promise.withResolvers()
  registry.operationQueue = gate.promise
  const append = () => registry.append({ ownerId: 'owner', event: { type: 'turn/end' } })
  const one = append()
  const two = append()
  assert.equal(await append(), null)
  gate.resolve()
  await Promise.all([one, two])
  assert.equal(registry.queuedOperations, 0)
  assert.equal(registry.queuedBytes, 0)
})

test('essential recovery records exceeding the budget reject the append without dropping prior work', async t => {
  const filePath = join(await directory(t), 'session.jsonl')
  const journal = new SessionJournal({ filePath, sessionId: 'test', retention: { ...retention, maxEvents: 3 } })
  for (let i = 0; i < 3; i++) await journal.append(taskEvent(`task-${i}`, 'scheduled'))
  const before = await readFile(filePath)
  await assert.rejects(journal.append(taskEvent('task-4', 'running')), { code: 'SESSION_JOURNAL_CAPACITY' })
  assert.deepEqual(await readFile(filePath), before)
  assert.equal(replaySession(journal.list()).tasks.length, 3)
})

test('total disk byte budget removes the oldest eligible journal without waiting for expiry', async t => {
  const registry = new SessionJournalRegistry({ directory: await directory(t), retention, maxTotalBytes: 5000 })
  for (const sessionId of ['older', 'newer']) {
    await registry.append({ ownerId: 'owner', sessionId, event: { type: 'turn/end', payload: { text: 'x'.repeat(3000) } } })
  }
  const summary = await registry.maintain()
  assert.equal(summary.files, 1)
  assert.ok(summary.bytes <= 5000)
})
