import assert from 'node:assert/strict'
import test from 'node:test'
import { createRealtimeVoiceDrafts } from '../src/realtime-voice-settings.mjs'

test('preserves independent Audio and Omni voice drafts across model switches', () => {
  const drafts = createRealtimeVoiceDrafts({
    audioRealtimeVoice: 'audio-one',
    omniRealtimeVoice: 'omni-one',
  })

  assert.deepEqual(drafts.selectModel('qwen-audio-3.0-realtime-plus'), {
    family: 'audio', value: 'audio-one', placeholder: 'longanqian',
  })
  drafts.update('audio-two')
  assert.deepEqual(drafts.selectModel('qwen3.5-omni-plus-realtime'), {
    family: 'omni', value: 'omni-one', placeholder: 'Tina',
  })
  drafts.update('omni-two')
  assert.equal(
    drafts.selectModel('qwen-audio-3.0-realtime-flash').value,
    'audio-two',
  )
  assert.deepEqual(drafts.settings(), {
    audioRealtimeVoice: 'audio-two',
    omniRealtimeVoice: 'omni-two',
  })
})

test('clears an override without persisting the model profile default', () => {
  const drafts = createRealtimeVoiceDrafts({ omniRealtimeVoice: 'custom' })
  drafts.selectModel('qwen3.5-omni-flash-realtime')
  drafts.update('')

  assert.deepEqual(drafts.settings(), {
    audioRealtimeVoice: '',
    omniRealtimeVoice: '',
  })
})
