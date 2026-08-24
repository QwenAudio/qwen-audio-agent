import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ComposerDictationClient,
  enqueueDictationEvent,
} from '../src/composer-dictation.js'
import {
  dictationStateLabel,
  textFingerprint,
} from '../../shared/dictation-contract.mjs'

function harness({ enabled = true, canStart = () => true, submit = () => true } = {}) {
  const sent = []
  const views = []
  const routes = []
  const client = new ComposerDictationClient({
    enabled,
    canStart,
    send: event => { sent.push(event); return true },
    submit,
    onView: view => views.push(view),
    setCapture: (active, options) => routes.push({ active, options }),
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

test('Web event queue preserves every event in one React batch', () => {
  const first = { id: 1, event: { type: 'dictation.commit.request' } }
  const second = { id: 2, event: { type: 'dictation.state', state: 'stopped' } }
  const queued = enqueueDictationEvent(enqueueDictationEvent([], first), second)
  assert.deepEqual(queued, [first, second])
})

test('dictation state labels are localized instead of exposing protocol tokens', () => {
  assert.equal(dictationStateLabel('ready-to-send'), '待发送')
  assert.equal(dictationStateLabel('transcribing'), '转写中')
})

test('mute, ownership, or suspension gate prevents Web dictation start', () => {
  const h = harness({ canStart: () => false })
  assert.equal(h.client.start('draft'), false)
  assert.deepEqual(h.sent, [])
  assert.deepEqual(h.routes, [])
})

test('shortcut starts capture and renders partial separately before final locks it', () => {
  const h = harness()
  assert.equal(h.client.shortcut({ ctrlKey: true, shiftKey: true, key: 'd' }, 'draft'), true)
  assert.equal(h.sent[0].type, 'dictation.start')
  assert.deepEqual(h.routes, [{ active: true, options: undefined }])
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
  h.client.keyboard('a!')
  assert.equal(h.client.view().text, 'ab!')
  assert.equal(h.sent.at(-1).type, 'dictation.context')
  assert.deepEqual(h.sent.at(-1).range, { start: 1, end: 2 })
})

function editedDictation({ initial = 'typed ', spoken = 'spoken', edited }) {
  const h = harness()
  h.client.start(initial)
  h.client.handle({
    type: 'dictation.final', text: spoken, revision: 0, seq: 1,
  })
  h.client.keyboard(edited)
  assert.equal(h.client.view().text, edited)
  return h.sent.at(-1).range
}

test('keyboard insertion before dictation shifts the recent range', () => {
  assert.deepEqual(editedDictation({
    initial: 'typed prefix ',
    edited: 'typed inserted prefix spoken',
  }), { start: 22, end: 28 })
})

test('keyboard deletion before dictation shifts the recent range', () => {
  assert.deepEqual(editedDictation({
    initial: 'remove prefix ',
    edited: 'prefix spoken',
  }), { start: 7, end: 13 })
})

test('keyboard insertion inside dictation clears the unreliable range', () => {
  assert.equal(editedDictation({ edited: 'typed spXoken' }), null)
})

test('keyboard clearing the composer clears the recent range', () => {
  assert.equal(editedDictation({ edited: '' }), null)
})

test('Memory-only correction acknowledges without ordinary composer submission', () => {
  const submissions = []
  const h = harness({ submit: text => { submissions.push(text); return true } })
  h.client.start('纠正长期事实：上海改为杭州。')
  const request = {
    type: 'dictation.commit.request',
    intent: 'memory-correction',
    commitId: 'memory-1',
    revision: 0,
    fingerprint: textFingerprint('纠正长期事实：上海改为杭州。'),
  }
  assert.equal(h.client.handle(request), true)
  assert.deepEqual(submissions, [])
  assert.deepEqual(h.sent.at(-1), {
    type: 'dictation.commit.ack',
    commitId: 'memory-1',
    revision: 0,
    fingerprint: request.fingerprint,
    submitted: false,
    accepted: true,
    intent: 'memory-correction',
  })
})

test('edit miss is a non-blocking notice instead of an error', () => {
  const h = harness()
  h.client.start('draft')
  h.client.handle({
    type: 'dictation.state', state: 'listening',
    notice: '编辑目标不存在；已保留为普通草稿',
  })
  assert.equal(h.client.view().error, '')
  assert.match(h.client.view().notice, /已保留/)
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
    if (event.type !== 'dictation.commit.request') {
      assert.equal(h.routes.at(-1).active, false)
    }
  }
})

test('manual and voice commits both restart only in continuous mode', () => {
  const h = harness()
  h.client.start('draft', { continuous: true })
  h.client.manualCommitted()
  assert.equal(h.sent.at(-1).type, 'dictation.reset')
  assert.equal(h.client.active, true)
  assert.equal(h.routes.length, 1)

  const stopped = harness()
  stopped.client.start('draft', { continuous: false })
  stopped.client.manualCommitted()
  assert.equal(stopped.sent.at(-1).type, 'dictation.stop')
  assert.deepEqual(stopped.routes, [
    { active: true, options: undefined },
    { active: false, options: { restore: true } },
  ])
})

test('cancel and provider error release dictation capture without latching main audio off', () => {
  for (const event of [
    { type: 'dictation.state', state: 'cancelled' },
    { type: 'dictation.state', state: 'error', message: 'failed' },
  ]) {
    const h = harness()
    h.client.start('draft')
    h.client.handle(event)
    assert.deepEqual(h.routes.at(-1), {
      active: false,
      options: { restore: true },
    })
  }
})
