import assert from 'node:assert/strict'
import test from 'node:test'
import { MemorySessionObserver } from '../src/memory/session-observer.mjs'
import { ConversationSync } from '../src/conversation/conversation-sync.mjs'

const context = { ownerId: 'owner-1', sessionId: 'session-1' }

function freshConversation(content = 'Remember this preference') {
  const sync = new ConversationSync()
  sync.record({ ...context, id: 'new-user', role: 'user', content, source: 'voice-user' })
  return sync
}

test('memory observes opted-in audio synchronously with owner and session context', () => {
  const calls = []
  let enabled = false
  const observer = new MemorySessionObserver({
    memoryService: {
      ownsAudioStreamObservation: () => enabled,
      observeAudio: (...args) => calls.push(args),
    },
  })
  const event = { type: 'session_ended' }
  observer.onAudio({ ...context, event })
  assert.deepEqual(calls, [])
  enabled = true
  observer.onAudio({ ...context, event })
  assert.deepEqual(calls, [['owner-1', event, { source: 'voice-input', sessionId: 'session-1' }]])
})

test('provider session observation precedes flush and passes the conversation snapshot', async () => {
  const { promise, resolve } = Promise.withResolvers()
  const calls = []
  const sync = freshConversation()
  sync.record({ ...context, id: 'internal', role: 'assistant', content: 'raw result',
    source: 'agent-result', taskId: 'task-1' })
  sync.record({ ...context, id: 'spoken', role: 'assistant', content: 'spoken summary',
    source: 'agent-presentation', taskId: 'task-1' })
  const messages = sync.frontendContext(context)
  const observer = new MemorySessionObserver({
    conversationSync: sync,
    memoryService: {
      ownsSessionObservation: () => true,
      observe: async (...args) => { calls.push(['observe', ...args]); await promise },
      flush: (...args) => calls.push(['flush', ...args]),
    },
  })
  const closing = observer.onSessionClosed(context)
  assert.deepEqual(calls, [['observe', 'owner-1', { messages }, { source: 'session-close', sessionId: 'session-1' }]])
  resolve()
  await closing
  assert.deepEqual(calls[1], ['flush', 'owner-1', { source: 'session-close', sessionId: 'session-1' }])
})

test('preference promotion waits for observation while extraction runs independently', async () => {
  const { promise, resolve } = Promise.withResolvers()
  const calls = []
  const observer = new MemorySessionObserver({
    conversationSync: freshConversation(),
    memoryExtractor: { maybeRun: args => { assert.deepEqual(args, context); calls.push('extract') } },
    profileObserver: { maybeRun: async () => { calls.push('observe'); await promise } },
    preferencePromoter: { run: args => { assert.deepEqual(args, { ownerId: 'owner-1' }); calls.push('promote') } },
  })
  const closing = observer.onSessionClosed(context)
  assert.deepEqual(calls, ['extract', 'observe'])
  resolve()
  await closing
  assert.deepEqual(calls, ['extract', 'observe', 'promote'])
})

test('failed learning paths are isolated and existing candidates can still be promoted', async () => {
  const warnings = []
  let promoted = false
  const observer = new MemorySessionObserver({
    conversationSync: freshConversation(),
    memoryExtractor: { maybeRun: () => { throw new Error('extraction failed') } },
    profileObserver: { maybeRun: async () => { throw new Error('observation failed') } },
    preferencePromoter: { run: () => { promoted = true } },
  })
  await observer.onSessionClosed({ ...context, logger: { warn: code => warnings.push(code) } })
  assert.equal(promoted, true)
  assert.deepEqual(warnings.sort(), ['memory.extract_hook_failed', 'preference.observe_hook_failed'])
})

test('providers never observe restored history or the same live messages twice', async () => {
  const sync = new ConversationSync()
  sync.restore({ ...context, messages: [{ id: 'old', role: 'user', content: '旧偏好' }] })
  const observations = []
  let flushes = 0
  let promotions = 0
  const observer = new MemorySessionObserver({
    conversationSync: sync,
    memoryService: {
      ownsSessionObservation: () => true,
      observe: async (_owner, exchange) => observations.push(exchange.messages),
      flush: () => { flushes++ },
    },
    preferencePromoter: { run: () => { promotions++ } },
  })
  await observer.onSessionClosed(context)
  assert.deepEqual(observations, [])
  assert.equal(promotions, 0)
  sync.record({ ...context, id: 'new', role: 'user', content: '新的偏好', source: 'voice-user' })
  await observer.onSessionClosed(context)
  await observer.onSessionClosed(context)
  assert.deepEqual(observations.map(messages => messages.map(message => message.content)), [['新的偏好']])
  assert.equal(flushes, 3, 'provider flushing remains independent of transcript replay')
  assert.equal(promotions, 1)
  assert.equal(sync.list(context).length, 2, 'visible history must remain intact')
})

test('an explicit edit invalidates in-flight observation before preference promotion', async () => {
  const sync = freshConversation()
  const { promise, resolve } = Promise.withResolvers()
  let promotions = 0
  const observer = new MemorySessionObserver({
    conversationSync: sync,
    profileObserver: { maybeRun: () => promise },
    preferencePromoter: { run: () => { promotions++ } },
  })
  const pending = observer.onSessionClosed(context)
  sync.discardRecorded(context.ownerId)
  resolve([])
  await pending
  assert.equal(promotions, 0)
  assert.equal(sync.list(context).length, 1)
})
