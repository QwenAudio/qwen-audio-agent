import assert from 'node:assert/strict'
import test from 'node:test'
import { finalUserTranscript } from '../src/projections/voice-transcript.js'

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
