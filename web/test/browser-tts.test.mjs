import assert from 'node:assert/strict'
import test from 'node:test'

import { browserTtsSupported, preferredChineseVoice } from '../src/browserTts.js'

test('browserTtsSupported requires both browser speech APIs', () => {
  assert.equal(browserTtsSupported({}), false)
  assert.equal(browserTtsSupported({
    speechSynthesis: {},
    SpeechSynthesisUtterance: function Utterance() {},
  }), true)
})

test('preferredChineseVoice favors local mainland Chinese voice', () => {
  const voices = [
    { name: 'English', lang: 'en-US', localService: true },
    { name: 'Cloud Chinese', lang: 'zh-TW', localService: false },
    { name: 'Local Chinese', lang: 'zh-CN', localService: true },
  ]

  assert.equal(preferredChineseVoice(voices).name, 'Local Chinese')
})
