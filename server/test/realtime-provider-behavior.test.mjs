import assert from 'node:assert/strict'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { WebSocketServer } from 'ws'
import { config } from '../src/core/config.mjs'
import { RealtimeFrontend } from '../src/voice/realtime-provider.mjs'
import { RealtimeProviderSession } from '../src/voice/realtime-provider-session.mjs'
import { defaultRealtimeProviderRegistry } from '../src/voice/providers/registry.mjs'

// Exercise the public runtime against real sockets and each native dialect.
// Only connection configuration is replaced: never contact a cloud endpoint or
// use local credentials. The fake service does not call adapter normalizers.
async function waitFor(predicate) {
  const deadline = Date.now() + 3000
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'provider behavior did not settle')
    await delay(5)
  }
}

async function service(t, key) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await once(server, 'listening')
  const connections = []
  server.on('connection', socket => {
    const peer = {
      socket, messages: [], replies: 0, active: null, autoComplete: true,
      send: event => socket.send(JSON.stringify(event)),
      start(metadata) {
        const id = `response_${++this.replies}`
        this.active = { id, metadata }
        if (key === 'google-live') {
          this.send({ serverContent: { modelTurn: { parts: [{ text: 'reply' }] } } })
        } else if (key === 'doubao-seeduplex') {
          this.send({ type: 'response.output_text.delta', response_id: id, delta: 'reply' })
        } else if (key === 'minicpm-o') {
          this.send({ type: 'response.output.delta', response_id: id, kind: 'text', text: 'reply' })
        } else {
          this.send({ type: 'response.created', response: this.active })
          this.send({ type: 'response.text.delta', response_id: id, delta: 'reply' })
        }
        if (this.autoComplete) this.finish()
      },
      finish(status = 'completed') {
        if (!this.active) return
        const response = { ...this.active, status }
        this.active = null
        if (key === 'google-live') {
          this.send({ serverContent: { turnComplete: true, interrupted: status === 'cancelled' } })
        } else if (status === 'cancelled' && key === 'doubao-seeduplex') {
          this.send({ type: 'response.canceled', response_id: response.id })
        } else if (status === 'cancelled' && key === 'stepfun') {
          this.send({ type: 'response.cancelled', response_id: response.id })
        } else {
          this.send({ type: 'response.done', response })
        }
      },
      toolCall() {
        const call = { call_id: 'call_contract', name: 'lookup', arguments: '{"q":"test"}' }
        if (key === 'google-live') {
          this.send({ toolCall: { functionCalls: [{ id: call.call_id, name: call.name, args: { q: 'test' } }] } })
        } else {
          this.active = { id: `response_${++this.replies}` }
          if (key !== 'doubao-seeduplex') this.send({ type: 'response.created', response: this.active })
          this.send(key === 'doubao-seeduplex'
            ? { type: 'response.function_call_arguments.done', response_id: this.active.id, items: [call] }
            : { type: 'response.function_call_arguments.done', response_id: this.active.id, ...call })
          this.finish()
        }
      },
    }
    connections.push(peer)
    socket.on('message', raw => {
      const message = JSON.parse(raw.toString())
      peer.messages.push(message)
      if (message.setup) peer.send({ setupComplete: {} })
      else if (message.type === 'session.init') peer.send({ type: 'session.created', session_id: 'native' })
      else if (['session.create', 'session.update'].includes(message.type)) {
        // Speech-to-Speech deliberately does not acknowledge session.update.
        if (key !== 'speech-to-speech') peer.send({ type: 'session.updated', session: {} })
      } else if (message.type === 'conversation.item.create') {
        if (key === 'doubao-seeduplex') {
          if (message.items?.some(item => item.role === 'tool')) peer.start()
        } else {
          const item = key === 'stepfun' ? { ...message.item, id: 'server_item' } : message.item
          peer.send({ type: 'conversation.item.created', item })
        }
      } else if (message.type === 'response.create') peer.start(message.response?.metadata)
      else if (message.type === 'speech_text_buffer.commit' || message.realtimeInput?.text || message.toolResponse) peer.start()
      else if (message.type === 'response.cancel') peer.finish('cancelled')
      else if (message.clientContent) {
        // Google's documented clientContent semantics: interrupt an existing
        // response, append history, and generate only with turnComplete=true.
        peer.finish('cancelled')
        if (message.clientContent.turnComplete) peer.start()
      }
    })
    if (key === 'minicpm-o') peer.send({ type: 'session.queue_done' })
    else if (!['google-live', 'doubao-seeduplex'].includes(key)) peer.send({ type: 'session.created', session: {} })
  })
  const base = defaultRealtimeProviderRegistry.resolve(key)
  const provider = {
    ...base,
    isConfigured: () => true,
    url: () => `ws://127.0.0.1:${server.address().port}`,
    headers: () => ({}),
  }
  t.after(async () => {
    for (const socket of server.clients) socket.terminate()
    await new Promise(resolve => server.close(resolve))
  })
  return { provider, connections }
}

async function connect(t, key) {
  const fixture = await service(t, key)
  const events = []
  const errors = []
  const frontend = new RealtimeFrontend({
    provider: fixture.provider,
    onEvent: event => events.push(event),
    onError: error => errors.push(error),
    responseStartTimeoutMs: 2000,
    responseCancelGraceMs: 1000,
  })
  t.after(() => frontend.close())
  t.after(() => assert.deepEqual(errors, [], 'unexpected provider errors'))
  await frontend.connect()
  // A protocol ping is a deterministic barrier for all preceding data frames.
  const flush = async () => {
    const pong = once(frontend.ws, 'pong')
    frontend.ws.ping()
    await pong
  }
  await flush()
  return { ...fixture, frontend, events, errors, flush, peer: fixture.connections[0] }
}

for (const key of defaultRealtimeProviderRegistry.list().map(provider => provider.key)) {
  test(`${key}: shared runtime behavior contract`, async t => {
    // Keep the DashScope profile independent from the developer's config.env.
    const previous = config.audioModel
    config.audioModel = 'qwen-audio-3.0-realtime-plus'
    t.after(() => { config.audioModel = previous })

    await t.test('context-only delivery preserves successive updates without a reply', async t => {
      const { frontend, peer, flush } = await connect(t, key)
      if (!frontend.capabilities.conversationItems) {
        assert.equal(await frontend.appendUserContext('context one'), false)
        assert.equal((await frontend.injectDelivery('context two', 'gateway', {}, { route: 'context' })).unsupported, true)
      } else {
        await frontend.appendUserContext('context one')
        assert.equal((await frontend.injectDelivery('context two', 'gateway', {}, { route: 'context' })).contextInjected, true)
        await flush()
        const wire = JSON.stringify(peer.messages)
        assert.ok(wire.indexOf('context one') < wire.indexOf('context two'))
        assert.ok(wire.includes('context one'))
        assert.ok(wire.includes('context two'))
      }
      assert.equal(peer.replies, 0)
    })

    await t.test('tool result keeps its call identity and completes one continuation', async t => {
      const { frontend, peer, events, flush } = await connect(t, key)
      if (!frontend.capabilities.conversationItems) {
        await assert.rejects(frontend.sendFunctionOutput('call_contract', { value: 42 }), /不支持/)
        return
      }
      peer.toolCall()
      await waitFor(() => events.some(event => event.type === 'response.function_call_arguments.done') && !frontend.activeResponses.size)
      const call = events.find(event => event.type === 'response.function_call_arguments.done')
      assert.equal(call.call_id, 'call_contract')
      assert.equal(call.name, 'lookup')
      assert.deepEqual(JSON.parse(call.arguments), { q: 'test' })
      const before = peer.replies
      const result = await frontend.sendFunctionOutput(call.call_id, { value: 42 })
      await flush()
      if (frontend.capabilities.automaticToolResponses) {
        assert.deepEqual(result, { delivered: true, automatic: true })
      } else assert.equal(result.completed, true)
      assert.equal(peer.replies, before + 1)
      assert.ok(peer.messages.some(message => JSON.stringify(message).includes('call_contract') && JSON.stringify(message).includes('42')))
      assert.equal(frontend.pendingResponses.length, 0)
    })

    await t.test('permission identity reaches context before the spoken question completes', async t => {
      const { frontend, peer, flush } = await connect(t, key)
      const permission = { id: 'auth_1', taskId: 'job_1', summary: 'read system information' }
      if (!frontend.capabilities.conversationItems) {
        assert.equal((await frontend.injectPermission(permission)).unsupported, true)
        return
      }
      assert.equal((await frontend.injectPermission(permission)).completed, true)
      await flush()
      assert.equal(peer.replies, 1)
      const identity = peer.messages.findIndex(message => JSON.stringify(message).includes('auth_1'))
      assert.ok(identity >= 0)
      assert.ok(JSON.stringify(peer.messages[identity]).includes('job_1'))
    })

    await t.test('cancel releases the response slot and the next turn can complete', async t => {
      const { frontend, peer, events, flush } = await connect(t, key)
      if (!frontend.capabilities.clientResponses) {
        assert.equal((await frontend.ensureResponse()).unsupported, true)
        assert.equal((await frontend.speak('hello')).unsupported, true)
        peer.start()
        await waitFor(() => events.some(event => event.type === 'response.done'))
        frontend.cancel()
        assert.equal(frontend.pendingResponses.length, 0)
        return
      }
      peer.autoComplete = false
      const pending = frontend.sendUserText('hello')
      await waitFor(() => frontend.activeResponses.size === 1)
      frontend.cancel()
      assert.equal((await pending).cancelled, true)
      await flush()
      assert.equal(frontend.activeResponses.size, 0)
      peer.autoComplete = true
      assert.equal((await frontend.sendUserText('next turn')).completed, true)
      assert.equal(frontend.ready, true)
    })

    await t.test('async results wait for the active turn and stale announcements are skipped', async t => {
      const { frontend, peer, flush } = await connect(t, key)
      if (!frontend.capabilities.clientResponses) {
        assert.equal((await frontend.injectDelivery('async result')).unsupported, true)
        return
      }
      peer.autoComplete = false
      const first = frontend.sendUserText('hello')
      await waitFor(() => frontend.activeResponses.size === 1)
      const result = frontend.injectDelivery('async result', 'agent', { taskId: 'job_1' })
      await flush()
      assert.equal(peer.replies, 1)
      assert.equal(JSON.stringify(peer.messages).includes('async result'), false)
      peer.autoComplete = true
      peer.finish()
      assert.equal((await first).completed, true)
      assert.equal((await result).completed, true)
      await flush()
      assert.equal(peer.replies, 2)
      assert.ok(JSON.stringify(peer.messages).includes('async result'))
      const skipped = await frontend.injectDelivery('obsolete', 'agent', {}, { shouldRespond: () => false })
      await flush()
      assert.equal(skipped.skipped, true)
      assert.equal(peer.replies, 2)
      assert.equal(JSON.stringify(peer.messages).includes('obsolete'), false)
    })

    await t.test('unexpected disconnect reconnects once and restores context where supported', async t => {
      const { provider, connections } = await service(t, key)
      const events = []
      const errors = []
      let reconnected = 0
      const runtime = new RealtimeProviderSession({
        providerRegistry: { resolve: () => provider },
        defaultProvider: key,
        getAgentContext: () => ({ recentMessages: [{ role: 'user', content: 'remember this' }] }),
        shouldReconnect: () => true,
        onEvent: event => events.push(event),
        onConnected() {}, onReady() {}, onDisconnected() {}, onConnectionState() {},
        onReconnected: () => { reconnected += 1 },
        onError: error => errors.push(error), onReconnectError: error => errors.push(error),
        logger: { info() {}, warn() {}, error() {} },
        reconnectBackoff: { next: () => 1, reset() {} },
        createFrontend: options => new RealtimeFrontend({ ...options, provider, responseStartTimeoutMs: 2000 }),
      })
      t.after(() => runtime.close())
      await runtime.ensure()
      const stale = runtime.frontend
      connections[0].socket.terminate()
      await waitFor(() => reconnected === 1 && runtime.ready)
      assert.equal(connections.length, 2)
      assert.notEqual(runtime.frontend, stale)
      const before = events.length
      stale.onEvent({ type: 'error', error: { message: 'stale connection' } })
      assert.equal(events.length, before)
      const canRestore = runtime.frontend.capabilities.conversationItems && runtime.frontend.capabilities.restoreConversationContext
      if (canRestore) await waitFor(() => JSON.stringify(connections[1].messages).includes('remember this'))
      assert.equal(connections[1].replies, 0)
      assert.deepEqual(errors, [])
    })
  })
}
