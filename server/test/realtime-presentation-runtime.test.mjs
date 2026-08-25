import assert from 'node:assert/strict'
import test from 'node:test'
import { RealtimePresentationRuntime } from '../src/voice/realtime-presentation-runtime.mjs'
import { RealtimeTurnState } from '../src/voice/realtime-turn-state.mjs'

function harness({ nonVoiceClient = false, turnCitations = null } = {}) {
  const events = []
  const records = []
  const calls = []
  const turns = new RealtimeTurnState({
    createVoiceTurnId: generation => `voice-${generation}`,
  })
  let responseTurnCandidate = null
  const frontend = {
    ready: true,
    provider: { outputSampleRate: 24000 },
    capabilities: { perResponseInstructions: false },
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
      consumeTerminalToolResponse: id => {
        calls.push(['consumeTerminalToolResponse', id])
        return false
      },
      finishToolResponse: async (...args) => calls.push([
        'finishToolResponse',
        ...args,
      ]),
    },
    send: event => events.push(event),
    getFrontend: () => frontend,
    getOutputEnabled: () => true,
    getNonVoiceClient: () => nonVoiceClient,
    getResponseTurnCandidate: () => responseTurnCandidate,
    clearResponseCandidate: () => {
      responseTurnCandidate = null
      calls.push(['clearResponseCandidate'])
    },
    announcementQuietMs: 60_000,
    responseContextCleanupMs: 60_000,
    turnCitations,
  })
  return {
    runtime,
    turns,
    events,
    records,
    calls,
    setResponseTurnCandidate(value) {
      responseTurnCandidate = value
    },
  }
}

test('projects turn citations once on the final assistant transcript', () => {
  const stored = [{
    id: 'source_1',
    title: '杭州天气',
    url: 'https://example.com/weather',
  }]
  let consumed = false
  const setup = harness({
    turnCitations: {
      consume(turnId) {
        assert.equal(turnId, 'turn-1')
        if (consumed) return []
        consumed = true
        return stored
      },
    },
  })

  deliver(setup.runtime, {
    type: 'response.text.done',
    response_id: 'response-1',
    text: '今天晴。',
    __voiceContext: { turnId: 'turn-1', turnGeneration: 1 },
  })

  const final = setup.events.find(event => event.type === 'transcript.final')
  assert.deepEqual(final.citations, stored)
  assert.deepEqual(setup.records[0].citations, stored)
})

function deliver(runtime, event) {
  runtime.begin(event)
  runtime.handle(event)
}

test('correlates an implicit provider response with the pending voice turn', () => {
  const setup = harness()
  const candidate = setup.turns.beginVoice('item-1').context
  setup.turns.endSpeech()
  setup.setResponseTurnCandidate(candidate)

  deliver(setup.runtime, {
    type: 'response.audio.delta',
    response_id: 'response-1',
    delta: 'audio',
  })

  assert.deepEqual(setup.turns.committed(), candidate)
  assert.equal(setup.events[0].type, 'response.started')
  assert.equal(setup.events[1].type, 'audio.delta')
  assert.equal(setup.events[1].sampleRate, 24000)
  assert.equal(
    setup.calls.some(([name]) => name === 'clearResponseCandidate'),
    true,
  )
})

test('holds audio transcripts until playback starts and records them once', () => {
  const { runtime, events, records, calls } = harness()
  const context = {
    turnId: 'turn-1',
    turnGeneration: 1,
    taskIds: ['work-1'],
    consumesTaskNotification: true,
  }

  deliver(runtime, {
    type: 'response.audio.delta',
    response_id: 'response-1',
    delta: 'audio',
    __voiceContext: context,
  })
  deliver(runtime, {
    type: 'response.audio_transcript.delta',
    response_id: 'response-1',
    delta: '后台任务',
  })
  deliver(runtime, {
    type: 'response.audio_transcript.done',
    response_id: 'response-1',
    transcript: '后台任务完成了',
  })
  assert.equal(events.some(event => event.type === 'transcript.final'), false)

  runtime.startPlayback('response-1')

  assert.deepEqual(
    events.filter(event => event.type.startsWith('transcript.')).map(event => ({
      type: event.type,
      content: event.content,
    })),
    [
      { type: 'transcript.delta', content: '后台任务' },
      { type: 'transcript.final', content: '后台任务完成了' },
    ],
  )
  assert.equal(records.length, 1)
  assert.equal(records[0].source, 'realtime-direct')
  assert.equal(
    calls.filter(([name]) => name === 'confirmMany').length,
    1,
  )
})

test('retires an audio response only after response, transcript and playback end', () => {
  const { runtime } = harness()

  deliver(runtime, {
    type: 'response.audio.delta',
    response_id: 'response-1',
    delta: 'audio',
    __voiceContext: { turnId: 'turn-1', turnGeneration: 1 },
  })
  runtime.startPlayback('response-1')
  deliver(runtime, {
    type: 'response.audio_transcript.done',
    response_id: 'response-1',
    transcript: '完成',
  })
  deliver(runtime, {
    type: 'response.done',
    response: { id: 'response-1', status: 'completed' },
  })
  assert.equal(runtime.has('response-1'), true)

  runtime.finishPlayback('response-1')

  assert.equal(runtime.has('response-1'), false)
})

test('user interruption confirms an announcement and suppresses late output', () => {
  const { runtime, events, calls } = harness()

  deliver(runtime, {
    type: 'response.audio.delta',
    response_id: 'response-1',
    delta: 'audio',
    __voiceOrigin: 'announcement',
    __voiceContext: {
      turnId: 'turn-1',
      turnGeneration: 1,
      taskIds: ['work-1'],
    },
  })
  runtime.startPlayback('response-1')
  runtime.cancelPlayback('response-1', { reason: 'user_interruption' })
  deliver(runtime, {
    type: 'response.audio_transcript.done',
    response_id: 'response-1',
    transcript: '不应出现',
  })

  assert.equal(
    events.filter(event => event.type === 'transcript.final').length,
    0,
  )
  assert.equal(
    events.filter(event => event.type === 'response.interrupted').length,
    1,
  )
  assert.equal(
    calls.filter(([name]) => name === 'confirmMany').length,
    3,
  )
  assert.equal(calls.some(([name]) => name === 'retryMany'), false)
})

test('a provider failure retries an undelivered announcement', () => {
  const { runtime, calls } = harness()
  runtime.begin({
    type: 'response.created',
    response: { id: 'response-1' },
    __voiceOrigin: 'announcement',
    __voiceContext: {
      turnId: 'turn-1',
      turnGeneration: 1,
      taskIds: ['work-1'],
    },
  })

  runtime.failResponse({ type: 'error', response_id: 'response-1' })

  assert.equal(runtime.has('response-1'), false)
  assert.deepEqual(
    calls.find(([name]) => name === 'retryMany'),
    ['retryMany', ['work-1']],
  )
})
