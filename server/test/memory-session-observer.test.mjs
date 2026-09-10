import assert from 'node:assert/strict'
import test from 'node:test'
import { MemorySessionObserver } from '../src/memory/session-observer.mjs'

const context = { ownerId: 'owner-1', sessionId: 'session-1' }

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
  const messages = [{ role: 'user', content: 'Remember this preference' }]
  const observer = new MemorySessionObserver({
    conversationSync: { frontendContext: args => { assert.deepEqual(args, context); return messages } },
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
    memoryExtractor: { maybeRun: () => { throw new Error('extraction failed') } },
    profileObserver: { maybeRun: async () => { throw new Error('observation failed') } },
    preferencePromoter: { run: () => { promoted = true } },
  })
  await observer.onSessionClosed({ ...context, logger: { warn: code => warnings.push(code) } })
  assert.equal(promoted, true)
  assert.deepEqual(warnings.sort(), ['memory.extract_hook_failed', 'preference.observe_hook_failed'])
})
