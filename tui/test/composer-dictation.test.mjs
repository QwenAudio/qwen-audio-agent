import assert from 'node:assert/strict'
import test from 'node:test'

import { TuiComposerDictation } from '../src/composer-dictation.mjs'
import { textFingerprint } from '../../shared/dictation-contract.mjs'

test('disabled and ownership-busy TUI never starts dictation', () => {
  const sent = []
  const disabled = new TuiComposerDictation({ enabled: false, send: event => sent.push(event) })
  assert.equal(disabled.start('draft'), false)
  const busy = new TuiComposerDictation({ enabled: true, canStart: () => false, send: event => sent.push(event) })
  assert.equal(busy.start('draft'), false)
  assert.deepEqual(sent, [])
})

test('partial is separate, final locks, and keyboard settles before editing', () => {
  const views = []
  const sent = []
  const client = new TuiComposerDictation({
    enabled: true, canStart: () => true,
    send: event => { sent.push(event); return true },
    onView: view => views.push(view), setCapture: () => {},
  })
  client.start('a')
  client.handle({ type: 'dictation.partial', text: 'b', revision: 0, seq: 1 })
  assert.equal(client.view().text, 'a')
  assert.equal(client.view().partial, 'b')
  assert.equal(client.settleForKeyboard(), 'ab')
  client.keyboard('ab!')
  assert.equal(client.view().text, 'ab!')
  assert.equal(sent.at(-1).type, 'dictation.context')
})

test('voice commit awaits the ordinary TUI submit exactly once', async () => {
  const submissions = []
  const sent = []
  const client = new TuiComposerDictation({
    enabled: true, canStart: () => true,
    send: event => { sent.push(event); return true },
    submit: async text => { submissions.push(text); return true },
    setCapture: () => {},
  })
  client.start('hello')
  const request = {
    type: 'dictation.commit.request', commitId: 'one', revision: 0,
    fingerprint: textFingerprint('hello'),
  }
  assert.equal(await client.handle(request), true)
  assert.equal(await client.handle(request), false)
  assert.deepEqual(submissions, ['hello'])
  assert.equal(sent.filter(event => event.type === 'dictation.commit.ack').length, 1)
})

test('suspend and error stop capture and refuse late commits', async () => {
  for (const event of [
    { type: 'input.suspend', owner: 'host' },
    { type: 'dictation.state', state: 'error', message: 'failed' },
  ]) {
    const captures = []
    let submissions = 0
    const client = new TuiComposerDictation({
      enabled: true, canStart: () => true, send: () => true,
      submit: async () => { submissions += 1; return true },
      setCapture: active => captures.push(active),
    })
    client.start('draft')
    await client.handle(event)
    await client.handle({
      type: 'dictation.commit.request', commitId: 'late', revision: 0,
      fingerprint: textFingerprint('draft'),
    })
    assert.equal(submissions, 0)
    assert.equal(captures.at(-1), false)
  }
})
