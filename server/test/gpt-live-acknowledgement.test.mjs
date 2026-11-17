import assert from 'node:assert/strict'
import test from 'node:test'
import { RealtimeFrontend } from '../src/voice/realtime-provider.mjs'
import { gptLiveProvider } from '../src/voice/providers/gpt-live.mjs'

const flush = () => new Promise(resolve => setImmediate(resolve))

function harness(t) {
  const sent = [], events = [], settled = []
  const frontend = new RealtimeFrontend({
    provider: gptLiveProvider,
    onEvent: event => events.push(event),
    onResponseSettled: event => settled.push(event),
  })
  frontend.ready = true
  frontend.send = payload => sent.push(payload)
  t.after(() => frontend.close())
  return { frontend, sent, events, settled }
}

test('GPT-Live correlates concurrent identical context writes by their own item IDs', async t => {
  const { frontend, sent } = harness(t)
  const item = gptLiveProvider.protocol.userTextItem('same context')
  const first = frontend.createConversationItem(item)
  const second = frontend.createConversationItem(item)
  first.catch(() => {})
  second.catch(() => {})
  await flush()

  assert.equal(sent.length, 2, 'the second write must not wait for the first receipt')
  const [firstItem, secondItem] = sent.map(event => event.item)
  assert.notEqual(firstItem.id, secondItem.id)
  assert.equal(frontend.conversationItemWaiters.size, 2)

  frontend.handleProviderEvent({
    type: 'conversation.item.added',
    item: { ...firstItem, id: 'msg_unrelated' },
  })
  assert.equal(frontend.conversationItemWaiters.size, 2)

  frontend.handleProviderEvent({ type: 'conversation.item.added', item: secondItem })
  assert.equal((await second).id, secondItem.id)
  assert.equal(frontend.conversationItemWaiters.has(firstItem.id), true)
  frontend.handleProviderEvent({ type: 'conversation.item.added', item: firstItem })
  assert.equal((await first).id, firstItem.id)
  assert.equal(frontend.conversationItemWaiters.size, 0)
  assert.ok(sent.every(event => event.type === 'conversation.item.create'))
})

test('GPT-Live waits for the matching tool receipt without treating it as response completion', async t => {
  const { frontend, sent, events, settled } = harness(t)
  const outcome = frontend.sendFunctionOutput('call_result', { result: 'done' })
  await flush()
  assert.deepEqual(sent.map(event => event.type), ['conversation.item.create'])
  const item = sent[0].item

  frontend.handleProviderEvent({
    type: 'conversation.item.added',
    item: { ...item, id: 'fco_unrelated' },
  })
  await flush()
  assert.equal(frontend.conversationItemWaiters.has(item.id), true)
  assert.equal(sent.length, 1, 'matching content/call_id alone must not acknowledge another item')

  frontend.handleProviderEvent({ type: 'conversation.item.added', item })
  await flush()
  assert.equal(frontend.conversationItemWaiters.size, 0)
  assert.deepEqual(sent.map(event => event.type), [
    'conversation.item.create', 'response.create',
  ])
  assert.equal(settled.length, 0)
  assert.equal(frontend.activeResponses.size, 0)
  assert.equal(events.some(event => event.type === 'response.done'
    || event.type === 'response.output_audio.done'), false)

  frontend.handleProviderEvent({
    type: 'response.created',
    response: {
      id: 'resp_result',
      metadata: { qwen_audio_request_id: frontend.pendingResponses[0].requestId },
    },
  })
  frontend.handleProviderEvent({ type: 'conversation.item.done', item })
  assert.equal(frontend.activeResponses.has('resp_result'), true)
  assert.equal(settled.length, 0, 'finalizing a conversation item does not finish its response')

  frontend.handleProviderEvent({
    type: 'response.done',
    response: { id: 'resp_result', status: 'completed' },
  })
  assert.equal((await outcome).completed, true)
  assert.equal(settled.length, 1)
})
