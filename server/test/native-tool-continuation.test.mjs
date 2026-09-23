import assert from 'node:assert/strict'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { WebSocketServer } from 'ws'
import { RealtimeFrontend } from '../src/voice/realtime-provider.mjs'
import { doubaoSeeduplexProvider } from '../src/voice/providers/doubao-seeduplex.mjs'
import { googleLiveProvider } from '../src/voice/providers/google-live.mjs'
import { ToolCallHandler } from '../src/frontend/tools/tool-call-handler.mjs'
import { TurnTranscripts } from '../src/frontend/tools/turn-transcripts.mjs'
import { FrontendMcpClient } from '../src/frontend/tools/mcp/frontend-mcp-client.mjs'
import { normalizeFrontendMcpConfiguration } from '../src/frontend/tools/mcp/frontend-mcp-config.mjs'

async function until(predicate) {
  const deadline = Date.now() + 2000
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'tool-result continuation stalled')
    await delay(5)
  }
}

const success = { content: [{ type: 'text', text: 'Operation succeeded.' }] }
const failure = { isError: true, content: [{ type: 'text', text: 'Operation could not be completed.' }] }

async function harness(t, provider, results) {
  const names = results.map((_, index) => `operation_${index}`)
  const source = new FrontendMcpClient({
    configuration: normalizeFrontendMcpConfiguration({ version: 1, servers: {
      test: { enabled: true, url: 'https://unused.example.test/mcp', tools: Object.fromEntries(names.map(name => [name, { enabled: true }])) },
    } }),
    transportFactory: () => ({}),
    clientFactory: () => ({
      async connect() {}, async close() {},
      async listTools() { return { tools: names.map(name => ({ name, inputSchema: { type: 'object' } })) } },
      async callTool({ name }) {
        const result = results[names.indexOf(name)]
        if (result instanceof Error) throw result
        return result
      },
    }),
  })
  await source.initialize()
  t.after(() => source.close())
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await once(server, 'listening')
  t.after(async () => {
    for (const socket of server.clients) socket.terminate()
    await new Promise(resolve => server.close(resolve))
  })
  const received = []
  const receipts = []
  const events = []
  const errors = []
  const operations = []
  let socket
  let replies = 0
  const send = event => socket.send(JSON.stringify(event))
  server.on('connection', connection => {
    socket = connection
    connection.on('message', raw => {
      const message = JSON.parse(raw.toString())
      received.push(message)
      if (message.setup) send({ setupComplete: {} })
      else if (['session.create', 'session.update'].includes(message.type)) send({ type: 'session.updated', session: {} })
      else {
        const output = provider.key === 'google-live'
          ? message.toolResponse?.functionResponses?.map(item => ({ callId: item.id, result: item.response }))
          : message.items?.filter(item => item.role === 'tool').map(item => ({ callId: item.call_id, result: JSON.parse(item.content[0].text) }))
        if (!output?.length) return
        receipts.push(...output)
        if (receipts.length !== results.length) return
        replies += 1
        // Native services resume after receiving results. In particular Doubao
        // emits response.done only at the END of this interaction, not before
        // the tool result. Do not manufacture an earlier end-of-turn ACK.
        if (provider.key === 'google-live') {
          send({ serverContent: {
            modelTurn: { parts: [{ text: 'Tool outcomes received.' }, { inlineData: { data: 'AAAA', mimeType: 'audio/pcm;rate=24000' } }] },
            turnComplete: true,
          } })
        } else {
          send({ type: 'response.output_text.delta', text: 'Tool outcomes received.' })
          send({ type: 'response.output_audio.delta', audio: Buffer.alloc(8).toString('base64') })
          send({ type: 'response.done' })
        }
      }
    })
  })
  let handler
  const track = promise => operations.push(promise.catch(error => errors.push(error)))
  const frontend = new RealtimeFrontend({
    provider: { ...provider, isConfigured: () => true, headers: () => ({}), url: () => `ws://127.0.0.1:${server.address().port}` },
    responseStartTimeoutMs: 500,
    onError: error => errors.push(error),
    onEvent: event => {
      events.push(event)
      if (event.type === 'response.function_call_arguments.done') {
        track(handler.handle(event, { turnId: 'turn_1', turnGeneration: 1, responseId: event.response_id }))
      } else if (event.type === 'response.done') {
        track(handler.finishToolResponse(event.response.id))
      }
    },
  })
  t.after(() => frontend.close())
  handler = new ToolCallHandler({
    ownerId: 'test', sessionId: 'test', transcripts: new TurnTranscripts(),
    getFrontend: () => frontend, getTurnId: () => 'turn_1', getTurnGeneration: () => 1,
    frontendToolSources: [source],
  })
  await frontend.connect()
  const start = () => {
    const calls = names.map((name, index) => ({ call_id: `call_${index}`, name: `mcp__test__${name}`, arguments: '{}' }))
    send(provider.key === 'google-live'
      ? { toolCall: { functionCalls: calls.map(call => ({ id: call.call_id, name: call.name, args: {} })) } }
      : { type: 'response.function_call_arguments.done', items: calls })
  }
  return { frontend, handler, start, events, errors, operations, received, receipts, replies: () => replies }
}

for (const provider of [doubaoSeeduplexProvider, googleLiveProvider]) {
  for (const [label, results] of [
    ['MCP error result', [failure]],
    ['MCP request rejection', [new Error('transport unavailable')]],
    ['successful result', [success]],
    ['mixed multi-tool results', [failure, success]],
  ]) {
    test(`${provider.key}: ${label} reaches one native spoken continuation through ToolCallHandler`, async t => {
      const h = await harness(t, provider, results)
      h.start()
      await until(() => h.receipts.length === results.length && h.events.some(event => event.type.endsWith('audio.delta')))
      await until(() => h.frontend.activeResponses.size === 0)
      await Promise.all(h.operations)
      assert.deepEqual(h.errors, [])
      assert.equal(h.replies(), 1)
      assert.deepEqual(h.receipts.map(item => item.callId).sort(), results.map((_, index) => `call_${index}`))
      for (let index = 0; index < results.length; index += 1) {
        const output = h.receipts.find(item => item.callId === `call_${index}`).result
        assert.equal(output.error === true, results[index] !== success)
        if (results[index] === failure) assert.equal(output.user_message, failure.content[0].text)
      }
      assert.equal(h.handler.deferredToolResponses.size, 0)
      assert.equal(h.frontend.pendingResponses.length, 0, 'no phantom continuation waiter')
      assert.equal(h.frontend.responseWaiters.size, 0)
      assert.equal(h.received.some(message => message.type === 'response.create'
        || message.type === 'speech_text_buffer.commit'
        || message.realtimeInput?.text
        || message.clientContent?.turnComplete), false, 'no second generation request')
    })
  }
}

test('native results acknowledge delivery without waiting for the active response to end', async t => {
  const frontend = new RealtimeFrontend({ provider: doubaoSeeduplexProvider })
  const sent = []
  frontend.ready = true
  frontend.ws = { readyState: 1, send: data => sent.push(JSON.parse(data)), close() {} }
  t.after(() => frontend.close())
  frontend.handleProviderEvent({ type: 'response.function_call_arguments.done', items: [{ call_id: 'call_1', name: 'lookup', arguments: '{}' }] })
  assert.equal(frontend.activeResponses.size, 1)
  const announcement = frontend.speak('A separate notification')
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(await frontend.sendFunctionOutput('call_1', { error: true }), { delivered: true, automatic: true })
  assert.equal(sent[0].items[0].call_id, 'call_1')
  assert.equal(frontend.activeResponses.size, 1, 'native interaction remains active')
  assert.deepEqual(await frontend.ensureResponse({}, { afterToolResults: true }), { skipped: true, automatic: true })
  assert.equal(frontend.pendingResponses.length, 0)
  frontend.handleProviderEvent({ type: 'response.done' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(sent[1].type, 'speech_text_buffer.commit', 'queued announcement resumes after the native interaction')
  frontend.handleProviderEvent({ type: 'response.done' })
  assert.equal((await announcement).completed, true)
  frontend.close()
  assert.deepEqual(await frontend.sendFunctionOutput('closed_call', { error: true }), { cancelled: true })
})
