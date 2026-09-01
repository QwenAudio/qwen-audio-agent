import assert from 'node:assert/strict'
import test from 'node:test'
import {
  finalUserTranscript,
  voiceConversationMessageId,
  voiceEventBelongsToTurn,
} from '../src/projections/voice-transcript.js'

test('shows only normalized final ASR in the debug conversation', () => {
  assert.equal(finalUserTranscript({
    role: 'user',
    delta: true,
    content: '导航到',
  }), '')
  assert.equal(finalUserTranscript({
    role: 'user',
    final: true,
    content: '  导航到\n\n杭州   西湖  ',
  }), '导航到 杭州 西湖')
  assert.equal(finalUserTranscript({
    role: 'assistant',
    final: true,
    content: '好的',
  }), '')
})

test('keeps one assistant message across delta and a late final', () => {
  const delta = {
    role: 'assistant',
    responseId: 'response-1',
    turnId: 'turn-1',
    delta: true,
  }
  const lateFinal = {
    role: 'assistant',
    responseId: 'response-1',
    turnId: 'turn-1',
    final: true,
  }

  assert.equal(
    voiceConversationMessageId(delta, 'fallback-1'),
    'voice:assistant:response-1',
  )
  assert.equal(
    voiceConversationMessageId(lateFinal, 'fallback-2'),
    'voice:assistant:response-1',
  )
  assert.equal(voiceEventBelongsToTurn(lateFinal, 'turn-2'), false)
})

test('uses the protocol turn id to deduplicate final user transcripts', () => {
  assert.equal(voiceConversationMessageId({
    role: 'user',
    turnId: 'turn-2',
    final: true,
  }, 'fallback'), 'voice:user:turn-2')
})
