import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  applyRecommendedDashScopeConfiguration,
  normalizeVoiceMemInputMode,
  VoiceMemProvider,
} from '../voicemem-provider.mjs'

test('defaults unknown input modes to text', () => {
  assert.equal(normalizeVoiceMemInputMode(), 'text')
  assert.equal(normalizeVoiceMemInputMode('TEXT'), 'text')
  assert.equal(normalizeVoiceMemInputMode('audio'), 'audio')
  assert.equal(normalizeVoiceMemInputMode('unexpected'), 'text')
})

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
  const provider = new VoiceMemProvider({ stateDirectory })
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
  const provider = new VoiceMemProvider({
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
  const provider = new VoiceMemProvider({
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

test('captures bounded PCM turns and passes real WAV files only in audio mode', async () => {
  const observed = []
  const sidecar = {
    lastError: null,
    request(method, params) {
      if (method === 'observe') {
        const audioPath = params.messages[0].audioPath
        observed.push({
          params,
          audioPath,
          wav: readFileSync(audioPath),
        })
      }
      return Promise.resolve({})
    },
    close() {},
  }
  const provider = new VoiceMemProvider({
    stateDirectory: mkdtempSync(join(tmpdir(), 'qwaudio-voicemem-audio-')),
    env: { VOICEMEM_INPUT_MODE: 'audio' },
    sidecar,
  })
  const context = { sessionId: 'session-1' }

  assert.equal(provider.describe().capabilities.audioStreamObservation, true)
  provider.observeAudio('owner', {
    type: 'chunk',
    audio: Buffer.from([1, 2, 3, 4]).toString('base64'),
    sampleRate: 16_000,
  }, context)
  provider.observeAudio('owner', {
    type: 'speech_started',
    turnId: 'voice-1',
  }, context)
  provider.observeAudio('owner', {
    type: 'chunk',
    audio: Buffer.from([5, 6, 7, 8, 9, 10]).toString('base64'),
    sampleRate: 16_000,
  }, context)
  provider.observeAudio('owner', {
    type: 'speech_stopped',
    turnId: 'voice-1',
  }, context)
  provider.observeAudio('owner', { type: 'session_ended' }, context)

  await provider.observe('owner', {
    messages: [{
      id: 'message-1',
      role: 'user',
      turnId: 'voice-1',
      content: 'I like tea.',
    }],
  }, context)

  assert.equal(observed.length, 1)
  assert.equal(observed[0].params.messages[0].turnId, 'voice-1')
  assert.equal(observed[0].wav.subarray(0, 4).toString(), 'RIFF')
  assert.equal(observed[0].wav.subarray(8, 12).toString(), 'WAVE')
  assert.equal(observed[0].wav.readUInt32LE(24), 16_000)
  assert.equal(observed[0].wav.readUInt32LE(40), 10)
  assert.equal(existsSync(observed[0].audioPath), false)
})

test('discards invalid audio turns and keeps text mode audio-free', async () => {
  const calls = []
  const sidecar = {
    lastError: null,
    request(method, params) {
      calls.push({ method, params })
      return Promise.resolve({})
    },
    close() {},
  }
  const stateDirectory = mkdtempSync(join(tmpdir(), 'qwaudio-voicemem-mode-'))
  const textProvider = new VoiceMemProvider({
    stateDirectory,
    env: { VOICEMEM_INPUT_MODE: 'text' },
    sidecar,
  })
  assert.equal(
    textProvider.describe().capabilities.audioStreamObservation,
    false,
  )
  assert.deepEqual(
    textProvider.observeAudio('owner', { type: 'chunk', audio: 'AA==' }),
    { observed: false },
  )
  await textProvider.observe('owner', {
    messages: [{ id: 'text-1', role: 'user', content: 'typed text' }],
  }, { sessionId: 'text-session' })
  assert.equal(calls[0].params.messages[0].audioPath, undefined)

  const audioProvider = new VoiceMemProvider({
    stateDirectory: mkdtempSync(join(tmpdir(), 'qwaudio-voicemem-invalid-')),
    env: { VOICEMEM_INPUT_MODE: 'audio' },
    sidecar,
  })
  const context = { sessionId: 'audio-session' }
  audioProvider.observeAudio('owner', {
    type: 'speech_started',
    turnId: 'invalid-turn',
  }, context)
  audioProvider.observeAudio('owner', {
    type: 'chunk',
    audio: Buffer.from([1, 2]).toString('base64'),
  }, context)
  audioProvider.observeAudio('owner', {
    type: 'speech_stopped',
    reason: 'turn_invalid',
  }, context)
  await audioProvider.observe('owner', {
    messages: [{
      id: 'invalid-message',
      role: 'user',
      turnId: 'invalid-turn',
      content: 'fallback text',
    }],
  }, context)
  assert.equal(calls.at(-1).params.messages[0].audioPath, undefined)
})
