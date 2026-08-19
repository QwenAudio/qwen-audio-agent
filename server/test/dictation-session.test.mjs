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

test('starting is bounded by the same 45 second timeout', async () => {
  const subject = harness()
  subject.session.createTranscriber = () => ({
    start: () => new Promise(() => {}),
    pause: () => subject.calls.push(['pause']),
    close: value => subject.calls.push(['close', value]),
  })

  await start(subject)

  assert.equal(subject.session.state, 'starting')
  assert.equal(subject.timers.at(-1)?.delay, 45_000)
  subject.timers.at(-1).callback()
  assert.equal(subject.session.state, 'paused')
  assert.deepEqual(subject.calls.at(-1), ['pause'])
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
  const listeningTimer = subject.timers.at(-1)
  await subject.callbacks().onFinal('new words')
  const request = subject.sent.at(-1)
  assert.equal(request.type, 'dictation.context.request')
  assert.equal(listeningTimer.cleared, true)
  assert.notEqual(subject.timers.at(-1), listeningTimer)
  assert.equal(subject.timers.at(-1).delay, 45_000)

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

test('one-shot commit closes capture and clears its ready timeout', async () => {
  const subject = harness()
  await start(subject, { continuous: false })
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
    revision: 4,
  })
  const commit = subject.sent.at(-1)

  await subject.session.handle({
    type: 'dictation.commit.ack',
    sessionId: 'dictation-1',
    seq: 3,
    commitId: commit.commitId,
    status: 'submitted',
  })

  assert.equal(subject.session.state, 'paused')
  assert.equal(subject.session.timer, null)
  assert.deepEqual(subject.calls.at(-1), ['close', { finish: true }])
})

test('ready-to-send times out, clears its commit, and rejects a late acknowledgement', async () => {
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
  const readyTimer = subject.timers.at(-1)

  assert.equal(subject.session.state, 'ready-to-send')
  assert.equal(readyTimer.delay, 45_000)
  readyTimer.callback()
  assert.equal(subject.session.state, 'paused')
  const resumeCallsBeforeAck = subject.calls.filter(call => call[0] === 'resume').length

  const accepted = await subject.session.handle({
    type: 'dictation.commit.ack',
    sessionId: 'dictation-1',
    seq: 3,
    commitId: commit.commitId,
    status: 'submitted',
  })
  assert.equal(accepted, false)
  assert.equal(subject.session.state, 'paused')
  assert.equal(
    subject.calls.filter(call => call[0] === 'resume').length,
    resumeCallsBeforeAck,
  )
})

test('stop is terminal for the live transcriber and resume requires a new start', async () => {
  const subject = harness()
  await start(subject)
  await subject.session.handle({
    type: 'dictation.stop',
    sessionId: 'dictation-1',
    seq: 2,
  })
  const resumeCallsBefore = subject.calls.filter(call => call[0] === 'resume').length

  const accepted = await subject.session.handle({
    type: 'dictation.resume',
    sessionId: 'dictation-1',
    seq: 3,
  })

  assert.equal(accepted, false)
  assert.equal(subject.session.state, 'stopped')
  assert.deepEqual(subject.calls.find(call => call[0] === 'close'), [
    'close',
    { finish: true },
  ])
  assert.equal(
    subject.calls.filter(call => call[0] === 'resume').length,
    resumeCallsBefore,
  )
})

test('stop ignores a late provider-start rejection', async () => {
  let rejectStart
  const subject = harness()
  subject.session.createTranscriber = () => ({
    start: () => new Promise((_resolve, reject) => { rejectStart = reject }),
    close: value => subject.calls.push(['close', value]),
  })
  await start(subject)
  await subject.session.handle({
    type: 'dictation.stop',
    sessionId: 'dictation-1',
    seq: 2,
  })

  rejectStart(new Error('late provider rejection'))
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(subject.session.state, 'stopped')
  assert.equal(
    subject.sent.some(event => event.code === 'provider_error'),
    false,
  )
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

test('rewrite configuration failure clears all ephemeral work and capture timeout', async () => {
  const subject = harness()
  await start(subject)
  await subject.callbacks().onFinal('改得更简洁')
  const request = subject.sent.at(-1)

  await subject.session.handle({
    type: 'dictation.context',
    sessionId: 'dictation-1',
    seq: 2,
    requestId: request.requestId,
    text: 'private draft',
    selectionStart: 13,
    selectionEnd: 13,
    revision: 2,
  })

  assert.equal(subject.session.state, 'error')
  assert.equal(subject.session.pendingIntent, null)
  assert.equal(subject.session.pendingContext, null)
  assert.equal(subject.session.pendingOperation, null)
  assert.equal(subject.session.pendingCommit, null)
  assert.equal(subject.session.timer, null)
  assert.deepEqual(subject.calls.at(-1), ['close', { finish: false }])
})

test('cancel remains terminal when an interrupted rewrite rejects late', async () => {
  let rejectRewrite
  const subject = harness({
    rewriteText: () => new Promise((_resolve, reject) => { rejectRewrite = reject }),
  })
  await start(subject)
  await subject.callbacks().onFinal('改得更简洁')
  const request = subject.sent.at(-1)
  const rewrite = subject.session.handle({
    type: 'dictation.context',
    sessionId: 'dictation-1',
    seq: 2,
    requestId: request.requestId,
    text: 'private draft',
    selectionStart: 13,
    selectionEnd: 13,
    revision: 2,
  })
  await subject.session.handle({
    type: 'dictation.cancel',
    sessionId: 'dictation-1',
    seq: 3,
  })

  rejectRewrite(new Error('late rewrite failure'))
  await rewrite

  assert.equal(subject.session.state, 'cancelled')
  assert.equal(
    subject.sent.some(event => event.code === 'rewrite_failed'),
    false,
  )
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
  const sentAfterCancel = subject.sent.length
  subject.session.fail('late_internal_error', 'must remain cancelled')
  assert.equal(subject.session.state, 'cancelled')
  assert.equal(subject.sent.length, sentAfterCancel)
})

test('manual pause discards pending context and rejects a late context response', async () => {
  const subject = harness()
  await start(subject)
  await subject.callbacks().onFinal('发送')
  const request = subject.sent.at(-1)

  await subject.session.handle({
    type: 'dictation.pause',
    sessionId: 'dictation-1',
    seq: 2,
  })
  const sentBeforeLateContext = subject.sent.length
  const accepted = await subject.session.handle({
    type: 'dictation.context',
    sessionId: 'dictation-1',
    seq: 3,
    requestId: request.requestId,
    text: 'private draft',
    selectionStart: 13,
    selectionEnd: 13,
    revision: 7,
  })

  assert.equal(accepted, false)
  assert.equal(subject.session.state, 'paused')
  assert.equal(subject.sent.length, sentBeforeLateContext)
  assert.equal(
    subject.sent.some(event => event.type === 'dictation.commit.request'),
    false,
  )
})

test('timeout pause discards pending operation and rejects its late acknowledgement', async () => {
  const subject = harness()
  await start(subject)
  await subject.callbacks().onFinal('new words')
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
  const operation = subject.sent.at(-1)
  subject.timers.at(-1).callback()
  const resumeCallsBeforeAck = subject.calls.filter(call => call[0] === 'resume').length
  const sentBeforeAck = subject.sent.length

  const accepted = await subject.session.handle({
    type: 'dictation.operation.ack',
    sessionId: 'dictation-1',
    seq: 3,
    operationId: operation.operationId,
    status: 'applied',
    revision: 1,
  })

  assert.equal(accepted, false)
  assert.equal(subject.session.state, 'paused')
  assert.equal(subject.sent.length, sentBeforeAck)
  assert.equal(
    subject.calls.filter(call => call[0] === 'resume').length,
    resumeCallsBeforeAck,
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
