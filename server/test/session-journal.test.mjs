import assert from 'node:assert/strict'
import { appendFile, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SessionEventType } from '../../shared/session-events.mjs'
import { SessionJournal } from '../src/session/session-journal.mjs'
import { replaySession } from '../src/session/session-replay.mjs'

async function journalFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'qwaudio-session-'))
  return new SessionJournal({ filePath: join(directory, 'session.jsonl'), sessionId: 'session-1' })
}

test('writes a DSH-shaped append-only session log and restores sequence', async () => {
  const journal = await journalFixture()
  await journal.append({ type: SessionEventType.USER_MESSAGE, eventId: 'e1', payload: { text: 'hello' } })
  await journal.append({ type: SessionEventType.TURN_END, payload: { reason: 'completed' } })
  const restored = new SessionJournal({ filePath: journal.filePath, sessionId: 'session-1' })
  await restored.open()
  assert.deepEqual(restored.eventsSince().map(event => event.seq), [1, 2])
  assert.equal(JSON.parse((await readFile(journal.filePath, 'utf8')).split('\n')[0]).type, 'session')
})

test('deduplicates retried writes by eventId', async () => {
  const journal = await journalFixture()
  const first = await journal.append({ type: SessionEventType.TASK_EVENT, eventId: 'retry-1', payload: { status: 'started' } })
  const second = await journal.append({ type: SessionEventType.TASK_EVENT, eventId: 'retry-1', payload: { status: 'started' } })
  assert.equal(first.seq, second.seq)
  assert.equal(journal.events.length, 1)
})

test('projects durable events without coupling to application components', async () => {
  const journal = await journalFixture()
  await Promise.all([
    journal.append({ type: SessionEventType.TASK_EVENT, payload: { status: 'started' } }),
    journal.append({ type: SessionEventType.TASK_EVENT, payload: { status: 'completed' } }),
  ])
  const statuses = journal.project((state, event) => [...state, event.payload.status], [])
  assert.deepEqual(statuses, ['started', 'completed'])
})

test('drops only an incomplete final JSONL frame during recovery', async () => {
  const journal = await journalFixture()
  await journal.append({ type: SessionEventType.USER_MESSAGE, payload: { text: 'hello' } })
  await journal.flush()
  await appendFile(journal.filePath, '{"type":"user/message"', 'utf8')
  const restored = new SessionJournal({ filePath: journal.filePath, sessionId: 'session-1' })
  await restored.open()
  assert.equal(restored.events.length, 1)
})

test('replays messages and latest task projection without side effects', async () => {
  const journal = await journalFixture()
  await journal.append({ type: SessionEventType.USER_MESSAGE, payload: { content: 'start' } })
  await journal.append({
    type: SessionEventType.TASK_EVENT,
    taskId: 'task-1',
    payload: { domainType: 'task.running', task: { id: 'task-1', status: 'running' } },
  })
  await journal.append({
    type: SessionEventType.TASK_EVENT,
    taskId: 'task-1',
    payload: { domainType: 'task.completed', task: { id: 'task-1', status: 'completed' } },
  })
  const replay = replaySession(journal.list(), { sessionId: 'session-1' })
  assert.equal(replay.messages[0].content, 'start')
  assert.equal(replay.tasks[0].status, 'completed')
  assert.equal(replay.lastSeq, 3)
})

test('replay collapses repeated snapshots of the same visible message', async () => {
  const journal = await journalFixture()
  await journal.append({
    type: SessionEventType.USER_MESSAGE,
    source: 'voice-user',
    payload: { messageId: 'user-1', content: 'preview' },
  })
  await journal.append({
    type: SessionEventType.USER_MESSAGE,
    source: 'voice-user',
    payload: { messageId: 'user-1', content: 'final' },
  })

  const replay = replaySession(journal.list(), { sessionId: 'session-1' })
  assert.equal(replay.messages.length, 1)
  assert.equal(replay.messages[0].id, 'user-1')
  assert.equal(replay.messages[0].content, 'final')
})
