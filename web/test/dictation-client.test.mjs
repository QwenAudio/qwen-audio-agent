import assert from 'node:assert/strict'
import test from 'node:test'
import { createDictationClient } from '../../shared/dictation-client.mjs'
import { draftPayloadHash } from '../../shared/dictation-draft.mjs'

function harness({ enabled = true, commitResult = true } = {}) {
  const sent = []
  const commits = []
  const operations = []
  let snapshot = {
    text: 'draft text',
    selectionStart: 10,
    selectionEnd: 10,
    revision: 3,
  }
  let id = 0
  const client = createDictationClient({
    enabled,
    send: event => sent.push(event),
    createId: prefix => `${prefix}-${++id}`,
    locale: 'en-US',
    composer: {
      snapshot: () => snapshot,
      applyOperation(operation) {
        operations.push(operation)
        snapshot = {
          text: `${snapshot.text}!`,
          selectionStart: 11,
          selectionEnd: 11,
          revision: snapshot.revision + 1,
        }
        return { applied: true, revision: snapshot.revision }
      },
      commitDictation(commitId) {
        commits.push(commitId)
        return commitResult
      },
    },
  })
  return { client, commits, operations, sent, snapshot: () => snapshot }
}

test('starts only when enabled and emits monotonic client sequences', () => {
  const disabled = harness({ enabled: false })
  assert.equal(disabled.client.start(), false)
  assert.deepEqual(disabled.sent, [])

  const subject = harness()
  assert.equal(subject.client.start(), true)
  subject.client.pause()
  subject.client.resume()
  subject.client.cancel()
  assert.deepEqual(subject.sent.map(event => [event.type, event.seq]), [
    ['dictation.start', 1],
    ['dictation.pause', 2],
    ['dictation.resume', 3],
    ['dictation.cancel', 4],
  ])
  assert.equal(subject.sent[0].continuous, true)
  assert.equal(subject.sent[0].locale, 'en-US')
})

test('answers context requests and acknowledges revisioned operations', () => {
  const subject = harness()
  subject.client.start()
  subject.client.handle({
    type: 'dictation.context.request',
    sessionId: 'dictation-1',
    seq: 1,
    requestId: 'request-1',
  })
  assert.deepEqual(subject.sent.at(-1), {
    type: 'dictation.context',
    sessionId: 'dictation-1',
    seq: 2,
    requestId: 'request-1',
    text: 'draft text',
    selectionStart: 10,
    selectionEnd: 10,
    revision: 3,
  })

  subject.client.handle({
    type: 'dictation.operation',
    sessionId: 'dictation-1',
    seq: 2,
    operationId: 'operation-1',
    baseRevision: 3,
    kind: 'insert',
    text: '!',
  })
  assert.equal(subject.operations.length, 1)
  assert.deepEqual(subject.sent.at(-1), {
    type: 'dictation.operation.ack',
    sessionId: 'dictation-1',
    seq: 3,
    operationId: 'operation-1',
    status: 'applied',
    revision: 4,
  })
})

test('rejects stale server events and reports composer revision conflicts', () => {
  const subject = harness()
  subject.client.start()
  subject.client.handle({
    type: 'dictation.operation',
    sessionId: 'dictation-1',
    seq: 2,
    operationId: 'operation-1',
    baseRevision: 2,
    kind: 'insert',
    text: 'ignored',
  })
  subject.client.handle({
    type: 'dictation.state',
    sessionId: 'dictation-1',
    seq: 1,
    state: 'cancelled',
  })
  assert.equal(subject.operations.length, 0)
  assert.equal(subject.sent.at(-1).status, 'conflict')
  assert.equal(subject.client.snapshot().state, 'starting')
})

test('invokes the ordinary composer submit once for a duplicate commit request', () => {
  const subject = harness()
  subject.client.start()
  const commit = {
    type: 'dictation.commit.request',
    sessionId: 'dictation-1',
    seq: 2,
    commitId: 'commit-1',
    revision: 3,
    payloadHash: draftPayloadHash('draft text'),
  }
  subject.client.handle(commit)
  subject.client.handle({ ...commit, seq: 3 })

  assert.deepEqual(subject.commits, ['commit-1'])
  assert.deepEqual(
    subject.sent.filter(event => event.type === 'dictation.commit.ack')
      .map(event => event.status),
    ['submitted', 'submitted'],
  )
})

test('does not submit when revision or payload hash differs from the composer', () => {
  const subject = harness()
  subject.client.start()
  subject.client.handle({
    type: 'dictation.commit.request',
    sessionId: 'dictation-1',
    seq: 2,
    commitId: 'commit-1',
    revision: 2,
    payloadHash: draftPayloadHash('different'),
  })
  assert.deepEqual(subject.commits, [])
  assert.equal(subject.sent.at(-1).status, 'rejected')
})

test('a rejected composer submission is acknowledged once and never retried', () => {
  const subject = harness({ commitResult: false })
  subject.client.start()
  const commit = {
    type: 'dictation.commit.request',
    sessionId: 'dictation-1',
    seq: 2,
    commitId: 'commit-1',
    revision: 3,
    payloadHash: draftPayloadHash('draft text'),
  }
  subject.client.handle(commit)
  subject.client.handle({ ...commit, seq: 3 })

  assert.deepEqual(subject.commits, ['commit-1'])
  assert.deepEqual(
    subject.sent.filter(event => event.type === 'dictation.commit.ack')
      .map(event => event.status),
    ['rejected', 'rejected'],
  )
})

test('exposes every visible server state and routes audio only while capturing', () => {
  const subject = harness()
  const states = []
  subject.client.subscribe(snapshot => states.push(snapshot.state))
  subject.client.start()
  subject.client.handle({
    type: 'dictation.state',
    sessionId: 'dictation-1',
    seq: 1,
    state: 'listening',
  })
  assert.equal(subject.client.appendAudio('audio-one'), true)
  subject.client.handle({
    type: 'dictation.state',
    sessionId: 'dictation-1',
    seq: 2,
    state: 'paused',
  })
  assert.equal(subject.client.appendAudio('audio-two'), false)
  assert.deepEqual(states, ['starting', 'listening', 'paused'])
  assert.equal(
    subject.sent.filter(event => event.type === 'dictation.audio.append').length,
    1,
  )
})

test('starts a fresh live session after cancellation', () => {
  const subject = harness()
  subject.client.start()
  subject.client.cancel()
  subject.client.start()
  assert.deepEqual(subject.sent.filter(event => event.type === 'dictation.start'), [
    {
      type: 'dictation.start',
      sessionId: 'dictation-1',
      seq: 1,
      locale: 'en-US',
      continuous: true,
    },
    {
      type: 'dictation.start',
      sessionId: 'dictation-2',
      seq: 1,
      locale: 'en-US',
      continuous: true,
    },
  ])
})
