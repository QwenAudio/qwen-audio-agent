import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ComposerDictation,
  CommitReceipts,
  parseFinalSegment,
} from '../shared/dictation-contract.mjs'

test('partial stays outside the draft and a final locks at the expected revision', () => {
  const model = new ComposerDictation('hello')
  model.partial({ text: ' world', revision: 0, seq: 1 })
  assert.deepEqual(model.snapshot(), {
    text: 'hello', partial: ' world', revision: 0, range: null,
  })
  assert.equal(model.final({ text: ' world', revision: 0, seq: 2 }), true)
  assert.deepEqual(model.snapshot(), {
    text: 'hello world', partial: '', revision: 1, range: { start: 5, end: 11 },
  })
})

test('stale revisions and non-increasing provider sequences fail closed', () => {
  const model = new ComposerDictation('a')
  assert.equal(model.partial({ text: 'b', revision: 1, seq: 1 }), false)
  assert.equal(model.partial({ text: 'b', revision: 0, seq: 2 }), true)
  assert.equal(model.final({ text: 'b', revision: 0, seq: 2 }), false)
  assert.equal(model.snapshot().text, 'a')
})

test('keyboard intervention settles the current partial before its edit', () => {
  const model = new ComposerDictation('one')
  model.partial({ text: ' two', revision: 0, seq: 1 })
  model.keyboardEdit(text => `${text}!`)
  assert.deepEqual(model.snapshot(), {
    text: 'one two!', partial: '', revision: 2, range: { start: 3, end: 7 },
  })
})

test('replace is restricted to one match in the most recent dictated range', () => {
  const model = new ComposerDictation('old ')
  model.final({ text: 'red blue', revision: 0, seq: 1 })
  assert.equal(model.replaceRecent({ from: 'red', to: 'green', revision: 1 }), true)
  assert.equal(model.snapshot().text, 'old green blue')
  assert.equal(model.replaceRecent({ from: 'old', to: 'new', revision: 2 }), false)

  const ambiguous = new ComposerDictation('')
  ambiguous.final({ text: 'red red', revision: 0, seq: 1 })
  assert.equal(ambiguous.replaceRecent({ from: 'red', to: 'blue', revision: 1 }), false)
})

test('recent-range operations reject a replayed provider sequence', () => {
  const model = new ComposerDictation('')
  model.final({ text: 'red', revision: 0, seq: 1 })
  assert.equal(model.replaceRecent({
    from: 'red', to: 'blue', revision: 1, seq: 2,
  }), true)
  assert.equal(model.replaceRecent({
    from: 'blue', to: 'green', revision: 2, seq: 2,
  }), false)
})

test('send command requires a standalone segment or terminal punctuation boundary', () => {
  assert.deepEqual(parseFinalSegment('send'), { text: '', send: true })
  assert.deepEqual(parseFinalSegment('发送'), { text: '', send: true })
  assert.deepEqual(parseFinalSegment('hello. send'), { text: 'hello.', send: true })
  assert.deepEqual(parseFinalSegment('你好。发送'), { text: '你好。', send: true })
  assert.deepEqual(parseFinalSegment('please send the file'), {
    text: 'please send the file', send: false,
  })
  assert.deepEqual(parseFinalSegment('把文件发送'), { text: '把文件发送', send: false })
})

test('commit receipts deduplicate only within the live registry', () => {
  const receipts = new CommitReceipts(2)
  assert.equal(receipts.accept('a'), true)
  assert.equal(receipts.accept('a'), false)
  assert.equal(receipts.accept('b'), true)
  assert.equal(receipts.accept('c'), true)
  assert.equal(receipts.accept('a'), true)
})
