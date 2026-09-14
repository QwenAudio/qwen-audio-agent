import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import {
  DEFAULT_SSE_KEEP_ALIVE_INTERVAL_MS,
  startSseKeepAlive,
} from '../src/transport/sse-keepalive.mjs'

test('keeps SSE alive with transport comments and cleans up with the response', () => {
  const response = new EventEmitter()
  const writes = []
  let callback = null
  let delay = null
  let cleared = 0
  let unrefed = false
  const timer = { unref: () => { unrefed = true } }
  response.write = value => writes.push(value)
  response.destroyed = false
  response.writableEnded = false

  const stop = startSseKeepAlive(response, {
    setIntervalFn: (handler, interval) => {
      callback = handler
      delay = interval
      return timer
    },
    clearIntervalFn: value => {
      assert.equal(value, timer)
      cleared += 1
    },
  })

  assert.equal(delay, DEFAULT_SSE_KEEP_ALIVE_INTERVAL_MS)
  assert.equal(unrefed, true)
  callback()
  assert.deepEqual(writes, [': keep-alive\n\n'])

  response.emit('close')
  assert.equal(cleared, 1)
  stop()
  assert.equal(cleared, 1)
})

test('stops before writing to an ended SSE response', () => {
  const response = new EventEmitter()
  let callback = null
  let writes = 0
  let cleared = 0
  response.write = () => { writes += 1 }
  response.destroyed = false
  response.writableEnded = true

  startSseKeepAlive(response, {
    intervalMs: 5,
    setIntervalFn: handler => {
      callback = handler
      return { unref() {} }
    },
    clearIntervalFn: () => { cleared += 1 },
  })
  callback()

  assert.equal(writes, 0)
  assert.equal(cleared, 1)
})
