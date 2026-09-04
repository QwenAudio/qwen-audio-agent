import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  applyRecommendedDashScopeConfiguration,
  VoiceMemMemoryProvider,
} from '../voicemem-memory-provider.mjs'

test('maps Model Studio credentials without overriding explicit providers', () => {
  const env = { DASHSCOPE_API_KEY: 'dashscope-key' }
  assert.equal(applyRecommendedDashScopeConfiguration(env), true)
  assert.equal(env.OPENAI_API_KEY, 'dashscope-key')
  assert.equal(
    env.OPENAI_BASE_URL,
    'https://dashscope.aliyuncs.com/compatible-mode/v1',
  )
  assert.equal(env.VOICEMEM_CHAT_MODEL, 'qwen3.8-flash')
  assert.equal(env.VOICEMEM_EMBEDDING_MODEL, 'text-embedding-v4')
  assert.equal(env.VOICEMEM_EMBED_DIM, '1024')
  assert.equal(env.VOICEMEM_MEMORY_LANGUAGE, 'zh')

  const explicit = {
    DASHSCOPE_API_KEY: 'dashscope-key',
    OPENAI_API_KEY: 'explicit-key',
    OPENAI_BASE_URL: 'https://example.test/v1',
  }
  assert.equal(applyRecommendedDashScopeConfiguration(explicit), false)
  assert.deepEqual(explicit, {
    DASHSCOPE_API_KEY: 'dashscope-key',
    OPENAI_API_KEY: 'explicit-key',
    OPENAI_BASE_URL: 'https://example.test/v1',
  })
})

test('keeps a synchronous control snapshot and applies exact edits', async () => {
  const stateDirectory = mkdtempSync(join(tmpdir(), 'qwaudio-voicemem-'))
  const provider = new VoiceMemMemoryProvider({ stateDirectory })
  assert.equal(provider.describe().capabilities.sessionObservation, true)
  assert.match(provider.list('owner')[0].content, /# USER/)

  const added = provider.apply('owner', [{
    document: 'user',
    append: '- 助手称呼用户：船长',
  }])
  assert.equal(added.changed, 1)
  assert.match(provider.list('owner', { scope: 'user' })[0].content, /船长/)

  provider.apply('owner', [{
    document: 'user',
    edits: [{ old_text: '船长', new_text: '老大' }],
  }])
  assert.match(provider.list('owner', { scope: 'user' })[0].content, /老大/)
  assert.doesNotMatch(provider.list('owner', { scope: 'user' })[0].content, /船长/)
  const [profile] = readdirSync(join(stateDirectory, 'profiles'))
  assert.doesNotThrow(() => JSON.parse(readFileSync(
    join(stateDirectory, 'profiles', profile), 'utf8',
  )))
})

test('uses a longer timeout for background observation and consolidation', async () => {
  const calls = []
  const sidecar = {
    lastError: null,
    request(method, params, options) {
      calls.push({ method, params, options })
      return Promise.resolve(method === 'recall' ? 'remembered' : {})
    },
    close(options) {
      calls.push({ method: 'close', options })
      return Promise.resolve()
    },
  }
  const provider = new VoiceMemMemoryProvider({
    stateDirectory: mkdtempSync(join(tmpdir(), 'qwaudio-voicemem-timeout-')),
    timeoutMs: 5_000,
    backgroundTimeoutMs: 120_000,
    sidecar,
  })

  await provider.query('owner', 'what do you remember?')
  await provider.observe('owner', {
    messages: [{ id: 'turn-1', role: 'user', content: 'I like tea.' }],
  }, { sessionId: 'session-1' })
  await provider.flush('owner', { sessionId: 'session-1' })
  await provider.close()

  assert.equal(calls.find(call => call.method === 'recall').options, undefined)
  assert.equal(
    calls.find(call => call.method === 'observe').options.timeoutMs,
    120_000,
  )
  assert.equal(
    calls.find(call => call.method === 'flush').options.timeoutMs,
    120_000,
  )
  assert.equal(calls.find(call => call.method === 'close').options.timeoutMs, 120_000)
})

test('coalesces duplicate observations and never queues recall behind them', async () => {
  const calls = []
  let finishObservation
  const sidecar = {
    lastError: null,
    request(method) {
      calls.push(method)
      if (method === 'observe') {
        return new Promise(resolve => { finishObservation = resolve })
      }
      return Promise.resolve(method === 'recall' ? 'semantic context' : {})
    },
    close() {},
  }
  const provider = new VoiceMemMemoryProvider({
    stateDirectory: mkdtempSync(join(tmpdir(), 'qwaudio-voicemem-busy-')),
    sidecar,
  })
  const exchange = {
    messages: [{ id: 'turn-1', role: 'user', content: 'I like tea.' }],
  }

  const first = provider.observe('owner', exchange)
  const duplicate = provider.observe('owner', exchange)
  const recall = await provider.query('owner', 'What do I like?')
  const otherOwnerRecall = await provider.query('other-owner', 'What do I like?')

  assert.deepEqual(calls, ['observe', 'recall'])
  assert.equal(recall.context, '')
  assert.equal(recall.memories.length, 2)
  assert.equal(otherOwnerRecall.context, 'semantic context')
  finishObservation({ observed: true })
  await Promise.all([first, duplicate])
})
