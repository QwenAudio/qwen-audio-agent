import assert from 'node:assert/strict'
import test from 'node:test'

import { confirmTrackedPlaybackStart } from '../src/playback-lifecycle.js'

function playback() {
  return {
    startTimers: new Map(),
    startedResponses: new Set(),
    sourceCounts: new Map([['response-1', 1]]),
  }
}

test('confirms a tracked response exactly once and clears its timer', () => {
  const state = playback()
  const timer = { id: 'timer-1' }
  const cleared = []
  const started = []
  state.startTimers.set('response-1', timer)

  assert.equal(confirmTrackedPlaybackStart(
    state,
    'response-1',
    id => started.push(id),
    value => cleared.push(value),
  ), true)
  assert.equal(confirmTrackedPlaybackStart(
    state,
    'response-1',
    id => started.push(id),
  ), false)
  assert.deepEqual(started, ['response-1'])
  assert.deepEqual(cleared, [timer])
  assert.equal(state.startTimers.has('response-1'), false)
})

test('does not acknowledge a source removed by interruption', () => {
  const state = playback()
  state.sourceCounts.clear()

  assert.equal(confirmTrackedPlaybackStart(
    state,
    'response-1',
    () => assert.fail('cleared playback must not be acknowledged'),
  ), false)
})
