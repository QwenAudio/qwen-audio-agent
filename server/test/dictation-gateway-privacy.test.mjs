import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import WebSocket from 'ws'

import { attachRealtimeGateway } from '../src/voice/realtime-gateway.mjs'

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
  const calls = { conversation: 0, memory: 0, audit: 0 }
  let providerCallbacks
  const server = createServer()
  attachRealtimeGateway(server, {
    identityManager: { resolveUpgrade: () => ({ ownerId: 'privacy-owner' }) },
    memoryService: {
      list: () => [],
      apply: () => { calls.memory += 1; return { changed: 1 } },
    },
    memoryExtractor: null,
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

  assert.deepEqual(calls, { conversation: 0, memory: 0, audit: 0 })
})
