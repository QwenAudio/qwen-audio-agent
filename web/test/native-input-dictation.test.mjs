import assert from 'node:assert/strict'
import test from 'node:test'

import * as nativeDictation from '../src/native-input-dictation.js'

const { NativeInputDictationClient } = nativeDictation

function harness(overrides = {}) {
  const gateway = []
  const native = []
  const capture = []
  const views = []
  const client = new NativeInputDictationClient({
    enabled: true,
    canStart: () => true,
    sendGateway: event => {
      gateway.push(event)
      return true
    },
    sendNative: operation => {
      native.push(operation)
      return Promise.resolve({
        type: 'operation.result',
        operationId: operation.operationId,
        accepted: true,
      })
    },
    setCapture: (active, options) => capture.push({ active, options }),
    onView: view => views.push(view),
    ...overrides,
  })
  return { capture, client, gateway, native, views }
}

test('starts an empty native draft only after ownership/suspend gates pass', async () => {
  const blocked = harness({ canStart: () => false })
  assert.equal(await blocked.client.start(), false)
  assert.deepEqual(blocked.gateway, [])
  assert.deepEqual(blocked.native, [])
  assert.deepEqual(blocked.capture, [])

  const ready = harness()
  assert.equal(await ready.client.start({ continuous: false }), true)
  assert.deepEqual(ready.native.map(item => item.type), ['session.arm'])
  assert.deepEqual(ready.gateway, [{
    type: 'dictation.start',
    text: '',
    revision: 0,
    continuous: false,
  }])
  assert.deepEqual(ready.capture, [{ active: true, options: undefined }])
})

test('fails closed when native arm does not return an accepted correlated result', async () => {
  for (const result of [undefined, {}, { accepted: true }]) {
    const blocked = harness({ sendNative: () => Promise.resolve(result) })
    assert.equal(await blocked.client.start(), false)
    assert.deepEqual(blocked.gateway, [])
    assert.deepEqual(blocked.capture, [])
    assert.equal(blocked.client.view().state, 'error')
  }
})

test('routes partial/final to correlated native operations and never submits conversation', async () => {
  const { client, gateway, native } = harness()
  await client.start()
  assert.equal(client.handle({
    type: 'dictation.partial',
    text: '你好',
    revision: 0,
    seq: 1,
  }), true)
  assert.equal(client.handle({
    type: 'dictation.final',
    text: '你好世界',
    revision: 1,
    seq: 2,
  }), true)
  await client.settled()

  assert.deepEqual(native.slice(1).map(item => ({
    type: item.type,
    text: item.text,
    revision: item.revision,
    seq: item.seq,
    operationId: typeof item.operationId,
  })), [
    {
      type: 'session.partial', text: '你好', revision: 0, seq: 1,
      operationId: 'string',
    },
    {
      type: 'session.final', text: '你好世界', revision: 1, seq: 2,
      operationId: 'string',
    },
  ])
  assert.deepEqual(gateway.map(item => item.type), ['dictation.start'])
})

test('cancel and native failure stop capture, cancel Gateway, and reject late results', async () => {
  let resolvePartial
  const pendingPartial = new Promise(resolve => { resolvePartial = resolve })
  const { capture, client, gateway } = harness({
    sendNative: operation => operation.type === 'session.partial'
      ? pendingPartial
      : Promise.resolve({
          type: 'operation.result',
          operationId: operation.operationId,
          accepted: true,
        }),
  })
  await client.start()
  client.handle({
    type: 'dictation.partial', text: 'secret', revision: 0, seq: 1,
  })
  assert.equal(client.cancel('user_cancelled'), true)
  resolvePartial({
    type: 'operation.result',
    operationId: 'late-result-does-not-match',
    accepted: true,
  })
  await client.settled()

  assert.deepEqual(gateway.map(item => item.type), [
    'dictation.start', 'dictation.cancel',
  ])
  assert.deepEqual(capture.at(-1), {
    active: false,
    options: { restore: true },
  })
  assert.equal(client.view().state, 'cancelled')

  const failed = harness({
    sendNative: operation => Promise.resolve({
      type: 'operation.result',
      operationId: operation.operationId,
      accepted: operation.type === 'session.arm',
      ...(operation.type === 'session.arm' ? {} : { reason: 'target_changed' }),
    }),
  })
  await failed.client.start()
  failed.client.handle({
    type: 'dictation.final', text: 'must not land', revision: 1, seq: 1,
  })
  await failed.client.settled()
  assert.equal(failed.client.view().state, 'error')
  assert.deepEqual(failed.gateway.map(item => item.type), [
    'dictation.start', 'dictation.cancel',
  ])
  assert.equal(failed.capture.at(-1).active, false)
})

test('input.suspend and terminal Gateway states fail closed before late operations', async () => {
  const { client, gateway, native } = harness()
  await client.start()
  assert.equal(client.handle({ type: 'input.suspend' }), true)
  assert.equal(client.handle({
    type: 'dictation.final', text: 'late', revision: 1, seq: 1,
  }), false)
  await client.settled()
  assert.deepEqual(native.map(item => item.type), ['session.arm', 'session.cancel'])
  assert.deepEqual(gateway.map(item => item.type), [
    'dictation.start', 'dictation.cancel',
  ])
  assert.equal(client.view().state, 'error')
})

test('ordered native event consumption handles every unseen event exactly once', () => {
  assert.equal(typeof nativeDictation.consumeNativeInputEvents, 'function')
  const handled = []
  const events = [
    { id: 1, event: { type: 'dictation.partial' } },
    { id: 2, event: { type: 'dictation.final' } },
    { id: 3, event: { type: 'dictation.state', state: 'cancelled' } },
  ]
  let cursor = nativeDictation.consumeNativeInputEvents(
    events,
    0,
    event => handled.push(event.type),
  )
  cursor = nativeDictation.consumeNativeInputEvents(
    events,
    cursor,
    event => handled.push(event.type),
  )
  assert.equal(cursor, 3)
  assert.deepEqual(handled, [
    'dictation.partial', 'dictation.final', 'dictation.state',
  ])
})
