import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { createPersistentTerminalRenderer } from '../src/index.mjs'

function terminal(options = {}) {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  stdin.isTTY = true
  stdin.setRawMode = () => {}
  stdout.isTTY = true
  stdout.columns = 90
  stdout.rows = 12
  const submitted = []
  const renderer = createPersistentTerminalRenderer({
    stdin,
    stdout,
    onLine: value => submitted.push(value),
    ...options,
  })
  return { renderer, stdin, stdout, submitted }
}

test('applies dictation at the TUI cursor with revision conflict protection', async () => {
  const subject = terminal({ dictationEnabled: true })
  subject.stdin.write('hello')
  subject.stdin.write('\u001b[D\u001b[D')
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(subject.renderer.snapshot(), {
    text: 'hello',
    selectionStart: 3,
    selectionEnd: 3,
    revision: 5,
  })
  assert.deepEqual(subject.renderer.applyOperation({
    kind: 'insert',
    text: 'X',
    baseRevision: 5,
  }), {
    applied: true,
    text: 'helXlo',
    selectionStart: 4,
    selectionEnd: 4,
    revision: 6,
  })
  assert.deepEqual(subject.renderer.applyOperation({
    kind: 'insert',
    text: 'stale',
    baseRevision: 5,
  }), {
    applied: false,
    reason: 'revision_conflict',
    revision: 6,
  })
  assert.equal(subject.renderer.commitDraft(), true)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(subject.submitted, ['helXlo'])
  subject.renderer.close()
})

test('shows and handles application-local dictation shortcuts only when enabled', async () => {
  let toggles = 0
  let cancels = 0
  const enabled = terminal({
    dictationEnabled: true,
    onDictationToggle: () => { toggles += 1 },
    onDictationCancel: () => { cancels += 1 },
  })
  enabled.stdin.write('\u0004')
  enabled.stdin.write('\u001b')
  // readline waits briefly to distinguish a lone Escape from an ANSI sequence.
  await new Promise(resolve => setTimeout(resolve, 550))
  assert.equal(toggles, 1)
  assert.equal(cancels, 1)
  assert.match(enabled.stdout.read().toString(), /Ctrl-D 听写/)
  enabled.renderer.close()

  const disabled = terminal({
    dictationEnabled: false,
    onDictationToggle: () => { toggles += 1 },
  })
  disabled.stdin.write('\u0004')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(toggles, 1)
  assert.doesNotMatch(disabled.stdout.read().toString(), /Ctrl-D 听写/)
  disabled.renderer.close()
})
