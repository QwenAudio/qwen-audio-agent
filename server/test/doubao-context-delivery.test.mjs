import assert from 'node:assert/strict'
import test from 'node:test'
import { RealtimeFrontend } from '../src/voice/realtime-provider.mjs'
import { doubaoSeeduplexProvider } from '../src/voice/providers/doubao-seeduplex.mjs'

const tick = () => new Promise(resolve => setImmediate(resolve))

function fixture(t) {
  const sent = []
  const frontend = new RealtimeFrontend({ provider: doubaoSeeduplexProvider })
  frontend.ready = true
  frontend.ws = {
    readyState: 1,
    send: value => sent.push(JSON.parse(value)),
    close() {},
  }
  t.after(() => frontend.close())
  return { frontend, sent }
}

function complete(frontend) {
  for (const event of frontend.protocol.normalizeIncoming({ type: 'response.done' })) {
    frontend.handleLifecycle(event)
  }
}

test('Doubao sends consecutive context-only deliveries without triggering inference', async t => {
  const { frontend, sent } = fixture(t)
  await frontend.appendUserContext('camera is off')
  await frontend.appendUserInputContext([{ type: 'text', text: 'desktop is hidden' }])
  const outcome = await frontend.injectDelivery('work has finished', 'agent', {}, { route: 'context' })
  assert.equal(outcome.contextInjected, true)
  assert.equal(sent.length, 3)
  assert.ok(sent.every(event => event.type === 'conversation.item.create'))
  assert.match(sent[0].items[0].content[0].text, /camera is off/)
  assert.match(sent[1].items[0].content[0].text, /desktop is hidden/)
  assert.match(sent[2].items[0].content[0].text, /work has finished/)

  const reply = frontend.sendUserText('hello')
  await tick()
  assert.equal(sent.length, 4)
  assert.equal(sent[3].type, 'speech_text_buffer.commit')
  assert.equal(sent[3].text, 'hello')
  complete(frontend)
  assert.equal((await reply).completed, true)
})

test('Doubao interactive input parts still trigger exactly one text response', async t => {
  const { frontend, sent } = fixture(t)
  const reply = frontend.sendUserInput([{ type: 'text', text: 'hello from parts' }])
  await tick()
  assert.equal(sent.length, 1)
  assert.equal(sent[0].type, 'speech_text_buffer.commit')
  assert.match(sent[0].text, /hello from parts/)
  complete(frontend)
  assert.equal((await reply).completed, true)
})

test('Doubao preserves permission identity even when its spoken question is skipped', async t => {
  const { frontend, sent } = fixture(t)
  const reply = await frontend.injectPermission({
    id: 'auth_1', taskId: 'task_2', summary: 'read system memory',
  }, {}, { shouldSpeak: () => false })
  assert.equal(reply.skipped, true)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].type, 'conversation.item.create')
  assert.match(sent[0].items[0].content[0].text, /permission_id=auth_1/)
  assert.match(sent[0].items[0].content[0].text, /task_id=task_2/)
})

test('Doubao asynchronous announcement preserves context separately from reply guidance', async t => {
  const { frontend, sent } = fixture(t)
  const reply = frontend.injectDelivery('task_2: 24 GB', 'agent', {}, {
    instructions: 'summarize the result',
  })
  await tick()
  assert.equal(sent.length, 2)
  assert.equal(sent[0].type, 'conversation.item.create')
  assert.equal(sent[0].items[0].content[0].text, 'task_2: 24 GB')
  assert.equal(sent[1].type, 'speech_text_buffer.commit')
  assert.equal(sent[1].text, 'summarize the result')
  complete(frontend)
  assert.equal((await reply).completed, true)
})

test('Doubao tool receipts keep their native automatic continuation without a second commit', async t => {
  const { frontend, sent } = fixture(t)
  const reply = frontend.sendFunctionOutput('call_1', { status: 'accepted' })
  await tick()
  assert.equal(sent.length, 1)
  assert.equal(sent[0].type, 'conversation.item.create')
  assert.equal(sent[0].items[0].role, 'tool')
  assert.equal(sent[0].items[0].call_id, 'call_1')
  complete(frontend)
  assert.deepEqual(await reply, { delivered: true, automatic: true })
})
