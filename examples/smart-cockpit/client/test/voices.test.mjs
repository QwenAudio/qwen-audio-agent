import assert from 'node:assert/strict'
import test from 'node:test'
import {
  COCKPIT_VOICE_IDS,
  COCKPIT_VOICES,
  DEFAULT_COCKPIT_VOICE,
} from '../src/config/voices.js'

test('offers only the two supported cockpit Qwen Audio voices', () => {
  assert.deepEqual(COCKPIT_VOICES, [
    { id: 'longanqian', label: '甜美女声' },
    { id: 'longanlufeng', label: '阳光男声' },
  ])
  assert.deepEqual(COCKPIT_VOICE_IDS, ['longanqian', 'longanlufeng'])
  assert.equal(DEFAULT_COCKPIT_VOICE, 'longanqian')
})
