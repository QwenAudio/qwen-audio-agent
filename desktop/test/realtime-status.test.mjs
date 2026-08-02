import assert from 'node:assert/strict'
import test from 'node:test'
import {
  realtimeModelStatusLabel,
  realtimeStatusLabel,
} from '../src/realtime-status.mjs'

test('uses compact realtime provider labels in the desktop status card', () => {
  assert.equal(realtimeStatusLabel('dashscope'), 'Qwen Audio')
  assert.equal(
    realtimeStatusLabel('speech-to-speech'),
    'Speech-to-Speech',
  )
})

test('shortens known Qwen Audio realtime model names', () => {
  assert.equal(
    realtimeModelStatusLabel('qwen-audio-3.0-realtime-plus'),
    'plus',
  )
  assert.equal(
    realtimeModelStatusLabel('qwen-audio-3.0-realtime-flash'),
    'flash',
  )
  assert.equal(realtimeModelStatusLabel('custom-model'), 'custom-model')
})
