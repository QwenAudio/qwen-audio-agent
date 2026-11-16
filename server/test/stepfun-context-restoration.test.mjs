import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import { WebSocketServer } from 'ws'
import { RealtimeFrontend } from '../src/voice/realtime-provider.mjs'
import { stepfunProvider } from '../src/voice/providers/stepfun.mjs'

// Real local WebSocket handshake; no cloud credentials or model calls.
for (const mode of ['no-history', 'text', 'transcript', 'restore-error']) {
  test(`StepFun handshake: ${mode}`, async t => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await once(server, 'listening')
    const sent = [], events = [], errors = []
    t.after(async () => {
      for (const client of server.clients) client.terminate()
      await new Promise(resolve => server.close(resolve))
    })
    server.on('connection', ws => {
      ws.send(JSON.stringify({ type: 'session.created' }))
      ws.on('message', raw => {
        const event = JSON.parse(raw)
        sent.push(event)
        if (event.type === 'session.update') {
          ws.send(JSON.stringify({ type: 'session.updated' }))
        }
        if (event.type === 'conversation.item.create') {
          if (mode === 'restore-error') {
            ws.send(JSON.stringify({ type: 'error', error: {
              code: 'restore_rejected', message: 'fixture rejected history',
            } }))
          } else {
            const content = mode === 'transcript'
              ? [{ type: 'audio', audio: '', transcript: event.item.content[0].text }]
              : event.item.content
            ws.send(JSON.stringify({ type: 'conversation.item.created', item: {
              ...event.item, id: 'server-assigned-id', content,
            } }))
          }
        }
      })
    })
    const frontend = new RealtimeFrontend({
      provider: {
        ...stepfunProvider,
        url: () => `ws://127.0.0.1:${server.address().port}`,
        headers: () => ({}), isConfigured: () => true,
        connectTimeoutMs: 2000,
      },
      responseStartTimeoutMs: 5000,
      agentContext: { recentMessages: mode === 'no-history' ? [] : [
        { role: 'user', content: '你好' },
      ] },
      onEvent: event => events.push(event),
      onError: error => errors.push(error.message),
    })
    t.after(() => frontend.close())
    if (mode === 'restore-error') {
      await assert.rejects(frontend.connect(), /restore_rejected/)
      assert.equal(frontend.ready, false)
      assert.ok(events.some(event => event.type === 'error' && event.__voiceOrigin === 'restore'))
      assert.deepEqual(errors, [], 'upstream error goes through onEvent, not duplicated through onError')
    } else {
      await frontend.connect()
      assert.equal(frontend.ready, true)
      assert.equal(frontend.conversationItemWaiters.size, 0)
      assert.equal(sent.filter(event => event.type === 'conversation.item.create').length,
        mode === 'no-history' ? 0 : 1)
      assert.equal(sent.some(event => event.type === 'response.create'), false)
    }
  })
}

test('StepFun restoration ignores unrelated receipts before accepting matching transcript', async t => {
  const frontend = new RealtimeFrontend({
    provider: stepfunProvider,
    agentContext: { recentMessages: [{ role: 'user', content: 'earlier conversation' }] },
  })
  t.after(() => frontend.close())
  const sent = []
  frontend.send = event => sent.push(event)
  frontend.handleProviderEvent({ type: 'session.updated' })
  await new Promise(resolve => setImmediate(resolve))
  const original = sent[0].item
  const text = original.content[0].text
  const unrelated = [
    { ...original, type: 'function_call' },
    { ...original, role: 'assistant' },
    { ...original, content: [{ type: 'input_audio', transcript: text }] },
    { ...original, content: [{ type: 'audio', transcript: 'unrelated microphone speech' }] },
    { ...original, content: [{ type: 'audio', transcript: '' }] },
    { ...original, content: [{ type: 'input_text', text: 'different text', transcript: text }] },
  ]
  for (const item of unrelated) {
    frontend.handleProviderEvent({
      type: 'conversation.item.created', item: { ...item, id: 'unrelated-server-id' },
    })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(frontend.ready, false)
    assert.equal(frontend.conversationItemWaiters.size, 1)
  }
  frontend.handleProviderEvent({
    type: 'conversation.item.created',
    item: {
      ...original, id: 'matching-server-id',
      content: [{ type: 'audio', audio: '', text: '', transcript: text }],
    },
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(frontend.ready, true)
  assert.equal(frontend.conversationItemWaiters.size, 0)
})
