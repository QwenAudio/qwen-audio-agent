import assert from 'node:assert/strict'
import test from 'node:test'
import {
  appendDictationText,
  applyDictationCommand,
  isDictationShortcut,
  parseDictationCommand,
  speechRecognitionConstructor,
} from '../src/composer/dictation.js'

test('recognizes send commands only as standalone or sentence-final commands', () => {
  assert.deepEqual(parseDictationCommand('发送。'), { type: 'send', body: '' })
  assert.deepEqual(parseDictationCommand('查一下天气。发送'), {
    type: 'send',
    body: '查一下天气',
  })
  assert.equal(parseDictationCommand('把文件发送给小王').type, 'append')
  assert.equal(parseDictationCommand('测试发送').type, 'append')
})

test('applies append, replacement, and delete-last-sentence commands', () => {
  assert.equal(appendDictationText('你好', '世界'), '你好世界')
  assert.deepEqual(applyDictationCommand('周二开会。', '把周二改成周三'), {
    type: 'replace',
    from: '周二',
    to: '周三',
    draft: '周三开会。',
    changed: true,
  })
  assert.equal(
    applyDictationCommand('第一句。第二句。', '删除最后一句').draft,
    '第一句。',
  )
  assert.equal(
    applyDictationCommand('hello', 'change hello to hi').draft,
    'hi',
  )
})

test('adds a sentence-final body before submitting', () => {
  assert.deepEqual(applyDictationCommand('请', '查一下天气。发送'), {
    type: 'send',
    body: '查一下天气',
    draft: '请查一下天气',
    changed: true,
  })
})

test('recognizes the page-scoped dictation shortcut and browser APIs', () => {
  assert.equal(isDictationShortcut({ ctrlKey: true, shiftKey: true, code: 'Space' }), true)
  assert.equal(isDictationShortcut({ ctrlKey: true, shiftKey: false, code: 'Space' }), false)
  const Recognition = function Recognition() {}
  assert.equal(speechRecognitionConstructor({ SpeechRecognition: Recognition }), Recognition)
  assert.equal(speechRecognitionConstructor({}), null)
})
