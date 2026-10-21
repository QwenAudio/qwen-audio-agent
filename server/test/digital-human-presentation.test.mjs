import assert from 'node:assert/strict'
import test from 'node:test'
import { RealtimePresentationRuntime } from '../src/voice/realtime-presentation-runtime.mjs'
import { RealtimeTurnState } from '../src/voice/realtime-turn-state.mjs'

function fakeDigitalHuman({ route = 'pass' } = {}) {
  const calls = []
  return {
    calls,
    route,
    responseStart: args => calls.push(['responseStart', args]),
    routeAudio: args => {
      calls.push(['routeAudio', args])
      return { route, flush: null }
    },
    responseFinish: args => calls.push(['responseFinish', args]),
    responseCancel: args => calls.push(['responseCancel', args]),
    playbackEnded: args => calls.push(['playbackEnded', args]),
  }
}

function harness({ digitalHuman = null } = {}) {
  const events = []
  const records = []
  const calls = []
  const turns = new RealtimeTurnState({
    createVoiceTurnId: generation => `voice-${generation}`,
  })
  const frontend = {
    ready: true,
    provider: { outputSampleRate: 24000 },
    capabilities: { perResponseInstructions: false },
    ensureResponse: async (...args) => calls.push(['ensureResponse', ...args]),
  }
  const runtime = new RealtimePresentationRuntime({
    ownerId: 'owner-1',
    sessionId: 'session-1',
    turns,
    conversationSync: { record: value => records.push(value) },
    announcementWindow: {
      queueAudio: (...args) => calls.push(['queueAudio', ...args]),
      startPlayback: (...args) => calls.push(['startPlayback', ...args]),
      finishPlayback: (...args) => calls.push(['finishPlayback', ...args]),
      responseDone: (...args) => calls.push(['responseDone', ...args]),
    },
    announcements: {
      confirmMany: ids => calls.push(['confirmMany', ids]),
      retryMany: ids => calls.push(['retryMany', ids]),
      flush: () => calls.push(['flush']),
    },
    toolCalls: {
      requiresToolResultSummary: () => false,
      consumeTerminalToolResponse: () => false,
      finishToolResponse: async (...args) => calls.push(['finishToolResponse', ...args]),
    },
    send: event => events.push(event),
    getFrontend: () => frontend,
    getOutputEnabled: () => true,
    getNonVoiceClient: () => false,
    getResponseTurnCandidate: () => null,
    clearResponseCandidate: () => {},
    announcementQuietMs: 60_000,
    responseContextCleanupMs: 60_000,
    digitalHuman,
  })
  return { runtime, events, records, calls }
}

function deliver(runtime, event) {
  runtime.begin(event)
  runtime.handle(event)
}

function audioDelta(responseId, delta, context) {
  return {
    type: 'response.audio.delta',
    response_id: responseId,
    delta,
    __voiceContext: context,
  }
}

test('leaves the plain audio path untouched when no digital human is wired', () => {
  const { runtime, events } = harness()
  deliver(runtime, audioDelta('response-1', 'audio', {
    turnId: 'turn-1',
    turnGeneration: 1,
  }))
  const deltas = events.filter(event => event.type === 'audio.delta')
  assert.equal(deltas.length, 1)
  assert.equal(deltas[0].audio, 'audio')
})

test('suppresses the plain audio delta when the avatar diverts it', () => {
  const digitalHuman = fakeDigitalHuman({ route: 'divert' })
  const { runtime, events, calls } = harness({ digitalHuman })
  deliver(runtime, audioDelta('response-1', 'audio', {
    turnId: 'turn-1',
    turnGeneration: 1,
  }))
  assert.equal(events.some(event => event.type === 'audio.delta'), false)
  assert.deepEqual(
    digitalHuman.calls.find(([name]) => name === 'responseStart')[1],
    { responseId: 'response-1', turnId: 'turn-1', origin: 'model' },
  )
  assert.deepEqual(
    digitalHuman.calls.find(([name]) => name === 'routeAudio')[1],
    { responseId: 'response-1', delta: 'audio', sampleRate: 24000 },
  )
  // Bookkeeping for playback receipts still happens even while diverted.
  assert.equal(calls.some(([name]) => name === 'queueAudio'), true)
})

test('sends the plain audio delta when the avatar passes it through', () => {
  const digitalHuman = fakeDigitalHuman({ route: 'pass' })
  const { runtime, events } = harness({ digitalHuman })
  deliver(runtime, audioDelta('response-1', 'audio', {
    turnId: 'turn-1',
    turnGeneration: 1,
  }))
  const deltas = events.filter(event => event.type === 'audio.delta')
  assert.equal(deltas.length, 1)
  assert.equal(deltas[0].audio, 'audio')
})

test('replays buffered deltas in order on fallback flush', () => {
  const { runtime, events } = harness()
  runtime.publishAudioDelta('response-1', ['a', 'b', 'c'], 'turn-1')
  assert.deepEqual(
    events.filter(event => event.type === 'audio.delta').map(event => event.audio),
    ['a', 'b', 'c'],
  )
  assert.equal(events.every(event => event.turnId === 'turn-1'), true)
})

test('ignores an empty fallback flush', () => {
  const { runtime, events } = harness()
  runtime.publishAudioDelta('response-1', [], 'turn-1')
  assert.equal(events.length, 0)
})

test('reports model completion with authoritative hadAudio', () => {
  const digitalHuman = fakeDigitalHuman()
  const { runtime } = harness({ digitalHuman })
  deliver(runtime, audioDelta('response-1', 'audio', {
    turnId: 'turn-1',
    turnGeneration: 1,
  }))
  deliver(runtime, {
    type: 'response.done',
    response: { id: 'response-1', status: 'completed' },
  })
  assert.deepEqual(
    digitalHuman.calls.find(([name]) => name === 'responseFinish')[1],
    { responseId: 'response-1', failed: false, hadAudio: true },
  )
})

test('notifies playbackEnded on the client receipt', () => {
  const digitalHuman = fakeDigitalHuman()
  const { runtime } = harness({ digitalHuman })
  deliver(runtime, audioDelta('response-1', 'audio', {
    turnId: 'turn-1',
    turnGeneration: 1,
  }))
  runtime.startPlayback('response-1')
  runtime.finishPlayback('response-1')
  assert.deepEqual(
    digitalHuman.calls.find(([name]) => name === 'playbackEnded')[1],
    { responseId: 'response-1' },
  )
})

test('maps a playback cancel reason onto the avatar cancel', () => {
  const digitalHuman = fakeDigitalHuman()
  const { runtime } = harness({ digitalHuman })
  deliver(runtime, audioDelta('response-1', 'audio', {
    turnId: 'turn-1',
    turnGeneration: 1,
  }))
  runtime.cancelPlayback('response-1', { reason: 'permission_resolved' })
  assert.deepEqual(
    digitalHuman.calls.find(([name]) => name === 'responseCancel')[1],
    { responseId: 'response-1', reason: 'permission_revoked' },
  )
})

test('defaults an unattributed playback cancel to a user interruption', () => {
  const digitalHuman = fakeDigitalHuman()
  const { runtime } = harness({ digitalHuman })
  deliver(runtime, audioDelta('response-1', 'audio', {
    turnId: 'turn-1',
    turnGeneration: 1,
  }))
  runtime.cancelPlayback('response-1', {})
  assert.deepEqual(
    digitalHuman.calls.find(([name]) => name === 'responseCancel')[1],
    { responseId: 'response-1', reason: 'user_interruption' },
  )
})

test('keeps a content-safety discard distinguishable from a provider fault', () => {
  const digitalHuman = fakeDigitalHuman()
  const { runtime } = harness({ digitalHuman })
  deliver(runtime, audioDelta('response-1', 'audio', {
    turnId: 'turn-1',
    turnGeneration: 1,
  }))
  runtime.failResponse(
    { type: 'error', response_id: 'response-1' },
    { reason: 'content_safety' },
  )
  assert.deepEqual(
    digitalHuman.calls.find(([name]) => name === 'responseCancel')[1],
    { responseId: 'response-1', reason: 'content_safety' },
  )
})
