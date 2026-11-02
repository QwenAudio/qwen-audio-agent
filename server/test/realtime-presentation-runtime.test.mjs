import assert from 'node:assert/strict'
import test from 'node:test'
import { RealtimePresentationRuntime } from '../src/voice/realtime-presentation-runtime.mjs'
import { RealtimeTurnState } from '../src/voice/realtime-turn-state.mjs'
import { AnnouncementWindow } from '../src/voice/announcement/announcement-window.mjs'

function harness({
  nonVoiceClient = false,
  turnCitations = null,
  terminalToolResponses = [],
  resultSummaryResponses = [],
  perResponseInstructions = false,
  playbackReceipts = true,
  announcementWindow = null,
  responseContextCleanupMs = 60_000,
  concurrentVoicePlayback = false,
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
    capabilities: { perResponseInstructions, concurrentVoicePlayback },
    ensureResponse: async (...args) => calls.push(['ensureResponse', ...args]),
  }
  const terminalResponses = new Set(terminalToolResponses)
  const runtime = new RealtimePresentationRuntime({
    ownerId: 'owner-1',
    sessionId: 'session-1',
    turns,
    conversationSync: { record: value => records.push(value) },
    announcementWindow: announcementWindow || {
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
    getPlaybackReceipts: () => playbackReceipts,
    getResponseTurnCandidate: () => responseTurnCandidate,
    clearResponseCandidate: () => {
      responseTurnCandidate = null
      calls.push(['clearResponseCandidate'])
    },
    clearResponseWatchdog: () => calls.push(['clearResponseWatchdog']),
    announcementQuietMs: 60_000,
    responseContextCleanupMs,
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

for (const transcriptFirst of [true, false]) {
  test(`receipt-less audio publishes generated text without claiming playback (transcript first: ${transcriptFirst})`, () => {
    const window = new AnnouncementWindow()
    const h = harness({ playbackReceipts: false, announcementWindow: window })
    h.turns.beginManual('turn-1')
    window.beginTurn('turn-1')
    window.endSpeech()
    deliver(h.runtime, { type: 'response.audio.delta', response_id: 'r', delta: 'AAA=' })
    deliver(h.runtime, { type: 'response.audio_transcript.delta', response_id: 'r', delta: 'hello' })
    const context = h.runtime.get('r')
    assert.equal(context.playbackStarted, false)
    assert.equal(window.audioResponses.size, 0)
    assert.equal(window.isBlocked(), true, 'generation still in progress')
    assert.equal(h.events.find(e => e.type === 'transcript.delta').content, 'hello')
    const done = () => deliver(h.runtime, { type: 'response.done', response: { id: 'r', status: 'completed' } })
    const transcript = () => deliver(h.runtime, { type: 'response.audio_transcript.done', response_id: 'r', transcript: 'hello' })
    if (transcriptFirst) { transcript(); done() } else {
      done()
      assert.equal(window.isBlocked(), false)
      assert.equal(h.runtime.has('r'), true, 'keep the correlation for a late final transcript')
      h.turns.beginManual('turn-2')
      transcript()
    }
    assert.equal(window.isBlocked(), false)
    assert.equal(h.runtime.has('r'), false)
    assert.equal(h.runtime.playbackTurns.size, 0)
    assert.equal(context.playbackEnded, false)
    assert.equal(h.records.length, 1)
    assert.equal(h.records[0].turnId, 'turn-1')
    assert.equal(h.events.findLast(e => e.type === 'voice.state').state, 'idle')
    assert.equal(h.events.some(e => e.state === 'speaking'), false)
    assert.equal(h.calls.some(([name]) => name === 'confirmMany'), false)
  })
}

test('receipt-less generation bounds context retention when the final transcript is absent', async () => {
  const h = harness({ playbackReceipts: false, responseContextCleanupMs: 20 })
  deliver(h.runtime, { type: 'response.audio.delta', response_id: 'r', delta: 'AAA=' })
  deliver(h.runtime, { type: 'response.done', response: { id: 'r', status: 'completed' } })
  deliver(h.runtime, { type: 'response.audio_transcript.delta', response_id: 'r', delta: 'late partial' })
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(h.runtime.has('r'), false)
  assert.equal(h.runtime.playbackTurns.size, 0)
})

test('receipt-less tool continuation waits for its result but never for audio playback', () => {
  const window = new AnnouncementWindow()
  const h = harness({ playbackReceipts: false, announcementWindow: window, resultSummaryResponses: ['r'] })
  h.turns.beginManual('turn-1')
  window.beginTurn('turn-1'); window.endSpeech()
  deliver(h.runtime, { type: 'response.audio.delta', response_id: 'r', delta: 'AAA=' })
  h.runtime.markFunctionCall('r')
  deliver(h.runtime, { type: 'response.done', response: { id: 'r', status: 'completed' } })
  assert.equal(window.isBlocked(), true)
  assert.equal(h.events.findLast(e => e.type === 'voice.state').state, 'processing')
  h.runtime.failToolResponse({ responseId: 'r', turnId: 'turn-1' })
  assert.equal(window.isBlocked(), false)
  assert.equal(h.events.findLast(e => e.type === 'voice.state').state, 'idle')
})

for (const mode of ['clear', 'failed', 'cancelled', 'error']) {
  test(`receipt-less ${mode} suppresses late audio and transcripts`, () => {
    const h = harness({ playbackReceipts: false })
    deliver(h.runtime, { type: 'response.audio.delta', response_id: 'r', delta: 'AAA=' })
    if (mode === 'clear') h.runtime.clearPlayback({ reason: 'user_interruption' })
    if (mode === 'error') h.runtime.failResponse({ type: 'error', response_id: 'r' })
    else deliver(h.runtime, { type: 'response.done', response: { id: 'r', status: mode === 'clear' ? 'completed' : mode } })
    const before = h.events.length
    deliver(h.runtime, { type: 'response.audio.delta', response_id: 'r', delta: 'AAA=' })
    deliver(h.runtime, { type: 'response.audio_transcript.done', response_id: 'r', transcript: 'do not revive' })
    assert.equal(h.events.length, before)
    assert.equal(h.records.length, 0)
    assert.equal(h.runtime.get('r').suppressed, true)
  })
}

test('failed tool follow-up releases processing but still waits for foreground audio', () => {
  const { runtime, turns, calls } = harness({ resultSummaryResponses: ['tool-audio'] })
  turns.beginManual('turn-1')
  deliver(runtime, { type: 'response.audio.delta', response_id: 'tool-audio', delta: 'AAA=' })
  runtime.markFunctionCall('tool-audio')
  deliver(runtime, { type: 'response.done', response: { id: 'tool-audio', status: 'completed' } })
  runtime.failToolResponse({ responseId: 'tool-audio', turnId: 'turn-1' })
  assert.equal(runtime.get('tool-audio').awaitsToolFollowUp, false)
  assert.equal(calls.findLast(call => call[0] === 'responseDone')[1].hasAudio, true)
  runtime.finishPlayback('tool-audio')
  assert.equal(calls.findLast(call => call[0] === 'finishPlayback')[2].awaitsToolFollowUp, false)
})

test('cleared audio ignores late audio and duplicate cancellation receipts', () => {
  const { runtime, turns, calls, events } = harness()
  turns.beginManual('turn-1')
  deliver(runtime, { type: 'response.audio.delta', response_id: 'old-audio', delta: 'AAA=' })
  runtime.clearPlayback({ reason: 'user_interruption' })
  const eventCount = events.length
  const finishCount = calls.filter(call => call[0] === 'finishPlayback').length
  runtime.cancelPlayback('old-audio', { reason: 'user_interruption' })
  runtime.startPlayback('old-audio')
  deliver(runtime, { type: 'response.audio.delta', response_id: 'old-audio', delta: 'AAA=' })
  assert.equal(events.length, eventCount)
  assert.equal(calls.filter(call => call[0] === 'finishPlayback').length, finishCount)
  assert.equal(runtime.get('old-audio').suppressed, true)
})

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
  // Without the capability the marker means nothing.
  for (const concurrentVoicePlayback of [true, false]) {
    const { runtime, turns, calls, setResponseTurnCandidate } = harness({ concurrentVoicePlayback })
    const candidate = turns.beginVoice('item-1').context
    turns.endSpeech()
    setResponseTurnCandidate(candidate)
    runtime.begin({ type: 'response.created', response: { id: 'say-1' }, __voicePlayback: true })
    const clears = () => calls.filter(([name]) => name.startsWith('clearResponse'))
    assert.deepEqual(turns.committed(), candidate)
    assert.deepEqual(clears(), [[concurrentVoicePlayback ? 'clearResponseWatchdog' : 'clearResponseCandidate']])
    // The backend taking the turn settles the candidate as before.
    runtime.begin({ type: 'response.created', response: { id: 'resp-1' } })
    assert.deepEqual(clears().at(-1), ['clearResponseCandidate'])
  }
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
  // A full-duplex voice layer plays it under its own id, so no audio ever arrives under the
  // announcement's; a half-duplex voice client still waits for the announcement's own audio.
  for (const [concurrentVoicePlayback, settled, never] of [[true, 'confirmMany', 'retryMany'], [false, 'retryMany', 'confirmMany']]) {
    const { runtime, calls } = harness({ concurrentVoicePlayback })
    runtime.begin({ type: 'response.created', response: { id: 'response-1' }, __voiceOrigin: 'announcement',
      __voiceContext: { turnId: 'turn-1', turnGeneration: 1, taskIds: ['work-1'] } })
    deliver(runtime, { type: 'response.done', response_id: 'response-1', response: { id: 'response-1', status: 'completed' } })
    assert.deepEqual(calls.find(([name]) => name === settled), [settled, ['work-1']])
    assert.equal(calls.some(([name]) => name === never), false)
  }
  // A due reminder is confirmed the same way.
  const { runtime, calls } = harness({ concurrentVoicePlayback: true })
  runtime.begin({ type: 'response.created', response: { id: 'response-1' }, __voiceOrigin: 'gateway-system-event',
    __voiceContext: { turnId: 'turn-1', turnGeneration: 1, taskIds: ['reminder-1'] } })
  deliver(runtime, { type: 'response.done', response_id: 'response-1', response: { id: 'response-1', status: 'completed' } })
  assert.deepEqual(calls.find(([name]) => name === 'confirmMany'), ['confirmMany', ['reminder-1']])
})

test('a due reminder is confirmed once it plays, or completes for a non-voice client', () => {
  const confirmed = calls => calls.filter(([name]) => name === 'confirmMany')
  const reminder = { __voiceOrigin: 'gateway-system-event', __voiceContext: { turnId: 'turn-1', turnGeneration: 1, taskIds: ['reminder-1'] } }

  const voice = harness()
  deliver(voice.runtime, { type: 'response.audio.delta', response_id: 'response-1', delta: 'audio', ...reminder })
  assert.deepEqual(confirmed(voice.calls), [])
  voice.runtime.startPlayback('response-1')
  assert.deepEqual(confirmed(voice.calls), [['confirmMany', ['reminder-1']]])

  const text = harness({ nonVoiceClient: true })
  text.runtime.begin({ type: 'response.created', response: { id: 'response-1' }, ...reminder })
  deliver(text.runtime, { type: 'response.done', response_id: 'response-1', response: { id: 'response-1', status: 'completed' } })
  assert.deepEqual(confirmed(text.calls), [['confirmMany', ['reminder-1']]])

  // A system event about no task, such as a content rejection, confirms nothing.
  const notice = harness()
  deliver(notice.runtime, { type: 'response.audio.delta', response_id: 'response-1', delta: 'audio',
    __voiceOrigin: 'gateway-system-event', __voiceContext: { turnId: 'turn-1', turnGeneration: 1 } })
  notice.runtime.startPlayback('response-1')
  assert.deepEqual(confirmed(notice.calls), [])
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
