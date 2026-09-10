import assert from 'node:assert/strict'
import test from 'node:test'
import { SessionObservers } from '../src/voice/session-observers.mjs'

test('session observers dispatch without waiting and drain outstanding hooks on shutdown', async () => {
  const { promise, resolve } = Promise.withResolvers()
  const calls = []
  const observers = new SessionObservers([
    { onSessionClosed: async context => { await promise; calls.push(context.sessionId) } },
    { onSessionClosed: () => calls.push('second observer') },
  ])
  observers.emit('onSessionClosed', { sessionId: 'session-1' })
  assert.deepEqual(calls, ['second observer'])
  let drained = false
  const closing = observers.drain().then(() => { drained = true })
  await Promise.resolve()
  assert.equal(drained, false)
  resolve()
  await closing
  assert.deepEqual(calls, ['second observer', 'session-1'])
  assert.equal(observers.pending.size, 0)
})

test('failed and absent observer hooks do not prevent other observers from receiving events', async () => {
  const warnings = []
  const calls = []
  const observers = new SessionObservers([
    {},
    { onAudio: () => { throw new Error('sync failure') } },
    { onAudio: async () => { throw new Error('async failure') } },
    { onAudio: context => calls.push(context.event) },
  ])
  const event = { type: 'session_ended' }
  observers.emit('onAudio', {
    event, logger: { warn: (code, details) => warnings.push({ code, ...details }) },
  })
  await observers.drain()
  assert.deepEqual(calls, [event])
  assert.deepEqual(warnings.map(w => w.error).sort(), ['async failure', 'sync failure'])
  assert.ok(warnings.every(w => w.code === 'session_observer.failed' && w.hook === 'onAudio'))
})

test('an empty observer list is a valid lifecycle implementation', async () => {
  const observers = new SessionObservers()
  observers.emit('onAudio', { event: { type: 'speech_started' } })
  observers.emit('onSessionClosed', { sessionId: 'session-1' })
  await observers.drain()
  assert.equal(observers.pending.size, 0)
})
