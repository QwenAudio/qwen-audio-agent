import assert from 'node:assert/strict'
import test from 'node:test'

import {
  confirmTrackedPlaybackStart,
  createPlaybackOutputFollow,
  followDefaultAudioOutput,
} from '../src/realtime/playback-lifecycle.js'

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

class FakeEventTarget {
  constructor() {
    this.listeners = new Map()
  }

  addEventListener(name, listener) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set())
    this.listeners.get(name).add(listener)
  }

  removeEventListener(name, listener) {
    this.listeners.get(name)?.delete(listener)
  }

  emit(name) {
    for (const listener of this.listeners.get(name) || []) listener()
  }
}

function fakeClock() {
  let sequence = 0
  const timers = new Map()
  return {
    schedule(callback, delay) {
      const id = ++sequence
      timers.set(id, { callback, delay, id })
      return id
    },
    cancel(id) {
      timers.delete(id)
    },
    runAll() {
      while (timers.size) {
        const next = [...timers.values()].sort((left, right) => (
          left.delay - right.delay || left.id - right.id
        ))[0]
        timers.delete(next.id)
        next.callback()
      }
    },
    size: () => timers.size,
  }
}

function fakeContext({ setSinkId, state = 'running', sinkId = '' } = {}) {
  const sinks = []
  return {
    state,
    sinkId,
    async setSinkId(value) {
      sinks.push(value)
      if (typeof setSinkId === 'function') await setSinkId(value)
      this.sinkId = typeof value === 'string' ? value : value?.type || ''
    },
    sinks,
  }
}

test('rebinds a live AudioContext to the current default output device', async () => {
  const context = fakeContext()
  assert.equal(await followDefaultAudioOutput(context), true)
  assert.deepEqual(context.sinks, [{ type: 'none' }, ''])
})

test('still applies the default sink when silent AudioSinkOptions are unsupported', async () => {
  const context = fakeContext({
    async setSinkId(value) {
      if (value && typeof value === 'object') {
        throw new TypeError('AudioSinkOptions is not supported')
      }
    },
  })
  assert.equal(await followDefaultAudioOutput(context), true)
  assert.deepEqual(context.sinks, [{ type: 'none' }, ''])
})

test('leaves a closed or sink-less context unchanged', async () => {
  assert.equal(await followDefaultAudioOutput({ state: 'closed', setSinkId: async () => {} }), false)
  assert.equal(await followDefaultAudioOutput({ state: 'running' }), false)
  assert.equal(await followDefaultAudioOutput(null), false)
})

test('restores the previous sink when the default rebind fails', async () => {
  const context = fakeContext({
    sinkId: 'speakers',
    async setSinkId(value) {
      if (value === '') throw new Error('default sink missing')
    },
  })
  assert.equal(await followDefaultAudioOutput(context), false)
  assert.deepEqual(context.sinks, [{ type: 'none' }, '', 'speakers'])
})

test('coalesces device changes and follows the default output without replacing the context', async () => {
  const mediaDevices = new FakeEventTarget()
  const clock = fakeClock()
  const context = fakeContext()
  const follow = createPlaybackOutputFollow({
    mediaDevices,
    getContext: () => context,
    debounceMs: 300,
    schedule: clock.schedule,
    cancel: clock.cancel,
  })

  follow.start()
  follow.start()
  mediaDevices.emit('devicechange')
  mediaDevices.emit('devicechange')
  mediaDevices.emit('devicechange')
  assert.equal(clock.size(), 1)
  clock.runAll()
  await Promise.resolve()
  await Promise.resolve()

  assert.deepEqual(context.sinks, [{ type: 'none' }, ''])
  follow.stop()
  follow.stop()
  mediaDevices.emit('devicechange')
  clock.runAll()
  await Promise.resolve()
  assert.deepEqual(context.sinks, [{ type: 'none' }, ''])
})

test('keeps the context when both the default rebind and restore fail', async () => {
  const context = fakeContext({
    sinkId: 'speakers',
    async setSinkId(value) {
      if (value === '' || value === 'speakers') throw new Error('sink unavailable')
    },
  })
  assert.equal(await followDefaultAudioOutput(context), false)
  assert.deepEqual(context.sinks, [{ type: 'none' }, '', 'speakers'])
})

test('is a no-op without mediaDevices or a context getter', () => {
  const missingDevices = createPlaybackOutputFollow({ getContext: () => null })
  const missingGetter = createPlaybackOutputFollow({ mediaDevices: new FakeEventTarget() })
  missingDevices.start()
  missingDevices.stop()
  missingGetter.start()
  missingGetter.stop()
})

test('swallows a follow rejection so device changes cannot crash playback', async () => {
  const mediaDevices = new FakeEventTarget()
  const clock = fakeClock()
  const follow = createPlaybackOutputFollow({
    mediaDevices,
    getContext: () => ({ state: 'running' }),
    follow: async () => {
      throw new Error('sink failed')
    },
    debounceMs: 0,
    schedule: clock.schedule,
    cancel: clock.cancel,
  })

  follow.start()
  mediaDevices.emit('devicechange')
  clock.runAll()
  await Promise.resolve()
  await Promise.resolve()
  follow.stop()
})
