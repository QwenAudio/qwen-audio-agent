import assert from 'node:assert/strict'
import test from 'node:test'
import { InputAssetRegistry } from '../src/voice/input-asset-registry.mjs'
import { RealtimeInputRuntime } from '../src/voice/realtime-input-runtime.mjs'
import { RealtimeTurnState } from '../src/voice/realtime-turn-state.mjs'
import { TurnTranscripts } from '../src/voice/tools/turn-transcripts.mjs'

function harness({ responseOutcome } = {}) {
  const events = []
  const records = []
  const calls = []
  const frontend = {
    cancel: () => calls.push(['cancel']),
    sendUserInput: async (parts, context) => {
      calls.push(['sendUserInput', parts, context])
      return responseOutcome
    },
  }
  const turns = new RealtimeTurnState({
    createVoiceTurnId: generation => `voice-${generation}`,
  })
  let permissionCandidate = null
  const runtime = new RealtimeInputRuntime({
    ownerId: 'owner-1',
    sessionId: 'session-1',
    turns,
    transcripts: new TurnTranscripts(),
    inputAssets: new InputAssetRegistry(),
    conversationSync: { record: value => records.push(value) },
    announcementWindow: {
      beginTurn: turnId => calls.push(['beginTurn', turnId]),
      endSpeech: () => calls.push(['endSpeech']),
    },
    announcements: {
      dismissActive: () => calls.push(['dismissActive']),
    },
    send: event => events.push(event),
    getFrontend: () => frontend,
    ensureFrontend: async () => {},
    clearResponseCandidate: () => calls.push(['clearResponseCandidate']),
    expectResponseFor: context => {
      permissionCandidate = context
      calls.push(['expectResponseFor', context])
    },
    shouldEnsurePermissionResponse: context => context === permissionCandidate,
    ensurePermissionResponseFor: context => calls.push([
      'ensurePermissionResponseFor',
      context,
    ]),
    reportFrontendError: error => calls.push(['reportFrontendError', error]),
    createInputTurnId: () => 'text-1',
  })
  return { runtime, turns, events, records, calls }
}

test('handles only provider input lifecycle events', () => {
  const { runtime } = harness()

  assert.equal(runtime.handleProviderEvent({ type: 'response.created' }), false)
  assert.equal(runtime.handleProviderEvent({
    type: 'conversation.item.ambient_audio_transcription.completed',
    item_id: 'ambient-1',
  }), true)
})

test('projects one voice turn from speech start through final transcript', () => {
  const { runtime, turns, events, records, calls } = harness()

  runtime.handleProviderEvent({
    type: 'input_audio_buffer.speech_started',
    item_id: 'item-1',
  })
  runtime.handleProviderEvent({
    type: 'conversation.item.input_audio_transcription.delta',
    item_id: 'item-1',
    text: '你',
  })
  runtime.handleProviderEvent({
    type: 'input_audio_buffer.speech_stopped',
    item_id: 'item-1',
  })
  runtime.handleProviderEvent({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'item-1',
    transcript: '你好',
  })

  assert.equal(turns.userSpeaking, false)
  assert.deepEqual(turns.committed(), {
    turnId: 'voice-1',
    turnGeneration: 1,
  })
  assert.deepEqual(events.map(event => event.type), [
    'playback.clear',
    'turn.started',
    'voice.state',
    'transcript.delta',
    'voice.state',
    'transcript.final',
  ])
  assert.equal(records.length, 1)
  assert.equal(records[0].content, '你好')
  assert.equal(records[0].source, 'voice-user')
  assert.equal(
    calls.some(([name]) => name === 'ensurePermissionResponseFor'),
    true,
  )
})

test('keeps consecutive utterances separate when the provider reuses an item id', () => {
  const { runtime, events, records } = harness()
  const utterances = ['梁家辉最近有什么新闻', '我靠，这么牛逼']

  for (const transcript of utterances) {
    runtime.handleProviderEvent({
      type: 'input_audio_buffer.speech_started',
      item_id: 'provider-reused-item',
    })
    runtime.handleProviderEvent({
      type: 'input_audio_buffer.speech_stopped',
      item_id: 'provider-reused-item',
    })
    runtime.handleProviderEvent({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'provider-reused-item',
      transcript,
    })
  }

  const finals = events.filter(event => (
    event.type === 'transcript.final' && event.role === 'user'
  ))
  assert.deepEqual(finals.map(event => [event.turnId, event.content]), [
    ['voice-1', utterances[0]],
    ['voice-2', utterances[1]],
  ])
  assert.deepEqual(records.map(record => record.turnId), ['voice-1', 'voice-2'])
})

test('manual text input supersedes speech and reaches the frontend once', async () => {
  const { runtime, turns, events, records, calls } = harness()
  runtime.handleProviderEvent({
    type: 'input_audio_buffer.speech_started',
    item_id: 'item-voice',
  })
  events.length = 0
  calls.length = 0

  runtime.submit({ text: '看一下这个问题' })
  await Promise.resolve()
  await Promise.resolve()

  assert.deepEqual(turns.committed(), {
    turnId: 'text-1',
    turnGeneration: 2,
  })
  assert.deepEqual(events.map(event => event.type), [
    'playback.clear',
    'transcript.discard',
    'turn.started',
    'voice.state',
    'transcript.final',
  ])
  assert.equal(records.at(-1).source, 'text-user')
  const sent = calls.find(([name]) => name === 'sendUserInput')
  assert.deepEqual(sent[1], [{ type: 'text', text: '看一下这个问题' }])
  assert.deepEqual(sent[2], {
    turnId: 'text-1',
    turnGeneration: 2,
  })
  assert.equal(
    calls.some(([name]) => name === 'expectResponseFor'),
    false,
  )
})

test('invalid manual input fails before changing the current turn', () => {
  const { runtime, turns, events } = harness()

  runtime.submit({ parts: [{ type: 'unknown' }] })

  assert.deepEqual(turns.current(), { turnId: '', turnGeneration: 0 })
  assert.equal(events.length, 1)
  assert.equal(events[0].type, 'error')
  assert.match(events[0].message, /不支持的输入片段类型/)
})

test('reports an explicit text response that never starts without an implicit watchdog', async () => {
  const { runtime, events, calls } = harness({
    responseOutcome: { timedOut: true, phase: 'start' },
  })

  runtime.submit({ text: '你好' })
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(
    calls.some(([name]) => name === 'expectResponseFor'),
    false,
  )
  assert.match(
    calls.find(([name]) => name === 'reportFrontendError')?.[1]?.message || '',
    /没有开始回复/,
  )
  assert.equal(events.at(-1).type, 'voice.state')
  assert.equal(events.at(-1).state, 'idle')
})
