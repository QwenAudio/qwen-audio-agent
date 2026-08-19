import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import {
  DICTATION_CAPABILITIES,
  DICTATION_DEFAULT_TIMEOUT_MS,
  DictationClientEvent,
  DictationServerEvent,
  isDictationClientEvent,
  isDictationServerEvent,
} from '../shared/dictation-protocol.mjs'
import {
  applyDraftOperation,
  draftPayloadHash,
  parseDictationIntent,
} from '../shared/dictation-draft.mjs'

test('defines the additive composer dictation protocol surface', () => {
  assert.deepEqual(DICTATION_CAPABILITIES, [
    'dictation.session-v1',
    'dictation.draft-ops-v1',
    'dictation.commit-idempotency-v1',
  ])
  assert.equal(DICTATION_DEFAULT_TIMEOUT_MS, 45_000)
  assert.equal(DictationClientEvent.START, 'dictation.start')
  assert.equal(DictationClientEvent.AUDIO_APPEND, 'dictation.audio.append')
  assert.equal(DictationServerEvent.CONTEXT_REQUEST, 'dictation.context.request')
  assert.equal(DictationServerEvent.COMMIT_REQUEST, 'dictation.commit.request')
  assert.equal(isDictationClientEvent({ type: 'dictation.start' }), true)
  assert.equal(isDictationClientEvent({ type: 'audio.append' }), false)
  assert.equal(isDictationServerEvent({ type: 'dictation.state' }), true)
  assert.equal(isDictationServerEvent({ type: 'voice.state' }), false)
})

test('recognizes only isolated Chinese and English terminal send commands', () => {
  const cases = [
    ['明天见。发送', { kind: 'commit', text: '明天见。', command: '发送' }],
    ['把总结写短一点，提交。', { kind: 'commit', text: '把总结写短一点，', command: '提交' }],
    ['Please send!', { kind: 'commit', text: 'Please', command: 'send' }],
    ['submit', { kind: 'commit', text: '', command: 'submit' }],
    ['把文件发送', { kind: 'insert', text: '把文件发送' }],
    ['把文件发送给小王', { kind: 'insert', text: '把文件发送给小王' }],
    ['请提交给财务审核', { kind: 'insert', text: '请提交给财务审核' }],
    ['please send it to Alice', { kind: 'insert', text: 'please send it to Alice' }],
    ['submit the form tomorrow', { kind: 'insert', text: 'submit the form tomorrow' }],
  ]
  for (const [source, expected] of cases) {
    assert.deepEqual(parseDictationIntent(source), expected, source)
  }
})

test('parses deterministic edits and keeps open rewrites separate', () => {
  assert.deepEqual(parseDictationIntent('把旧标题改成新标题'), {
    kind: 'replace',
    target: '旧标题',
    replacement: '新标题',
  })
  assert.deepEqual(parseDictationIntent('replace old title with new title'), {
    kind: 'replace',
    target: 'old title',
    replacement: 'new title',
  })
  assert.deepEqual(parseDictationIntent('删除多余段落'), {
    kind: 'delete',
    target: '多余段落',
  })
  assert.deepEqual(parseDictationIntent('delete redundant sentence'), {
    kind: 'delete',
    target: 'redundant sentence',
  })
  assert.deepEqual(parseDictationIntent('改得更简洁'), {
    kind: 'rewrite',
    instruction: '改得更简洁',
  })
  assert.deepEqual(parseDictationIntent('make it friendlier'), {
    kind: 'rewrite',
    instruction: 'make it friendlier',
  })
})

test('applies insert replace delete and rewrite only at the matching revision', () => {
  const snapshot = {
    text: 'Hello old title world',
    selectionStart: 6,
    selectionEnd: 15,
    revision: 7,
  }
  assert.deepEqual(applyDraftOperation(snapshot, {
    kind: 'insert',
    text: 'new title',
    baseRevision: 7,
  }), {
    applied: true,
    text: 'Hello new title world',
    selectionStart: 15,
    selectionEnd: 15,
    revision: 8,
  })
  assert.deepEqual(applyDraftOperation(snapshot, {
    kind: 'replace',
    target: 'old title',
    text: 'new title',
    baseRevision: 7,
  }), {
    applied: true,
    text: 'Hello new title world',
    selectionStart: 15,
    selectionEnd: 15,
    revision: 8,
  })
  assert.deepEqual(applyDraftOperation(snapshot, {
    kind: 'delete',
    target: 'old title',
    baseRevision: 7,
  }), {
    applied: true,
    text: 'Hello  world',
    selectionStart: 6,
    selectionEnd: 6,
    revision: 8,
  })
  assert.deepEqual(applyDraftOperation(snapshot, {
    kind: 'rewrite',
    text: 'Rewritten',
    baseRevision: 7,
  }), {
    applied: true,
    text: 'Rewritten',
    selectionStart: 9,
    selectionEnd: 9,
    revision: 8,
  })
  assert.deepEqual(applyDraftOperation(snapshot, {
    kind: 'insert',
    text: 'stale',
    baseRevision: 6,
  }), {
    applied: false,
    reason: 'revision_conflict',
    revision: 7,
  })
})

test('rejects a deterministic edit whose target is absent', () => {
  assert.deepEqual(applyDraftOperation({
    text: 'unchanged',
    selectionStart: 9,
    selectionEnd: 9,
    revision: 2,
  }, {
    kind: 'delete',
    target: 'missing',
    baseRevision: 2,
  }), {
    applied: false,
    reason: 'target_not_found',
    revision: 2,
  })
})

test('hashes the exact committed payload deterministically', () => {
  for (const value of ['', 'hello', '你好🙂']) {
    assert.equal(
      draftPayloadHash(value),
      createHash('sha256').update(value).digest('hex'),
    )
  }
  assert.notEqual(draftPayloadHash('hello'), draftPayloadHash('hello '))
})
