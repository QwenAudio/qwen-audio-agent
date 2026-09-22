import assert from 'node:assert/strict'
import test from 'node:test'
import { RealtimeFrontend, REALTIME_PROVIDERS } from '../src/voice/realtime-provider.mjs'

const flush = () => new Promise(resolve => setImmediate(resolve))

function harness(t, echo = false) {
  const sent = []
  let terminated = 0
  const frontend = new RealtimeFrontend({
    provider: {
      ...REALTIME_PROVIDERS.dashscope,
      capabilities: { ...REALTIME_PROVIDERS.dashscope.capabilities, conversationItemIdEcho: echo },
    },
    responseStartTimeoutMs: 100,
  })
  frontend.ready = true
  frontend.ws = { readyState: 1, send: raw => sent.push(JSON.parse(raw)), terminate() { terminated++ } }
  t.after(() => frontend.resetResponses())
  return {
    frontend, sent, terminated: () => terminated,
    create: text => frontend.createConversationItem(frontend.protocol.userTextItem(text)),
    ack: (index, patch = {}) => frontend.handleLifecycle({
      type: 'conversation.item.created', item: { ...sent[index].item, id: `server-${index}`, ...patch },
    }),
  }
}

test('anonymous receipts serialize concurrent environment, permission and tool-result items', async t => {
  const h = harness(t)
  const first = h.create('camera enabled')
  const second = h.create('permission pending')
  const third = h.frontend.createConversationItem(h.frontend.protocol.functionOutputItem('call-1', { status: 'submitted' }))
  await flush()
  assert.equal(h.sent.length, 1)
  h.ack(0)
  await first
  await flush()
  assert.equal(h.sent.length, 2)
  h.ack(1)
  await second
  await flush()
  assert.equal(h.sent.length, 3)
  h.ack(2)
  await third
  assert.equal(h.frontend.conversationItemWaiters.size, 0)
})

test('automatic conversation items cannot acknowledge a pending context injection', async t => {
  const h = harness(t)
  const result = h.create('camera disabled')
  await flush()
  for (const item of [
    { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'camera disabled' }] },
    { type: 'message', role: 'user', content: [{ type: 'input_audio', transcript: 'camera disabled' }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'other input' }] },
  ]) h.frontend.handleLifecycle({ type: 'conversation.item.created', item: { id: 'automatic', ...item } })
  assert.equal(h.frontend.conversationItemWaiters.size, 1)
  h.ack(0)
  await result
})

test('speech interruption does not cancel a conversation receipt or reconnect an unsent response', async t => {
  const h = harness(t)
  const response = h.frontend.injectPermission({ id: 'auth_1', summary: 'read memory' })
  await flush()
  h.frontend.cancel()
  assert.equal(h.frontend.conversationItemWaiters.size, 1)
  assert.equal(h.frontend.responseSlot.blocked, false)
  const context = h.create('camera disabled')
  h.ack(0)
  await flush()
  // The permission context is durable; its requested reply is separate.
  h.frontend.cancel()
  const nextIndex = h.sent.findIndex(event => event.item?.content?.[0]?.text === 'camera disabled')
  assert.ok(nextIndex >= 0)
  h.ack(nextIndex)
  await context
  assert.equal((await response).cancelled, true)
  assert.equal(h.sent.some(event => event.type === 'response.create'), false)
})

test('anonymous receipt timeout invalidates queued writes and closes the uncertain socket', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = harness(t)
  const first = assert.rejects(h.create('first'), /未确认对话项/)
  const second = assert.rejects(h.create('second'), /会话已重置/)
  await flush()
  t.mock.timers.tick(100)
  await Promise.all([first, second])
  assert.equal(h.sent.length, 1)
  assert.equal(h.terminated(), 1)
  assert.equal(h.frontend.ready, false)
  h.ack(0)
  assert.equal(h.frontend.conversationItemWaiters.size, 0)
})

test('providers echoing IDs still accept concurrent receipts in either order', async t => {
  const h = harness(t, true)
  const first = h.create('first'), second = h.create('second')
  assert.equal(h.sent.length, 2)
  h.ack(1, { id: h.sent[1].item.id })
  await second
  assert.equal(h.frontend.conversationItemWaiters.size, 1)
  h.ack(0, { id: h.sent[0].item.id })
  await first
})

test('an error referring to a different request cannot reject a context receipt', async t => {
  const h = harness(t)
  const result = h.create('context')
  await flush()
  h.frontend.handleLifecycle({ type: 'error', error: { event_id: 'unrelated', message: 'bad audio' } })
  assert.equal(h.frontend.conversationItemWaiters.size, 1)
  h.ack(0)
  await result
})

test('cancelling an unsent tool continuation preserves its receipt without cancelling server inference', async t => {
  const h = harness(t)
  const result = h.frontend.sendFunctionOutput('call-1', { status: 'accepted' })
  await flush()
  h.frontend.cancel()
  assert.equal(h.frontend.responseSlot.blocked, false)
  assert.equal(h.sent.some(event => event.type === 'response.cancel'), false)
  assert.equal(h.frontend.conversationItemWaiters.size, 1)
  h.ack(0)
  assert.equal((await result).cancelled, true)
  assert.equal(h.sent.some(event => event.type === 'response.create'), false)
})

test('reset invalidates both in-flight and queued context items', async t => {
  const h = harness(t)
  const first = assert.rejects(h.create('first'), /会话已重置/)
  const second = assert.rejects(h.create('second'), /会话已重置/)
  await flush()
  h.frontend.resetResponses()
  await Promise.all([first, second])
  assert.equal(h.sent.length, 1)
  const fresh = h.create('fresh')
  await flush()
  h.ack(0)
  assert.equal(h.frontend.conversationItemWaiters.size, 1)
  h.ack(1)
  await fresh
})
