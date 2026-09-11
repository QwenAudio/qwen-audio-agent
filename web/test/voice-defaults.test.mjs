import assert from 'node:assert/strict'
import test from 'node:test'
import { initialVoiceEnabled } from '../src/voice-defaults.js'

test('desktop orb starts with voice enabled', () => {
  assert.equal(initialVoiceEnabled({ desktopOrbMode: true }), true)
})

test('regular WebUI starts with voice disabled', () => {
  assert.equal(initialVoiceEnabled({ desktopOrbMode: false }), false)
  assert.equal(initialVoiceEnabled(), false)
})

test('mobile starts as a realtime call after pairing', () => {
  assert.equal(initialVoiceEnabled({ clientType: 'mobile' }), true)
})
