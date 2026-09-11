import assert from 'node:assert/strict'
import test from 'node:test'
import { GatewayServerEvent } from 'qwen-audio-agent/realtime-events'
import { createHookHarness, deferred, mockHookImports } from './helpers/hook-harness.mjs'

function memoryResponse(text) {
  return {
    ok: true,
    json: async () => ({ documents: [{
      scope: 'memory', revision: text, editable: true, content: `# MEMORY\n- ${text}`,
    }] }),
  }
}

async function fixture(t, { voice = false } = {}) {
  const harness = createHookHarness()
  t.after(() => harness.unmount())
  const requests = []
  const clients = []
  t.mock.method(globalThis, 'fetch', (url, options) => {
    const pending = deferred()
    requests.push({ url, options, ...pending })
    return pending.promise
  })
  if (voice) {
    for (const name of ['requestAnimationFrame', 'cancelAnimationFrame']) {
      const original = Object.getOwnPropertyDescriptor(globalThis, name)
      Object.defineProperty(globalThis, name, { configurable: true, value: () => 0 })
      t.after(() => original
        ? Object.defineProperty(globalThis, name, original)
        : Reflect.deleteProperty(globalThis, name))
    }
  }
  class FakeGatewayClient {
    constructor(options) {
      this.options = options
      this.ready = false
      this.stops = 0
      clients.push(this)
    }
    start() {}
    stop() { this.stops += 1 }
    send() { return true }
    supports() { return false }
    status(state) {
      this.ready = state === 'ready'
      this.options.onStatus({ state })
    }
    event(event) { this.options.onEvent(event) }
  }
  const load = mockHookImports(t, {
    react: harness.react,
    'qwen-audio-agent/gateway-client-sdk': { GatewayClient: FakeGatewayClient },
    '../config/gateway': {
      gatewayHttpUrl: path => `http://gateway.invalid${path}`,
      gatewayWebSocketUrl: path => new URL(path, 'ws://gateway.invalid'),
    },
  })
  const { default: useGatewayMemory } = await load(new URL('../src/hooks/useGatewayMemory.js', import.meta.url))
  const useVoiceSession = voice
    ? (await load(new URL('../src/hooks/useVoiceSession.js', import.meta.url))).default
    : null
  return { harness, requests, clients, useGatewayMemory, useVoiceSession }
}

test('memory notifications and every SDK ready synchronize a muted panel without tool debug events', async t => {
  const { harness, requests, clients, useGatewayMemory, useVoiceSession } = await fixture(t, { voice: true })
  const messages = []
  function usePanel() {
    const memory = useGatewayMemory()
    useVoiceSession({
      muted: true, clientId: 'memory-panel',
      onVoiceMessage: event => messages.push(event),
      onMemoryChanged: memory.load,
    })
    return memory
  }
  const render = () => harness.render(usePanel)
  render()
  assert.equal(clients.length, 1)
  const client = clients[0]
  assert.equal(client.options.configure().voiceEnabled, false)
  assert.equal(requests.length, 0)

  client.status('ready')
  assert.equal(requests.length, 1)
  requests[0].resolve(memoryResponse('原有记忆'))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(render().items[0].text, '原有记忆')

  client.event({ type: 'memory.changed' })
  assert.equal(requests.length, 2)
  requests[1].resolve(memoryResponse('自动提取的新偏好'))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(render().items[0].text, '自动提取的新偏好')
  assert.deepEqual(messages, [])

  client.event({ type: GatewayServerEvent.TOOL_CALL, name: 'memory', status: 'completed' })
  assert.equal(messages.length, 1)
  assert.equal(requests.length, 2, 'debug events must not trigger a duplicate fetch')

  client.status('disconnected')
  client.status('ready')
  assert.equal(requests.length, 3, 'ready compensates for memory events missed while disconnected')
  requests[2].resolve(memoryResponse('断线期间的新偏好'))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(render().items[0].text, '断线期间的新偏好')
  assert.equal(clients.length, 1)
})

test('changing the memory callback uses the latest ref without reconnecting the voice hook', async t => {
  const { harness, clients, useVoiceSession } = await fixture(t, { voice: true })
  const calls = []
  const render = onMemoryChanged => harness.render(useVoiceSession, {
    muted: true, clientId: 'stable-connection', onMemoryChanged,
  })
  render(() => calls.push('first'))
  const client = clients[0]
  client.event({ type: 'memory.changed' })
  render(() => calls.push('latest'))
  client.event({ type: 'memory.changed' })
  client.status('ready')

  assert.deepEqual(calls, ['first', 'latest', 'latest'])
  assert.equal(clients.length, 1)
  assert.equal(client.stops, 0)
  render(undefined)
  assert.doesNotThrow(() => client.event({ type: 'memory.changed' }))
  assert.doesNotThrow(() => client.status('ready'))
})

test('a slow older GET cannot overwrite newer documents or the latest successful state', async t => {
  const { harness, requests, useGatewayMemory } = await fixture(t)
  const render = () => harness.render(useGatewayMemory)
  const memory = render()
  const oldLoad = memory.load()
  const newLoad = memory.load()

  requests[1].resolve(memoryResponse('新记忆'))
  await newLoad
  assert.equal(render().items[0].text, '新记忆')
  requests[0].resolve(memoryResponse('旧记忆'))
  await oldLoad

  const state = render()
  assert.equal(state.items[0].text, '新记忆')
  assert.equal(state.loading, false)
  assert.equal(state.error, null)
})

test('an older GET finishing first cannot clear loading while the newest GET is pending', async t => {
  const { harness, requests, useGatewayMemory } = await fixture(t)
  const render = () => harness.render(useGatewayMemory)
  const memory = render()
  const oldLoad = memory.load()
  const newLoad = memory.load()
  requests[0].resolve(memoryResponse('过期记忆'))
  await oldLoad

  assert.equal(render().loading, true)
  assert.deepEqual(render().items, [])
  requests[1].resolve(memoryResponse('最新记忆'))
  await newLoad
  assert.equal(render().loading, false)
  assert.equal(render().items[0].text, '最新记忆')
})

test('late errors from superseded GETs cannot replace a successful refresh', async t => {
  const { harness, requests, useGatewayMemory } = await fixture(t)
  const render = () => harness.render(useGatewayMemory)
  const memory = render()
  const oldLoad = memory.load()
  const newLoad = memory.load()
  requests[1].resolve(memoryResponse('最新记忆'))
  await newLoad
  requests[0].reject(new Error('旧请求失败'))
  await oldLoad

  assert.equal(render().items[0].text, '最新记忆')
  assert.equal(render().error, null)
  assert.equal(render().loading, false)
})

test('latest GET failures remain visible even when an older request later succeeds', async t => {
  const { harness, requests, useGatewayMemory } = await fixture(t)
  const render = () => harness.render(useGatewayMemory)
  const memory = render()
  const oldLoad = memory.load()
  const newLoad = memory.load()
  requests[1].resolve({ ok: false, status: 503, json: async () => ({ error: '记忆服务暂不可用' }) })
  await newLoad
  requests[0].resolve(memoryResponse('过期数据'))
  await oldLoad

  assert.equal(render().error, '记忆服务暂不可用')
  assert.equal(render().loading, false)
  assert.deepEqual(render().items, [])
})
