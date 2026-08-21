import assert from 'node:assert/strict'
import test from 'node:test'

import { ComposerDictationClient } from '../src/composer-dictation.js'
import { textFingerprint } from '../../shared/dictation-contract.mjs'

function harness({ enabled = true, submit = () => true } = {}) {
  const sent = []
  const views = []
  const routes = []
  const client = new ComposerDictationClient({
    enabled,
    send: event => { sent.push(event); return true },
    submit,
    onView: view => views.push(view),
    setCapture: active => routes.push(active),
  })
  return { client, sent, views, routes }
}

test('disabled client does not register or send anything', () => {
  const h = harness({ enabled: false })
  assert.equal(h.client.start('draft'), false)
  assert.equal(h.client.shortcut({ ctrlKey: true, shiftKey: true, key: 'd' }), false)
  assert.deepEqual(h.sent, [])
  assert.deepEqual(h.routes, [])
})

test('shortcut starts capture and renders partial separately before final locks it', () => {
  const h = harness()
  assert.equal(h.client.shortcut({ ctrlKey: true, shiftKey: true, key: 'd' }, 'draft'), true)
  assert.equal(h.sent[0].type, 'dictation.start')
  assert.deepEqual(h.routes, [true])
  h.client.handle({ type: 'dictation.partial', text: ' one', revision: 0, seq: 1 })
  assert.equal(h.client.view().text, 'draft')
  assert.equal(h.client.view().partial, ' one')
  h.client.handle({ type: 'dictation.final', text: ' one', revision: 0, seq: 2 })
  assert.equal(h.client.view().text, 'draft one')
  assert.equal(h.client.view().partial, '')
})

test('keyboard editing settles partial and publishes the new revision', () => {
  const h = harness()
  h.client.start('a')
  h.client.handle({ type: 'dictation.partial', text: 'b', revision: 0, seq: 1 })
  h.client.keyboard('ab!')
  assert.equal(h.client.view().text, 'ab!')
  assert.equal(h.sent.at(-1).type, 'dictation.context')
})

test('matching commit calls the existing submit once and a retry is rejected', () => {
  const submissions = []
  const h = harness({ submit: text => { submissions.push(text); return true } })
  h.client.start('hello')
  const request = {
    type: 'dictation.commit.request', commitId: 'commit-1', revision: 0,
    fingerprint: textFingerprint('hello'),
  }
  assert.equal(h.client.handle(request), true)
  assert.equal(h.client.handle(request), false)
  assert.deepEqual(submissions, ['hello'])
  assert.equal(h.sent.filter(event => event.type === 'dictation.commit.ack').length, 1)
})

test('stale commit, suspend, cancel, and error never submit or restore capture', () => {
  for (const event of [
    { type: 'dictation.commit.request', commitId: 'x', revision: 9, fingerprint: 'bad' },
    { type: 'input.suspend', owner: 'host' },
    { type: 'dictation.state', state: 'cancelled' },
    { type: 'dictation.state', state: 'error', message: 'failed' },
  ]) {
    let submits = 0
    const h = harness({ submit: () => { submits += 1; return true } })
    h.client.start('draft')
    h.client.handle(event)
    assert.equal(submits, 0)
    if (event.type !== 'dictation.commit.request') assert.equal(h.routes.at(-1), false)
  }
})

test('manual and voice commits both restart only in continuous mode', () => {
  const h = harness()
  h.client.start('draft', { continuous: true })
  h.client.manualCommitted()
  assert.deepEqual(h.sent.slice(-2).map(event => event.type), [
    'dictation.stop', 'dictation.start',
  ])

  const stopped = harness()
  stopped.client.start('draft', { continuous: false })
  stopped.client.manualCommitted()
  assert.equal(stopped.sent.at(-1).type, 'dictation.stop')
  assert.deepEqual(stopped.routes, [true, false])
})
