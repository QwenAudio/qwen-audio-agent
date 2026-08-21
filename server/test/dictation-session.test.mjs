import assert from 'node:assert/strict'
import test from 'node:test'

import { DictationSession } from '../src/voice/dictation-session.mjs'

function harness(options = {}) {
  const events = []
  const providerCalls = []
  const memoryCalls = []
  const auditCalls = []
  const timers = []
  const transcriber = {
    start(callbacks) { providerCalls.push('start'); this.callbacks = callbacks },
    append() { providerCalls.push('append') },
    pause() { providerCalls.push('pause') },
    resume() { providerCalls.push('resume') },
    close() { providerCalls.push('close') },
  }
  const session = new DictationSession({
    enabled: true,
    ownerId: 'owner',
    createTranscriber: () => transcriber,
    send: event => events.push(event),
    memoryService: { apply: (...args) => { memoryCalls.push(args); return { changed: 1 } } },
    memoryAudit: { record: event => auditCalls.push(event) },
    setTimer: callback => { timers.push(callback); return callback },
    clearTimer: () => {},
    id: (() => { let id = 0; return () => `id-${++id}` })(),
    ...options,
  })
  return { session, events, providerCalls, memoryCalls, auditCalls, timers, transcriber }
}

test('disabled session is a no-op and never creates a provider', () => {
  let created = 0
  const session = new DictationSession({
    enabled: false,
    createTranscriber: () => { created += 1 },
  })
  assert.equal(session.handle({ type: 'dictation.start' }), false)
  assert.equal(created, 0)
})

test('provider start rejection does not accept a dictation session', () => {
  const h = harness({
    createTranscriber: () => ({ start: () => false, close: () => {} }),
  })
  assert.equal(h.session.handle({
    type: 'dictation.start', revision: 0, text: '',
  }), false)
  assert.equal(h.session.snapshot().state, 'error')
})

test('synchronous provider failure cannot accept or revive START', () => {
  let callbacks
  const h = harness({
    createTranscriber: () => ({
      start(next) {
        callbacks = next
        next.error(new Error('failed while opening'))
      },
      close: () => {},
    }),
  })
  assert.equal(h.session.handle({
    type: 'dictation.start', revision: 0, text: 'draft',
  }), false)
  assert.equal(h.session.snapshot().state, 'error')
  assert.equal(callbacks.ready(), false)
})

test('start, partial, final and pause are stateful and clear transient data', () => {
  const h = harness()
  assert.equal(h.session.handle({
    type: 'dictation.start', revision: 3, text: 'draft', continuous: true,
  }), true)
  h.transcriber.callbacks.partial('hello')
  h.transcriber.callbacks.final('hello')
  assert.equal(h.events.some(event => event.type === 'dictation.final'), true)
  assert.equal(h.session.handle({ type: 'dictation.pause' }), true)
  assert.equal(h.session.snapshot().partial, '')
  assert.equal(h.session.snapshot().pendingCommit, null)
  assert.equal(h.transcriber.callbacks.final('late'), false)
})

test('all capture states time out and reject late provider messages', () => {
  for (const state of [
    'starting', 'listening', 'transcribing', 'editing', 'ready-to-send', 'paused',
  ]) {
    const h = harness()
    h.session.handle({ type: 'dictation.start', revision: 0, text: '' })
    h.session._transition(state)
    h.timers.at(-1)()
    assert.equal(h.session.snapshot().state, 'error')
    assert.equal(h.providerCalls.includes('close'), true)
    assert.equal(h.transcriber.callbacks.partial('late'), false)
  }
})

test('cancel, error, stop, and external suspend reject late operations', () => {
  for (const terminal of ['cancel', 'error', 'stop', 'suspend']) {
    const h = harness()
    h.session.handle({ type: 'dictation.start', revision: 0, text: '' })
    if (terminal === 'error') h.transcriber.callbacks.error(new Error('failed'))
    else if (terminal === 'suspend') h.session.suspend('desktop')
    else h.session.handle({ type: `dictation.${terminal}` })
    const terminalState = h.session.snapshot().state
    assert.equal(h.transcriber.callbacks.error(new Error('late error')), false)
    assert.equal(h.session.snapshot().state, terminalState)
    assert.equal(h.transcriber.callbacks.final('late'), false)
    assert.equal(h.session.handle({
      type: 'dictation.context', revision: 0, text: 'late', seq: 1,
    }), false)
  }
})

test('commit timeout clears server text before a late acknowledgement', () => {
  const h = harness()
  h.session.handle({ type: 'dictation.start', revision: 0, text: 'draft' })
  h.transcriber.callbacks.final('发送')
  const request = h.events.find(event => event.type === 'dictation.commit.request')
  h.timers.at(-1)()
  assert.equal(h.session.snapshot().state, 'error')
  assert.equal(h.session.text, '')
  assert.equal(h.session.handle({
    type: 'dictation.commit.ack', commitId: request.commitId,
    revision: request.revision, fingerprint: request.fingerprint, submitted: true,
  }), false)
})

test('STOP cannot resume and requires a fresh START', () => {
  const h = harness()
  h.session.handle({ type: 'dictation.start', revision: 0, text: '' })
  h.session.handle({ type: 'dictation.stop' })
  assert.equal(h.session.handle({ type: 'dictation.resume' }), false)
  assert.equal(h.session.handle({ type: 'dictation.start', revision: 1, text: 'new' }), true)
})

test('continuous composer reset clears text without closing the live provider', () => {
  const h = harness()
  h.session.handle({ type: 'dictation.start', revision: 0, text: 'draft' })
  h.transcriber.callbacks.final(' more')
  const expectedRevision = h.session.revision
  assert.equal(h.session.handle({
    type: 'dictation.reset', expectedRevision, revision: expectedRevision + 1,
  }), true)
  assert.equal(h.session.text, '')
  assert.equal(h.session.snapshot().state, 'listening')
  assert.equal(h.providerCalls.includes('close'), false)
})

test('deterministic edit commands only change one match in the latest dictated range', () => {
  const h = harness()
  h.session.handle({ type: 'dictation.start', revision: 0, text: 'prefix ' })
  h.transcriber.callbacks.final('red blue')
  h.transcriber.callbacks.final('replace red with green')
  const operation = h.events.find(event => event.type === 'dictation.operation')
  assert.deepEqual(operation, {
    type: 'dictation.operation', operation: 'replace',
    from: 'red', to: 'green', revision: 1, seq: 2,
  })
  assert.equal(h.session.text, 'prefix green blue')

  h.transcriber.callbacks.final('删除 prefix')
  assert.equal(h.session.text, 'prefix green blue删除 prefix')
  assert.equal(h.events.some(event => (
    event.type === 'dictation.state' && /最近口述范围/.test(event.notice || '')
  )), true)
  assert.equal(h.events.some(event => (
    event.type === 'dictation.state' && event.state === 'editing'
  )), true)
})

test('commit requires matching receipt, deduplicates, and only then updates memory', () => {
  const h = harness()
  h.session.handle({
    type: 'dictation.start',
    revision: 4,
    text: '纠正长期事实：上海改为杭州。',
  })
  h.transcriber.callbacks.final('发送')
  const request = h.events.find(event => event.type === 'dictation.commit.request')
  assert.ok(request)
  assert.equal(request.intent, 'memory-correction')
  assert.equal(h.memoryCalls.length, 0)
  assert.equal(h.session.handle({
    type: 'dictation.commit.ack', commitId: request.commitId,
    revision: request.revision, fingerprint: request.fingerprint,
    submitted: false, accepted: true, intent: 'memory-correction',
  }), true)
  assert.equal(h.memoryCalls.length, 1)
  assert.deepEqual(h.memoryCalls[0][1], [{
    document: 'memory', edits: [{ old_text: '上海', new_text: '杭州' }], append: '',
  }])
  assert.equal(h.auditCalls.length, 1)
  assert.equal('text' in h.auditCalls[0], false)
  assert.equal(h.session.handle({
    type: 'dictation.commit.ack', commitId: request.commitId,
    revision: request.revision, fingerprint: request.fingerprint, submitted: true,
  }), false)
  assert.equal(h.memoryCalls.length, 1)
})

test('mixed conversation text is never reclassified as a Memory-only control', () => {
  const h = harness()
  h.session.handle({
    type: 'dictation.start', revision: 0,
    text: '请回答这个问题。纠正长期事实：上海改为杭州。',
  })
  h.transcriber.callbacks.final('发送')
  const request = h.events.find(event => event.type === 'dictation.commit.request')
  assert.equal(request.intent, 'conversation')
  assert.equal(h.session.handle({
    type: 'dictation.commit.ack', commitId: request.commitId,
    revision: request.revision, fingerprint: request.fingerprint, submitted: true,
  }), true)
  assert.equal(h.memoryCalls.length, 0)
})

test('cancel, failed or stale commit causes zero Memory calls', () => {
  for (const mode of ['cancel', 'failed', 'stale']) {
    const h = harness()
    h.session.handle({ type: 'dictation.start', revision: 0, text: 'correct long-term fact: red to blue.' })
    h.transcriber.callbacks.final('send')
    const request = h.events.find(event => event.type === 'dictation.commit.request')
    if (mode === 'cancel') h.session.handle({ type: 'dictation.cancel' })
    h.session.handle({
      type: 'dictation.commit.ack', commitId: request.commitId,
      revision: mode === 'stale' ? 99 : request.revision,
      fingerprint: request.fingerprint,
      submitted: mode !== 'failed',
    })
    assert.equal(h.memoryCalls.length, 0)
    assert.equal(h.auditCalls.length, 0)
  }
})

test('sensitive explicit correction fails visibly without Memory or audit', () => {
  const h = harness()
  h.session.handle({ type: 'dictation.start', revision: 0, text: '纠正长期事实：旧值 改为 api key abc。' })
  h.transcriber.callbacks.final('发送')
  const request = h.events.find(event => event.type === 'dictation.commit.request')
  h.session.handle({
    type: 'dictation.commit.ack', commitId: request.commitId,
    revision: request.revision, fingerprint: request.fingerprint,
    submitted: false, accepted: true, intent: 'memory-correction',
  })
  assert.equal(h.memoryCalls.length, 0)
  assert.equal(h.auditCalls.length, 0)
  assert.match(h.events.at(-1).message, /敏感/)
})
