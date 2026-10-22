import assert from 'node:assert/strict'
import test from 'node:test'
import { TurnTranscripts } from '../src/frontend/tools/turn-transcripts.mjs'
import { AnnouncementWindow } from '../src/voice/announcement/announcement-window.mjs'
import { InputAssetRegistry } from '../src/voice/input-asset-registry.mjs'
import { RealtimeInputRuntime } from '../src/voice/realtime-input-runtime.mjs'
import { RealtimeTurnState } from '../src/voice/realtime-turn-state.mjs'
import { doubaoSeeduplexProvider } from '../src/voice/providers/doubao-seeduplex.mjs'
import {
  createDoubaoSeeduplexProtocol,
  pcmFloat32Base64ToPcm16,
} from '../src/voice/providers/doubao-seeduplex-protocol.mjs'

function float32Base64(samples) {
  const bytes = Buffer.alloc(samples.length * 4)
  samples.forEach((sample, index) => bytes.writeFloatLE(sample, index * 4))
  return bytes.toString('base64')
}

test('Doubao Seeduplex provider builds the documented session shape', () => {
  const session = doubaoSeeduplexProvider.buildSession({
    agentContext: {},
    sessionOptions: { voice: 'test-voice' },
  })

  assert.equal(session.model, '1.2.6.1')
  assert.equal(session.audio.input.format.type, 'pcm')
  assert.equal(session.audio.input.format.rate, 16000)
  assert.equal(session.audio.output.format.type, 'pcm')
  assert.equal(session.audio.output.format.rate, 24000)
  assert.equal(session.audio.output.voice, 'test-voice')
  assert.ok(session.tools.every(tool => tool.type === 'function' && tool.name))
})

test('Doubao Seeduplex protocol emits session.create and audio append events', () => {
  const protocol = createDoubaoSeeduplexProtocol()
  assert.deepEqual(protocol.connectionMessages({
    session: { model: '1.2.6.1' },
  }), [{
    type: 'session.create',
    session: { model: '1.2.6.1' },
  }])
  assert.deepEqual(protocol.audioAppend('AAAA'), {
    type: 'input_audio_buffer.append',
    audio: 'AAAA',
  })
  assert.deepEqual(protocol.responseCancel(), { type: 'response.cancel' })
  assert.deepEqual(protocol.inputMute(), { type: 'input_audio_mute.commit' })
  assert.deepEqual(protocol.inputUnmute(), { type: 'input_audio_unmute.commit' })
})

test('Doubao Seeduplex protocol normalizes text, audio and completion events', () => {
  const protocol = createDoubaoSeeduplexProtocol()

  const text = protocol.normalizeIncoming({
    type: 'response.output_text.delta',
    text: '你好',
  })
  assert.equal(text[0].type, 'response.created')
  assert.match(text[0].response.id, /^response_/u)
  assert.deepEqual(text[1], {
    type: 'response.text.delta',
    response_id: text[0].response.id,
    delta: '你好',
    text: '你好',
  })

  const audio = protocol.normalizeIncoming({
    type: 'response.output_audio.delta',
    audio: float32Base64([-1, -0.5, 0, 0.5, 1]),
  })
  assert.equal(audio[0].type, 'response.output_audio.delta')
  assert.equal(audio[0].response_id, text[0].response.id)
  assert.equal(audio[0].sampleRate, 24000)
  const pcm = Buffer.from(audio[0].delta, 'base64')
  assert.deepEqual(
    Array.from({ length: 5 }, (_, index) => pcm.readInt16LE(index * 2)),
    [-32768, -16384, 0, 16384, 32767],
  )
})

test('Doubao Seeduplex Float32 PCM conversion rejects partial samples', () => {
  assert.throws(
    () => pcmFloat32Base64ToPcm16(Buffer.alloc(3).toString('base64')),
    /Float32 PCM/,
  )
})

test('Doubao Seeduplex protocol expands function-call item arrays', () => {
  const protocol = createDoubaoSeeduplexProtocol()
  const events = protocol.normalizeIncoming({
    type: 'response.function_call_arguments.done',
    items: [
      { call_id: 'call_1', name: 'get_current_time', arguments: '{"timezone":"Asia/Shanghai"}' },
    ],
  })

  assert.equal(events[0].type, 'response.created')
  assert.deepEqual(events[1], {
    type: 'response.function_call_arguments.done',
    response_id: events[0].response.id,
    call_id: 'call_1',
    name: 'get_current_time',
    arguments: '{"timezone":"Asia/Shanghai"}',
  })

  const done = protocol.normalizeIncoming({ type: 'response.done' })
  assert.deepEqual(done, [{
    type: 'response.done',
    response_id: events[0].response.id,
    response: { id: events[0].response.id, status: 'completed' },
  }])
})

test('Doubao Seeduplex translates ASR transcription events for the Gateway input pipeline', () => {
  const protocol = createDoubaoSeeduplexProtocol()

  const started = protocol.normalizeIncoming({
    type: 'conversation.item.input_audio_transcription.started',
    item_id: 'item_asr_1',
    event_id: 'event_1',
  })
  assert.deepEqual(started, [{
    type: 'input_audio_buffer.speech_started',
    item_id: 'item_asr_1',
    event_id: 'event_1',
  }])

  const delta = protocol.normalizeIncoming({
    type: 'conversation.item.input_audio_transcription.delta',
    item_id: 'item_asr_1',
    delta: '你好',
  })
  assert.equal(delta[0].type, 'conversation.item.input_audio_transcription.delta')
  assert.equal(delta[0].text, '')
  assert.equal(delta[0].stash, '你好')

  const completed = protocol.normalizeIncoming({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'item_asr_1',
    text: '你好世界',
  })
  assert.deepEqual(completed.map(event => event.type), [
    'input_audio_buffer.committed',
    'conversation.item.input_audio_transcription.completed',
  ])
  assert.equal(completed[0].item_id, 'item_asr_1')
  assert.equal(completed[1].item_id, 'item_asr_1')
  assert.equal(completed[1].transcript, '你好世界')
})

test('Doubao Seeduplex reuses the active ASR item id when delta and completed omit it', () => {
  const protocol = createDoubaoSeeduplexProtocol()

  protocol.normalizeIncoming({
    type: 'conversation.item.input_audio_transcription.started',
    item_id: 'item_asr_9',
  })

  const delta = protocol.normalizeIncoming({
    type: 'conversation.item.input_audio_transcription.delta',
    delta: 'partial',
  })
  assert.equal(delta[0].item_id, 'item_asr_9')
  assert.equal(delta[0].stash, 'partial')

  const completed = protocol.normalizeIncoming({
    type: 'conversation.item.input_audio_transcription.completed',
    transcript: 'final text',
  })
  assert.deepEqual(completed.map(event => event.type), [
    'input_audio_buffer.committed',
    'conversation.item.input_audio_transcription.completed',
  ])
  assert.equal(completed[0].item_id, 'item_asr_9')
  assert.equal(completed[1].item_id, 'item_asr_9')
  assert.equal(completed[1].transcript, 'final text')
})

test('Doubao Seeduplex synthesizes a speech_started item id and leaves response events untouched', () => {
  const protocol = createDoubaoSeeduplexProtocol()

  const started = protocol.normalizeIncoming({
    type: 'conversation.item.input_audio_transcription.started',
  })
  assert.equal(started[0].type, 'input_audio_buffer.speech_started')
  assert.match(started[0].item_id, /^item_/u)

  const text = protocol.normalizeIncoming({
    type: 'response.output_text.delta',
    text: 'hi',
  })
  assert.equal(text[0].type, 'response.created')
  assert.equal(text[1].type, 'response.text.delta')
  assert.equal(text[1].delta, 'hi')
})

// The adapter's end boundary, and the regression coverage the review asked for:
// the raw Doubao frames are pushed through `normalizeIncoming()` and then into
// the *real* `RealtimeInputRuntime` / `RealtimeTurnState` / `AnnouncementWindow`
// the Gateway uses. Only the session-level collaborators are stand-ins, shaped
// like the ones in `realtime-input-runtime.test.mjs`.
function inputHarness() {
  const events = []
  const protocol = createDoubaoSeeduplexProtocol()
  const turns = new RealtimeTurnState({
    createVoiceTurnId: generation => `voice-${generation}`,
  })
  const announcementWindow = new AnnouncementWindow()
  const runtime = new RealtimeInputRuntime({
    ownerId: 'owner-1',
    sessionId: 'session-1',
    turns,
    transcripts: new TurnTranscripts(),
    inputAssets: new InputAssetRegistry(),
    conversationSync: { record: () => {} },
    announcementWindow,
    announcements: { dismissActive: () => {} },
    send: event => events.push(event),
    getFrontend: () => ({ cancel: () => {} }),
    ensureFrontend: async () => {},
    clearResponseCandidate: () => {},
    expectResponseFor: () => {},
    shouldEnsurePermissionResponse: () => false,
    ensurePermissionResponseFor: () => {},
    reportFrontendError: error => events.push({
      type: 'error',
      message: error.message,
    }),
    createInputTurnId: () => 'text-1',
  })
  const frame = raw => {
    for (const event of protocol.normalizeIncoming(raw)) {
      runtime.handleProviderEvent(event)
    }
  }
  // The speaking half of the Gateway busy gate (`realtime-session-runtime.mjs`
  // reads `turns.userSpeaking`, and the sleep gate reads it too).
  const speaking = () => turns.userSpeaking || announcementWindow.userSpeaking
  const types = () => events.map(event => event.type)
  const finals = () => events.filter(event => (
    event.type === 'transcript.final' && event.role === 'user'
  ))
  return { protocol, turns, announcementWindow, events, frame, speaking, types, finals }
}

// One spoken turn exactly as the live endpoint frames it: started / delta /
// completed carrying the final text in `text`, with no provider end event.
function utterance(frame, itemId, transcript) {
  frame({
    type: 'conversation.item.input_audio_transcription.started',
    item_id: itemId,
  })
  frame({
    type: 'conversation.item.input_audio_transcription.delta',
    item_id: itemId,
    delta: transcript,
  })
  frame({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: itemId,
    text: transcript,
  })
}

test('Doubao Seeduplex pairs the synthesized speech boundary with its item id', () => {
  const protocol = createDoubaoSeeduplexProtocol()

  const started = protocol.normalizeIncoming({
    type: 'conversation.item.input_audio_transcription.started',
    item_id: 'item_asr_2',
    event_id: 'event_1',
  })
  assert.deepEqual(started, [{
    type: 'input_audio_buffer.speech_started',
    item_id: 'item_asr_2',
    event_id: 'event_1',
  }])

  const completed = protocol.normalizeIncoming({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'item_asr_2',
    event_id: 'event_2',
    text: '你好世界',
  })
  // Start and end boundaries carry the same item id, and the final still
  // reaches the pipeline behind its own end boundary.
  assert.deepEqual(completed.map(event => event.type), [
    'input_audio_buffer.committed',
    'conversation.item.input_audio_transcription.completed',
  ])
  assert.deepEqual(completed.map(event => event.item_id), ['item_asr_2', 'item_asr_2'])
  assert.equal(completed[1].transcript, '你好世界')
  // One utterance, one end boundary: a repeated final does not re-open one.
  assert.deepEqual(
    protocol.normalizeIncoming({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item_asr_2',
      text: '你好世界',
    }).map(event => event.type),
    ['conversation.item.input_audio_transcription.completed'],
  )
})

test('Doubao Seeduplex end boundary leaves another item final transcript-only', () => {
  const protocol = createDoubaoSeeduplexProtocol()

  protocol.normalizeIncoming({
    type: 'conversation.item.input_audio_transcription.started',
    item_id: 'item_new',
  })
  const lateFinal = protocol.normalizeIncoming({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'item_old',
    text: '迟到的旧话',
  })

  assert.deepEqual(lateFinal.map(event => event.type), [
    'conversation.item.input_audio_transcription.completed',
  ])
})

test('Doubao Seeduplex final transcript closes the turn in the real input runtime', () => {
  const { turns, events, frame, speaking, types, finals } = inputHarness()

  frame({
    type: 'conversation.item.input_audio_transcription.started',
    item_id: 'item_asr_3',
  })
  assert.equal(turns.userSpeaking, true, 'the start boundary opens a turn and starts speaking')
  assert.equal(speaking(), true)

  frame({
    type: 'conversation.item.input_audio_transcription.delta',
    item_id: 'item_asr_3',
    delta: '你好',
  })
  frame({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'item_asr_3',
    text: '你好世界',
  })

  assert.equal(turns.userSpeaking, false, 'the final transcript must end speech')
  assert.equal(speaking(), false, 'the speech part of the busy gate must clear')
  // Same Gateway event shape as a provider that sends its own VAD boundary.
  assert.deepEqual(types(), [
    'playback.clear',
    'turn.started',
    'voice.state',
    'transcript.delta',
    'voice.state',
    'transcript.final',
  ])
  assert.deepEqual(finals().map(event => [event.turnId, event.content]), [
    ['voice-1', '你好世界'],
  ])
  assert.deepEqual(turns.committed(), { turnId: 'voice-1', turnGeneration: 1 })
  assert.equal(events.some(event => event.type === 'error'), false)
})

test('Doubao Seeduplex closes and reopens turns across consecutive utterances', () => {
  const { frame, speaking, finals } = inputHarness()

  utterance(frame, 'item_asr_4', '第一句')
  assert.equal(speaking(), false, 'the first turn closes')

  utterance(frame, 'item_asr_5', '第二句')
  assert.equal(speaking(), false, 'the next turn opens and closes the same way')
  assert.deepEqual(finals().map(event => [event.turnId, event.content]), [
    ['voice-1', '第一句'],
    ['voice-2', '第二句'],
  ])
})

test('Doubao Seeduplex reuses the provider item id across utterances', () => {
  const { frame, speaking, finals } = inputHarness()
  const reused = 'item_asr_reused'

  utterance(frame, reused, '第一句')
  assert.equal(speaking(), false)

  // The provider may hand the same item id to the next utterance: that round
  // needs its own end boundary and its own Gateway turn.
  utterance(frame, reused, '第二句')
  assert.equal(speaking(), false, 'the reused id still closes the second turn')
  assert.deepEqual(finals().map(event => [event.turnId, event.content]), [
    ['voice-1', '第一句'],
    ['voice-2', '第二句'],
  ])
})

test('Doubao Seeduplex late final of an older item cannot end the turn speaking now', () => {
  const { frame, speaking, finals } = inputHarness()

  // First utterance opens a turn, then a barge-in opens the next one.
  frame({
    type: 'conversation.item.input_audio_transcription.started',
    item_id: 'item_first',
  })
  frame({
    type: 'conversation.item.input_audio_transcription.started',
    item_id: 'item_second',
  })
  assert.equal(speaking(), true)

  // The first item's final arrives late: it resolves to the older turn, so it
  // must not end the turn that is speaking now.
  frame({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'item_first',
    text: '迟到的旧话',
  })
  assert.equal(speaking(), true, 'a late final must not end the turn speaking now')

  frame({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'item_second',
    text: '当前的话',
  })
  assert.equal(speaking(), false, 'the current turn ends on its own final')
  assert.deepEqual(finals().map(event => [event.turnId, event.content]), [
    ['voice-1', '迟到的旧话'],
    ['voice-2', '当前的话'],
  ])
})
