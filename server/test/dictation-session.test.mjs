import assert from 'node:assert/strict'
import test from 'node:test'
import { CommitRegistry } from '../src/dictation/commit-registry.mjs'
import { DictationSession } from '../src/dictation/dictation-session.mjs'

function harness({ rewriteText } = {}) {
  const sent = []
  const calls = []
  const timers = []
  let callbacks
  const transcriber = {
    async start(options) { calls.push(['start', options]) },
    appendAudio(audio) { calls.push(['audio', audio]) },
    pause() { calls.push(['pause']) },
    resume() { calls.push(['resume']) },
    close(options) { calls.push(['close', options]) },
  }
  const session = new DictationSession({
    send: event => sent.push(event),
    createTranscriber(options) {
      callbacks = options
      return transcriber
    },
    rewriteText,
    createId: (() => {
      const counts = new Map()
      return prefix => {
        const next = (counts.get(prefix) || 0) + 1
        counts.set(prefix, next)
        return `${prefix}-${next}`
      }
    })(),
    setTimer(callback, delay) {
      const timer = { callback, delay, cleared: false }
      timers.push(timer)
      return timer
    },
    clearTimer(timer) {
      if (timer) timer.cleared = true
    },
  })
  return { callbacks: () => callbacks, calls, sent, session, timers }
}

async function start(subject, overrides = {}) {
  await subject.session.handle({
    type: 'dictation.start',
    sessionId: 'dictation-1',
    seq: 1,
    locale: 'zh-CN',
    ...overrides,
  })
}

test('starts an independent continuous session and pauses after 45 seconds', async () => {
  const subject = harness()
  await start(subject)

  assert.deepEqual(subject.calls, [[
    'start',
    { locale: 'zh-CN', continuous: true },
  ]])
  assert.deepEqual(subject.sent.map(event => [event.type, event.state]), [
    ['dictation.state', 'starting'],
    ['dictation.state', 'listening'],
  ])
  assert.equal(subject.timers.at(-1).delay, 45_000)

  subject.timers.at(-1).callback()
  assert.deepEqual(subject.calls.at(-1), ['pause'])
  assert.equal(subject.sent.at(-1).state, 'paused')
})

test('cancel remains immediate while the provider is still starting', async () => {
  let finishStart
  const subject = harness()
  subject.session.createTranscriber = options => {
    const transcriber = {
      start: () => new Promise(resolve => { finishStart = resolve }),
      close: value => subject.calls.push(['close', value]),
    }
    Object.assign(subject, { pendingCallbacks: options })
    return transcriber
  }
  await start(subject)
  await subject.session.handle({
    type: 'dictation.cancel',
    sessionId: 'dictation-1',
    seq: 2,
  })
  assert.equal(subject.sent.at(-1).state, 'cancelled')
  assert.deepEqual(subject.calls.at(-1), ['close', { finish: false }])
  finishStart()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(subject.sent.at(-1).state, 'cancelled')
})

test('rejects repeated and out-of-order client sequences without applying them', async () => {
  const subject = harness()
  await start(subject)
  await subject.session.handle({
    type: 'dictation.audio.append',
    sessionId: 'dictation-1',
    seq: 1,
    audio: 'ignored',
  })
  await subject.session.handle({
    type: 'dictation.audio.append',
    sessionId: 'dictation-1',
    seq: 0,
    audio: 'also-ignored',
  })

  assert.equal(subject.calls.some(call => call[0] === 'audio'), false)
  assert.deepEqual(subject.sent.slice(-2).map(event => event.code), [
    'seq_conflict',
    'seq_conflict',
  ])
})

test('turns a final transcript into one revision-guarded insertion', async () => {
  const subject = harness()
  await start(subject)
  await subject.callbacks().onFinal('new words')
  const request = subject.sent.at(-1)
  assert.equal(request.type, 'dictation.context.request')

  await subject.session.handle({
    type: 'dictation.context',
    sessionId: 'dictation-1',
    seq: 2,
    requestId: request.requestId,
    text: 'hello world',
    selectionStart: 6,
    selectionEnd: 6,
    revision: 4,
  })
  assert.deepEqual(subject.sent.at(-1), {
    type: 'dictation.operation',
    sessionId: 'dictation-1',
    seq: 6,
    operationId: 'operation-1',
    baseRevision: 4,
    kind: 'insert',
    text: 'new words',
  })

  await subject.session.handle({
    type: 'dictation.operation.ack',
    sessionId: 'dictation-1',
    seq: 3,
    operationId: 'operation-1',
    status: 'applied',
    revision: 5,
  })
  assert.equal(subject.sent.at(-1).state, 'listening')
})

test('requests one fresh snapshot on a revision conflict then fails closed', async () => {
  const subject = harness()
  await start(subject)
  await subject.callbacks().onFinal('hello')
  const request = subject.sent.at(-1)
  await subject.session.handle({
    type: 'dictation.context',
    sessionId: 'dictation-1',
    seq: 2,
    requestId: request.requestId,
    text: '',
    selectionStart: 0,
    selectionEnd: 0,
    revision: 1,
  })
  await subject.session.handle({
    type: 'dictation.operation.ack',
    sessionId: 'dictation-1',
    seq: 3,
    operationId: 'operation-1',
    status: 'conflict',
    revision: 2,
  })
  assert.equal(subject.sent.at(-1).type, 'dictation.context.request')

  await subject.session.handle({
    type: 'dictation.context',
    sessionId: 'dictation-1',
    seq: 4,
    requestId: subject.sent.at(-1).requestId,
    text: 'typed',
    selectionStart: 5,
    selectionEnd: 5,
    revision: 2,
  })
  const retryOperation = subject.sent.at(-1)
  await subject.session.handle({
    type: 'dictation.operation.ack',
    sessionId: 'dictation-1',
    seq: 5,
    operationId: retryOperation.operationId,
    status: 'conflict',
    revision: 3,
  })
  assert.equal(subject.sent.at(-2).type, 'dictation.error')
  assert.equal(subject.sent.at(-2).code, 'revision_conflict')
  assert.equal(subject.sent.at(-1).state, 'error')
})

test('terminal send asks the client to submit once and continuous mode re-enters listening', async () => {
  const subject = harness()
  await start(subject)
  await subject.callbacks().onFinal('发送')
  const request = subject.sent.at(-1)
  await subject.session.handle({
    type: 'dictation.context',
    sessionId: 'dictation-1',
    seq: 2,
    requestId: request.requestId,
    text: 'ready draft',
    selectionStart: 11,
    selectionEnd: 11,
    revision: 9,
  })
  const commit = subject.sent.at(-1)
  assert.equal(commit.type, 'dictation.commit.request')
  assert.equal(commit.commitId, 'commit-1')
  assert.equal(commit.revision, 9)
  assert.equal(commit.payloadHash.length, 64)

  await subject.session.handle({
    type: 'dictation.commit.ack',
    sessionId: 'dictation-1',
    seq: 3,
    commitId: 'commit-1',
    status: 'submitted',
  })
  await subject.session.handle({
    type: 'dictation.commit.ack',
    sessionId: 'dictation-1',
    seq: 4,
    commitId: 'commit-1',
    status: 'submitted',
  })
  assert.equal(
    subject.sent.filter(event => event.type === 'dictation.commit.request').length,
    1,
  )
  assert.equal(subject.sent.at(-1).state, 'listening')
})

test('mid-sentence send remains draft text and never requests commit', async () => {
  const subject = harness()
  await start(subject)
  await subject.callbacks().onFinal('把文件发送给小王')
  const request = subject.sent.at(-1)
  await subject.session.handle({
    type: 'dictation.context',
    sessionId: 'dictation-1',
    seq: 2,
    requestId: request.requestId,
    text: '',
    selectionStart: 0,
    selectionEnd: 0,
    revision: 0,
  })
  assert.equal(subject.sent.at(-1).type, 'dictation.operation')
  assert.equal(subject.sent.at(-1).text, '把文件发送给小王')
  assert.equal(
    subject.sent.some(event => event.type === 'dictation.commit.request'),
    false,
  )
})

test('open rewrite gets only the supplied draft and instruction', async () => {
  const calls = []
  const subject = harness({
    rewriteText: async (draft, instruction) => {
      calls.push({ draft, instruction })
      return 'short draft'
    },
  })
  await start(subject)
  await subject.callbacks().onFinal('make it shorter')
  const request = subject.sent.at(-1)
  await subject.session.handle({
    type: 'dictation.context',
    sessionId: 'dictation-1',
    seq: 2,
    requestId: request.requestId,
    text: 'a very long draft',
    selectionStart: 17,
    selectionEnd: 17,
    revision: 3,
  })
  assert.deepEqual(calls, [{
    draft: 'a very long draft',
    instruction: 'make it shorter',
  }])
  assert.equal(subject.sent.at(-1).kind, 'rewrite')
  assert.equal(subject.sent.at(-1).text, 'short draft')
})

test('cancel clears pending work and closes the provider without a commit', async () => {
  const subject = harness()
  await start(subject)
  await subject.callbacks().onFinal('private uncommitted draft')
  await subject.session.handle({
    type: 'dictation.cancel',
    sessionId: 'dictation-1',
    seq: 2,
  })
  assert.deepEqual(subject.calls.at(-1), ['close', { finish: false }])
  assert.equal(subject.sent.at(-1).state, 'cancelled')
  assert.equal(
    subject.sent.some(event => event.type === 'dictation.commit.request'),
    false,
  )
})

test('provider failure is visible and never invokes a fallback', async () => {
  const subject = harness()
  await start(subject)
  subject.callbacks().onError(new Error('provider unavailable'))
  assert.equal(subject.sent.at(-2).type, 'dictation.error')
  assert.equal(subject.sent.at(-2).code, 'provider_error')
  assert.equal(subject.sent.at(-1).state, 'error')
  assert.deepEqual(subject.calls.at(-1), ['close', { finish: false }])
})

test('commit receipts distinguish first delivery, replay, and conflicting payloads', () => {
  const registry = new CommitRegistry()
  assert.equal(registry.accept({
    commitId: 'commit-1',
    revision: 2,
    payloadHash: 'hash-a',
  }).status, 'first')
  assert.equal(registry.accept({
    commitId: 'commit-1',
    revision: 2,
    payloadHash: 'hash-a',
  }).status, 'replay')
  assert.equal(registry.accept({
    commitId: 'commit-1',
    revision: 3,
    payloadHash: 'hash-b',
  }).status, 'conflict')
})
