import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import WebSocket from 'ws'

import { attachRealtimeGateway } from '../src/voice/realtime-gateway.mjs'
import { dashscopeProvider } from '../src/voice/providers/dashscope.mjs'

const unavailableRealtimeProvider = {
  ...dashscopeProvider,
  isConfigured: () => false,
  missingConfigurationMessage: 'fake realtime unavailable',
}

function waitFor(received, type, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const poll = () => {
      const event = received.find(item => item.type === type)
      if (event) return resolve(event)
      if (Date.now() >= deadline) return reject(new Error(`${type} not received`))
      setTimeout(poll, 5)
    }
    poll()
  })
}

test('gateway partial, cancel, and provider failure call conversation and Memory zero times', async t => {
  const calls = { conversation: 0, memory: 0, audit: 0, extractor: 0 }
  let providerCallbacks
  const server = createServer()
  attachRealtimeGateway(server, {
    identityManager: { resolveUpgrade: () => ({ ownerId: 'privacy-owner' }) },
    memoryService: {
      list: () => [],
      apply: () => { calls.memory += 1; return { changed: 1 } },
    },
    memoryExtractor: { maybeRun: () => { calls.extractor += 1 } },
    notesStore: null,
    coordinator: {},
    respondPermission: async () => ({}),
    permissionPolicy: { mode: () => 'ask', applyDecision: () => {}, setMode: () => {} },
    conversationService: {
      record: () => { calls.conversation += 1 },
      frontendContext: () => [],
      hasEquivalentAssistantSpeech: () => false,
    },
    realtimeProviderRegistry: {
      resolve: () => unavailableRealtimeProvider,
      resolveDictation: () => ({
        inputSampleRate: 16000,
        isConfigured: () => true,
        createTranscriber: () => ({
          start: callbacks => { providerCallbacks = callbacks },
          append: () => {}, pause: () => {}, resume: () => {}, close: () => {},
        }),
      }),
    },
    dictation: {
      enabled: true,
      provider: 'fake',
      memoryAudit: { record: () => { calls.audit += 1 } },
    },
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}/api/realtime`)
  const received = []
  socket.on('message', raw => received.push(JSON.parse(raw.toString())))
  await new Promise((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
  t.after(async () => {
    socket.close()
    await new Promise(resolve => server.close(resolve))
  })

  socket.send(JSON.stringify({
    type: 'connect', voiceEnabled: true, inputEnabled: true,
    outputEnabled: true, clientType: 'web', clientInstanceId: 'privacy-web',
  }))
  await waitFor(received, 'voice.ownership')

  socket.send(JSON.stringify({
    type: 'dictation.start', revision: 0, text: 'private partial', continuous: true,
  }))
  await waitFor(received, 'dictation.state')
  providerCallbacks.partial('never persist me')
  await waitFor(received, 'dictation.partial')
  socket.send(JSON.stringify({ type: 'dictation.cancel' }))
  await new Promise(resolve => setTimeout(resolve, 10))
  providerCallbacks.error(new Error('late failure'))
  providerCallbacks.final('late final')
  await new Promise(resolve => setTimeout(resolve, 10))

  assert.deepEqual(calls, {
    conversation: 0, memory: 0, audit: 0, extractor: 0,
  })
})

test('explicit correction is Memory-only and never enters conversation extraction', async t => {
  const calls = { conversation: 0, memory: 0, audit: 0, extractor: 0 }
  let providerCallbacks
  const server = createServer()
  attachRealtimeGateway(server, {
    identityManager: { resolveUpgrade: () => ({ ownerId: 'memory-owner' }) },
    memoryService: {
      list: () => [],
      apply: () => { calls.memory += 1; return { changed: 1 } },
    },
    memoryExtractor: { maybeRun: () => { calls.extractor += 1 } },
    notesStore: null,
    coordinator: {},
    respondPermission: async () => ({}),
    permissionPolicy: { mode: () => 'ask', applyDecision: () => {}, setMode: () => {} },
    conversationService: {
      record: () => { calls.conversation += 1 },
      frontendContext: () => [],
      hasEquivalentAssistantSpeech: () => false,
    },
    realtimeProviderRegistry: {
      resolve: () => unavailableRealtimeProvider,
      resolveDictation: () => ({
        inputSampleRate: 16000,
        isConfigured: () => true,
        createTranscriber: () => ({
          start: callbacks => { providerCallbacks = callbacks },
          append: () => {}, pause: () => {}, resume: () => {}, close: () => {},
        }),
      }),
    },
    dictation: {
      enabled: true,
      provider: 'fake',
      memoryAudit: { record: () => { calls.audit += 1 } },
    },
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}/api/realtime`)
  const received = []
  socket.on('message', raw => received.push(JSON.parse(raw.toString())))
  await new Promise((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
  t.after(async () => {
    socket.close()
    await new Promise(resolve => server.close(resolve))
  })

  socket.send(JSON.stringify({
    type: 'connect', voiceEnabled: true, inputEnabled: true,
    outputEnabled: true, clientType: 'web', clientInstanceId: 'memory-web',
  }))
  await waitFor(received, 'voice.ownership')

  const text = '纠正长期事实：上海改为杭州。'
  socket.send(JSON.stringify({
    type: 'dictation.start', revision: 0, text, continuous: true,
  }))
  await waitFor(received, 'dictation.state')
  providerCallbacks.final('发送。')
  const request = await waitFor(received, 'dictation.commit.request')
  assert.equal(request.intent, 'memory-correction')
  socket.send(JSON.stringify({
    type: 'dictation.commit.ack',
    intent: 'memory-correction',
    accepted: true,
    submitted: false,
    commitId: request.commitId,
    revision: request.revision,
    fingerprint: request.fingerprint,
  }))
  await new Promise(resolve => setTimeout(resolve, 10))

  assert.deepEqual(calls, {
    conversation: 0, memory: 1, audit: 1, extractor: 0,
  })
})

test('gateway rejects dictation START without active voice ownership', async t => {
  let created = 0
  const server = createServer()
  attachRealtimeGateway(server, {
    identityManager: { resolveUpgrade: () => ({ ownerId: 'unowned-user' }) },
    memoryService: { list: () => [] },
    notesStore: null,
    coordinator: {},
    respondPermission: async () => ({}),
    permissionPolicy: { mode: () => 'ask', applyDecision: () => {}, setMode: () => {} },
    conversationService: {
      record: () => {}, frontendContext: () => [],
      hasEquivalentAssistantSpeech: () => false,
    },
    realtimeProviderRegistry: {
      resolveDictation: () => ({
        inputSampleRate: 16000,
        isConfigured: () => true,
        createTranscriber: () => { created += 1; return {} },
      }),
    },
    dictation: { enabled: true, provider: 'fake' },
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}/api/realtime`)
  const received = []
  socket.on('message', raw => received.push(JSON.parse(raw.toString())))
  await new Promise((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
  t.after(async () => {
    socket.close()
    await new Promise(resolve => server.close(resolve))
  })

  socket.send(JSON.stringify({
    type: 'dictation.start', revision: 0, text: '', continuous: true,
  }))
  const refused = await waitFor(received, 'dictation.state')
  assert.equal(refused.state, 'error')
  assert.match(refused.message, /归属/)
  assert.equal(created, 0)
})
