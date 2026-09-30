import assert from 'node:assert/strict'
import test from 'node:test'
import { RealtimePresentationRuntime } from '../src/voice/realtime-presentation-runtime.mjs'
import { RealtimeTurnState } from '../src/voice/realtime-turn-state.mjs'

function harness({
  nonVoiceClient = false,
  turnCitations = null,
  terminalToolResponses = [],
  resultSummaryResponses = [],
  perResponseInstructions = false,
  concurrentVoicePlayback = false,
  transcriptTrailsAudio = false,
} = {}) {
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
    capabilities: { perResponseInstructions, concurrentVoicePlayback, transcriptTrailsAudio },
    ensureResponse: async (...args) => calls.push(['ensureResponse', ...args]),
  }
  const terminalResponses = new Set(terminalToolResponses)
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
      requiresToolResultSummary: id => resultSummaryResponses.includes(id),
      consumeTerminalToolResponse: id => {
        calls.push(['consumeTerminalToolResponse', id])
        return terminalResponses.delete(id)
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
    clearResponseWatchdog: () => calls.push(['clearResponseWatchdog']),
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

test('does not persist a model-generated Gateway protocol envelope', () => {
  const setup = harness()
  const content = [
    '<permission_request>',
    'task_id=fake',
    '</permission_request>',
  ].join(' ')

  deliver(setup.runtime, {
    type: 'response.text.done',
    response_id: 'response-fake-protocol',
    text: content,
    __voiceContext: {
      origin: 'model',
      turnId: 'turn-1',
      turnGeneration: 1,
    },
  })

  assert.equal(setup.records.length, 0)
  assert.equal(
    setup.events.some(event => (
      event.type === 'transcript.final' && event.content === content
    )),
    true,
  )
})

test('allows only one protocol correction per user turn, including repeated invalid corrections', () => {
  const setup = harness({ perResponseInstructions: true })
  const invalidResponse = id => {
    const context = setup.turns.committed()
    deliver(setup.runtime, {
      type: 'response.text.done', response_id: id,
      text: '<permission_request>fake</permission_request>', __voiceContext: context,
    })
    deliver(setup.runtime, { type: 'response.done', response: { id, status: 'completed' } })
  }
  const first = setup.turns.beginVoice('input-1').context
  setup.turns.endSpeech()
  setup.turns.commit(first)
  invalidResponse('response-1')
  invalidResponse('response-2')
  invalidResponse('response-3')
  const corrections = () => setup.calls.filter(([name]) => name === 'ensureResponse')
  assert.equal(corrections().length, 1)
  assert.equal(corrections()[0][2].shouldCreate(), true)
  const second = setup.turns.beginVoice('input-2').context
  setup.turns.endSpeech()
  setup.turns.commit(second)
  assert.equal(corrections()[0][2].shouldCreate(), false)
  invalidResponse('response-4')
  assert.equal(corrections().length, 2)
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

test('a voice-only reply of a full-duplex frontend keeps the pending-permission fallback armed', () => {
  const clears = setup => setup.calls.filter(([name]) => name.startsWith('clearResponse'))
  const fullDuplex = harness({ concurrentVoicePlayback: true })
  const candidate = fullDuplex.turns.beginVoice('item-1').context
  fullDuplex.turns.endSpeech()
  fullDuplex.setResponseTurnCandidate(candidate)
  fullDuplex.runtime.begin({ type: 'response.created', response: { id: 'say-1' }, __voicePlayback: true })
  assert.deepEqual(fullDuplex.turns.committed(), candidate)
  assert.deepEqual(clears(fullDuplex), [['clearResponseWatchdog']])
  // The backend taking the turn settles the candidate as before.
  fullDuplex.runtime.begin({ type: 'response.created', response: { id: 'resp-1' } })
  assert.deepEqual(clears(fullDuplex).at(-1), ['clearResponseCandidate'])
  // Without the capability the marker means nothing.
  const halfDuplex = harness()
  const turn = halfDuplex.turns.beginVoice('item-1').context
  halfDuplex.turns.endSpeech()
  halfDuplex.setResponseTurnCandidate(turn)
  halfDuplex.runtime.begin({ type: 'response.created', response: { id: 'say-1' }, __voicePlayback: true })
  assert.deepEqual(clears(halfDuplex), [['clearResponseCandidate']])
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

test('keeps processing while a foreground tool result is pending', () => {
  const { runtime, events } = harness()

  deliver(runtime, {
    type: 'response.created',
    response: { id: 'response-1' },
    __voiceContext: { turnId: 'turn-1', turnGeneration: 1 },
  })
  runtime.markFunctionCall('response-1')
  deliver(runtime, {
    type: 'response.done',
    response: { id: 'response-1', status: 'completed' },
  })

  assert.deepEqual(
    events.filter(event => event.type === 'voice.state').map(event => event.state),
    ['processing'],
  )
})

test('returns to idle after a terminal tool response', () => {
  const { runtime, events } = harness({
    terminalToolResponses: ['response-1'],
  })

  deliver(runtime, {
    type: 'response.created',
    response: { id: 'response-1' },
    __voiceContext: { turnId: 'turn-1', turnGeneration: 1 },
  })
  runtime.markFunctionCall('response-1')
  deliver(runtime, {
    type: 'response.done',
    response: { id: 'response-1', status: 'completed' },
  })

  assert.deepEqual(
    events.filter(event => event.type === 'voice.state').map(event => event.state),
    ['processing', 'idle'],
  )
})

test('releases a spoken function-call turn when its tool follow-up is suppressed', () => {
  const { runtime, events, calls } = harness()

  deliver(runtime, {
    type: 'response.audio.delta',
    response_id: 'response-1',
    delta: 'audio',
    __voiceContext: { turnId: 'turn-1', turnGeneration: 1 },
  })
  runtime.markFunctionCall('response-1')
  runtime.startPlayback('response-1')
  deliver(runtime, {
    type: 'response.done',
    response: { id: 'response-1', status: 'completed' },
  })
  runtime.finishPlayback('response-1')

  assert.equal(events.at(-1).type, 'voice.state')
  assert.equal(events.at(-1).state, 'idle')
  assert.deepEqual(
    calls.find(([name]) => name === 'finishToolResponse'),
    ['finishToolResponse', 'response-1', {
      suppressResponse: false,
      sourceHasSpeech: true,
    }],
  )
  assert.deepEqual(
    calls.find(([name]) => name === 'responseDone'),
    ['responseDone', {
      turnId: 'turn-1',
      origin: 'model',
      hasAudio: true,
      awaitsToolFollowUp: false,
      suppressed: false,
      failed: false,
    }],
  )
})

test('keeps a spoken inline-tool turn open until its results can be summarized', () => {
  const { runtime, calls } = harness({ resultSummaryResponses: ['response-1'] })
  deliver(runtime, {
    type: 'response.audio.delta',
    response_id: 'response-1',
    delta: 'audio',
    __voiceContext: { turnId: 'turn-1', turnGeneration: 1 },
  })
  runtime.markFunctionCall('response-1')
  deliver(runtime, {
    type: 'response.done',
    response: { id: 'response-1', status: 'completed' },
  })

  assert.deepEqual(calls.find(([name]) => name === 'finishToolResponse'), [
    'finishToolResponse', 'response-1', { suppressResponse: false, sourceHasSpeech: true },
  ])
  assert.equal(calls.find(([name]) => name === 'responseDone')[1].awaitsToolFollowUp, true)
})

for (const status of ['failed', 'cancelled', 'incomplete']) {
  test(`suppresses even an inline result summary when the source response is ${status}`, () => {
    const { runtime, calls } = harness({ resultSummaryResponses: ['response-1'] })
    deliver(runtime, {
      type: 'response.created',
      response: { id: 'response-1' },
      __voiceContext: { turnId: 'turn-1', turnGeneration: 1 },
    })
    runtime.markFunctionCall('response-1')
    deliver(runtime, { type: 'response.done', response: { id: 'response-1', status } })
    assert.deepEqual(calls.find(([name]) => name === 'finishToolResponse'), [
      'finishToolResponse', 'response-1', { suppressResponse: true, sourceHasSpeech: false },
    ])
    assert.equal(calls.find(([name]) => name === 'responseDone')[1].awaitsToolFollowUp, false)
  })
}

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

test('a full-duplex frontend confirms an announcement when its response completes', () => {
  // The voice layer speaks Gateway-origin responses on its own stream under a
  // separate playback id, so no audio ever arrives under the announcement's id.
  const announce = runtime => {
    runtime.begin({
      type: 'response.created',
      response: { id: 'response-1' },
      __voiceOrigin: 'announcement',
      __voiceContext: { turnId: 'turn-1', turnGeneration: 1, taskIds: ['work-1'] },
    })
    deliver(runtime, {
      type: 'response.done',
      response_id: 'response-1',
      response: { id: 'response-1', status: 'completed' },
    })
  }
  const fullDuplex = harness({ concurrentVoicePlayback: true })
  announce(fullDuplex.runtime)
  assert.deepEqual(fullDuplex.calls.find(([name]) => name === 'confirmMany'), ['confirmMany', ['work-1']])
  assert.equal(fullDuplex.calls.some(([name]) => name === 'retryMany'), false)
  // A half-duplex voice client still waits for the announcement's own audio.
  const halfDuplex = harness()
  announce(halfDuplex.runtime)
  assert.deepEqual(halfDuplex.calls.find(([name]) => name === 'retryMany'), ['retryMany', ['work-1']])
  assert.equal(halfDuplex.calls.some(([name]) => name === 'confirmMany'), false)
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

test('a trailing transcript keeps filling an interrupted answer and closes its caption', () => {
  const play = runtime => {
    deliver(runtime, { type: 'response.output_audio.delta', response_id: 'response-1', delta: 'audio' })
    runtime.startPlayback('response-1')
    deliver(runtime, { type: 'response.output_audio_transcript.delta', response_id: 'response-1', delta: '今天' })
    runtime.cancelPlayback('response-1', { reason: 'user_interruption' })
    deliver(runtime, { type: 'response.output_audio_transcript.delta', response_id: 'response-1', delta: '晴。' })
    deliver(runtime, { type: 'response.output_audio_transcript.done', response_id: 'response-1', transcript: '今天晴。' })
  }
  const captions = events => events
    .filter(event => event.role === 'assistant' && ['transcript.delta', 'transcript.final'].includes(event.type))
    .map(event => [event.type, event.content])
  // The transcript trails the audio: what arrives after the cut was played.
  const trailing = harness({ transcriptTrailsAudio: true })
  play(trailing.runtime)
  assert.deepEqual(captions(trailing.events), [
    ['transcript.delta', '今天'],
    ['transcript.delta', '晴。'],
    ['transcript.final', '今天晴。'],
  ])
  assert.equal(trailing.records.length, 0, 'an interrupted answer is still not recorded')
  // A transcript that leads its audio, as on GA, describes words never played.
  const leading = harness()
  play(leading.runtime)
  assert.deepEqual(captions(leading.events), [['transcript.delta', '今天']])
  // Only a caption the user cut into keeps filling: not one cancelled for
  // another reason, and not one that had not started showing yet.
  const otherReason = harness({ transcriptTrailsAudio: true })
  deliver(otherReason.runtime, { type: 'response.output_audio.delta', response_id: 'response-1', delta: 'audio' })
  otherReason.runtime.startPlayback('response-1')
  deliver(otherReason.runtime, { type: 'response.output_audio_transcript.delta', response_id: 'response-1', delta: '今天' })
  otherReason.runtime.cancelPlayback('response-1', { reason: 'playback_error' })
  deliver(otherReason.runtime, { type: 'response.output_audio_transcript.delta', response_id: 'response-1', delta: '晴。' })
  deliver(otherReason.runtime, { type: 'response.output_audio_transcript.done', response_id: 'response-1', transcript: '今天晴。' })
  assert.deepEqual(captions(otherReason.events), [['transcript.delta', '今天']])
  const unshown = harness({ transcriptTrailsAudio: true })
  deliver(unshown.runtime, { type: 'response.output_audio.delta', response_id: 'response-1', delta: 'audio' })
  unshown.runtime.startPlayback('response-1')
  unshown.runtime.cancelPlayback('response-1', { reason: 'user_interruption' })
  deliver(unshown.runtime, { type: 'response.output_audio_transcript.delta', response_id: 'response-1', delta: '好的' })
  deliver(unshown.runtime, { type: 'response.output_audio_transcript.done', response_id: 'response-1', transcript: '好的' })
  assert.deepEqual(captions(unshown.events), [], 'no bubble existed to mark interrupted')
  assert.equal(unshown.records.length, 0)
})
