import assert from 'node:assert/strict'
import test from 'node:test'
import { RealtimeTurnState } from '../src/voice/realtime-turn-state.mjs'

function state() {
  return new RealtimeTurnState({
    createVoiceTurnId: generation => `voice-${generation}`,
  })
}

test('correlates repeated provider events with one voice turn', () => {
  const turns = state()

  assert.deepEqual(turns.beginVoice('item-1'), {
    accepted: true,
    context: { turnId: 'voice-1', turnGeneration: 1 },
  })
  turns.endSpeech()

  assert.deepEqual(turns.beginVoice('item-1'), {
    accepted: true,
    context: { turnId: 'voice-1', turnGeneration: 1 },
  })
  assert.deepEqual(turns.resolveInput('item-1'), {
    turnId: 'voice-1',
    turnGeneration: 1,
  })
})

test('starts a new turn when a provider reuses a completed input item id', () => {
  const turns = state()

  const first = turns.beginVoice('item-reused').context
  turns.endSpeech()
  turns.completeInput('item-reused')

  const second = turns.beginVoice('item-reused').context
  assert.notEqual(second.turnId, first.turnId)
  assert.deepEqual(second, {
    turnId: 'voice-2',
    turnGeneration: 2,
  })
  assert.deepEqual(turns.resolveInput('item-reused'), second)
})

test('closes the speech-start correlation when transcription uses another id', () => {
  const turns = state()

  turns.beginVoice('provider-speech-id')
  turns.endSpeech()
  turns.completeInput('provider-transcript-id')

  assert.deepEqual(turns.beginVoice('provider-speech-id'), {
    accepted: true,
    context: { turnId: 'voice-2', turnGeneration: 2 },
  })
})

test('manual input supersedes voice and rejects late provider speech', () => {
  const turns = state()
  turns.beginVoice('voice-item')

  assert.deepEqual(turns.beginManual('text-1'), {
    context: { turnId: 'text-1', turnGeneration: 2 },
    supersededVoiceTurn: { turnId: 'voice-1', turnGeneration: 1 },
  })
  assert.equal(turns.isInputInvalid('voice-item'), true)
  assert.deepEqual(turns.beginVoice('late-item'), {
    accepted: false,
    context: null,
  })
  assert.equal(turns.isInputInvalid('late-item'), true)
})

test('committed generations reject stale input without replacing the turn', () => {
  const turns = state()
  const first = turns.beginVoice('item-1').context
  turns.commit(first)
  turns.endSpeech()
  const second = turns.beginVoice('item-2').context
  turns.commit(second)

  assert.equal(turns.isStale(first), true)
  assert.equal(turns.commit(first), false)
  assert.deepEqual(turns.committed(), second)
})

test('manual ownership ends only when its correlated response starts or fails', () => {
  const turns = state()
  const manual = turns.beginManual('text-1').context

  assert.equal(turns.finishManualResponse(manual, { automatic: true }), false)
  assert.equal(turns.manualInputGeneration, manual.turnGeneration)
  assert.equal(turns.finishManualResponse(manual), true)
  assert.equal(turns.manualInputGeneration, null)

  const failed = turns.beginManual('text-2').context
  assert.equal(turns.failManualInput({ turnGeneration: -1 }), false)
  assert.equal(turns.failManualInput(failed), true)
})

test('remembers the user turns committed since the last boundary', () => {
  const turns = state()
  const first = turns.beginManual('turn-one').context
  const second = turns.beginManual('turn-two').context
  const gateway = { turnId: 'gateway-result', turnGeneration: second.turnGeneration }
  const since = context => turns.isUserTurnSinceBoundary(context)
  assert.deepEqual([first, second, gateway].map(since), [true, true, false])
  turns.advanceBoundary()
  assert.deepEqual([first, second].map(since), [false, false])
})

test('only a turn that began after the Gateway first asked a request answers it', () => {
  const turns = state()
  const before = turns.beginManual('typed-before').context.turnId
  assert.equal(turns.beganAfterRequest(before, 'auth-1'), false, 'not asked yet')
  turns.noteRequest('auth-1')
  const after = turns.beginManual('typed-after').context.turnId
  // Asked again, e.g. after a reconnect: the first ask still counts.
  turns.noteRequest('auth-1')
  const later = turns.beginManual('typed-later').context.turnId
  assert.deepEqual([before, after, later].map(turnId => turns.beganAfterRequest(turnId, 'auth-1')), [false, true, true])
})

test('interrupt and close advance the stale-event boundary', () => {
  const turns = state()
  const active = turns.beginVoice('item-1').context

  turns.advanceBoundary()
  assert.equal(turns.isStale(active), true)

  turns.close()
  assert.equal(turns.isInputInvalid('item-1'), false)
  assert.equal(turns.committedTurnGeneration, 3)
})
