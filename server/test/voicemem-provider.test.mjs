import assert from 'node:assert/strict'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ConversationSync } from '../src/conversation/conversation-sync.mjs'
import { FrontendMemoryRuntime } from '../src/memory/runtime.mjs'
import { MemorySessionObserver } from '../src/memory/session-observer.mjs'
import {
  normalizeMemoryProviderSelection,
} from '../../shared/memory-provider-catalog.mjs'
import {
  createConfiguredMemoryProvider,
} from '../src/memory/provider-factory.mjs'
import {
  applyRecommendedDashScopeConfiguration,
  normalizeVoiceMemInputMode,
  VoiceMemProvider,
} from '../src/memory/providers/voicemem/provider.mjs'

test('selects the optional VoiceMem connector through configuration', async () => {
  assert.equal(normalizeMemoryProviderSelection(), 'markdown')
  assert.equal(normalizeMemoryProviderSelection('VoiceMem'), 'voicemem')
  assert.throws(
    () => normalizeMemoryProviderSelection('unknown'),
    /不支持的记忆 Provider/,
  )
  const stateDirectory = mkdtempSync(join(tmpdir(), 'qwaudio-voicemem-built-in-'))
  const sidecarPath = join(stateDirectory, 'sidecar.py')
  writeFileSync(sidecarPath, '')
  const provider = createConfiguredMemoryProvider({
    config: {
      memoryProvider: 'voicemem',
      voiceMemStateDirectory: stateDirectory,
      voiceMemPython: '',
      voiceMemSidecarPath: sidecarPath,
    },
    logger: { warn() {} },
    env: { VOICEMEM_INPUT_MODE: 'text' },
  })
  assert.equal(provider.describe().key, 'voicemem')
  await provider.close()
})

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
  const provider = new VoiceMemProvider({
    stateDirectory,
    sidecar: { lastError: null, close() {} },
  })
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

test('requires an external VoiceMem sidecar instead of bundling Python code', () => {
  assert.throws(
    () => new VoiceMemProvider({
      stateDirectory: mkdtempSync(join(tmpdir(), 'qwaudio-voicemem-external-')),
      env: {},
    }),
    /VOICEMEM_SIDECAR/,
  )
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

function audioProviderFixture(t, request) {
  const stateDirectory = mkdtempSync(join(tmpdir(), 'qwaudio-voicemem-lifecycle-'))
  const provider = new VoiceMemProvider({
    stateDirectory,
    env: { VOICEMEM_INPUT_MODE: 'audio' },
    sidecar: { request, close() {} },
  })
  t.after(async () => {
    await provider.close()
    rmSync(stateDirectory, { recursive: true, force: true })
  })
  return provider
}

function completedAudioTurn(provider, context, turnId, audio = Buffer.from([1, 2, 3, 4])) {
  provider.observeAudio(context.ownerId, { type: 'speech_started', turnId }, context)
  provider.observeAudio(context.ownerId, {
    type: 'chunk', audio: audio.toString('base64'), sampleRate: 24_000,
  }, context)
  provider.observeAudio(context.ownerId, { type: 'speech_stopped', turnId }, context)
}

for (const discardedEvidence of [false, true]) {
  test(`flush releases closed audio sessions without fresh text (discarded=${discardedEvidence})`, async t => {
    const calls = []
    const provider = audioProviderFixture(t, async method => { calls.push(method) })
    const sync = new ConversationSync()
    const observer = new MemorySessionObserver({
      memoryService: new FrontendMemoryRuntime({ provider }), conversationSync: sync,
    })
    for (let index = 0; index < 3; index++) {
      const context = { ownerId: 'owner', sessionId: `closed-${index}` }
      completedAudioTurn(provider, context, `turn-${index}`)
      if (discardedEvidence) {
        sync.record({ ...context, id: `user-${index}`, role: 'user', source: 'voice-user', content: 'Old evidence' })
        sync.discardRecorded(context.ownerId)
      }
      observer.onAudio({ ...context, event: { type: 'session_ended' } })
      assert.equal(provider.audioSessions.size, 1)
      await observer.onSessionClosed(context)
      assert.equal(provider.audioSessions.size, 0)
    }
    assert.deepEqual(calls, ['flush', 'flush', 'flush'])
  })
}

test('failed flush releases ended audio without clearing a same-id reconnect', async t => {
  const deferred = Promise.withResolvers()
  const provider = audioProviderFixture(t, () => deferred.promise)
  const context = { ownerId: 'owner', sessionId: 'reconnected' }
  completedAudioTurn(provider, context, 'old-turn')
  provider.observeAudio(context.ownerId, { type: 'session_ended' }, context)
  const flushing = provider.flush(context.ownerId, context)
  assert.equal(provider.audioSessions.size, 0, 'cleanup does not wait for remote consolidation')
  completedAudioTurn(provider, context, 'new-turn')
  const [reconnected] = provider.audioSessions.values()
  deferred.reject(new Error('flush failed'))
  await assert.rejects(flushing, /flush failed/u)
  assert.equal(provider.audioSessions.size, 1)
  assert.equal([...provider.audioSessions.values()][0], reconnected)
  assert.deepEqual([...reconnected.completed.keys()], ['new-turn'])
  assert.equal(provider.backgroundOperations.size, 0)
})

test('synchronous flush failure still releases closed audio', async t => {
  const provider = audioProviderFixture(t, () => { throw new Error('sidecar unavailable') })
  const context = { ownerId: 'owner', sessionId: 'closed' }
  completedAudioTurn(provider, context, 'old-turn')
  provider.observeAudio(context.ownerId, { type: 'session_ended' }, context)
  await assert.rejects(provider.flush(context.ownerId, context), /sidecar unavailable/u)
  assert.equal(provider.audioSessions.size, 0)
  assert.equal(provider.backgroundOperations.size, 0)
})

test('observation takes ended audio before flush and delayed close preserves reconnected audio', async t => {
  const deferred = Promise.withResolvers()
  const observed = []
  const calls = []
  const provider = audioProviderFixture(t, (method, params) => {
    calls.push(method)
    if (method === 'observe') {
      const { audioPath, turnId } = params.messages[0]
      observed.push({ audioPath, turnId, pcm: readFileSync(audioPath).subarray(44) })
      return observed.length === 1 ? deferred.promise : Promise.resolve({})
    }
    return Promise.resolve({})
  })
  const context = { ownerId: 'owner', sessionId: 'same-session' }
  const sync = new ConversationSync()
  const observer = new MemorySessionObserver({
    memoryService: new FrontendMemoryRuntime({ provider }), conversationSync: sync,
  })
  const closeTurn = (turnId, audio) => {
    completedAudioTurn(provider, context, turnId, audio)
    sync.record({ ...context, id: turnId, turnId, role: 'user', source: 'voice-user', content: `Message ${turnId}` })
    observer.onAudio({ ...context, event: { type: 'session_ended' } })
    return observer.onSessionClosed(context)
  }
  const firstAudio = Buffer.from([1, 2, 3, 4])
  const secondAudio = Buffer.from([5, 6, 7, 8])
  const closing = closeTurn('first', firstAudio)
  assert.equal(provider.audioSessions.size, 0, 'observe detaches its audio before awaiting')
  assert.deepEqual(observed[0].pcm, firstAudio)
  assert.equal(existsSync(observed[0].audioPath), true)

  completedAudioTurn(provider, context, 'second', secondAudio)
  const [reconnected] = provider.audioSessions.values()
  deferred.resolve({})
  await closing
  assert.equal([...provider.audioSessions.values()][0], reconnected, 'old flush must not clear active reconnect')
  assert.equal(existsSync(observed[0].audioPath), false)

  sync.record({ ...context, id: 'second', turnId: 'second', role: 'user', source: 'voice-user', content: 'Message second' })
  observer.onAudio({ ...context, event: { type: 'session_ended' } })
  await observer.onSessionClosed(context)
  assert.deepEqual(observed.map(item => item.turnId), ['first', 'second'])
  assert.deepEqual(observed[1].pcm, secondAudio)
  assert.equal(existsSync(observed[1].audioPath), false)
  assert.equal(provider.audioSessions.size, 0)
  assert.deepEqual(calls, ['observe', 'flush', 'observe', 'flush'])
})

test('reconnecting before flush replaces ended audio instead of merging sessions', async t => {
  const provider = audioProviderFixture(t, async () => ({}))
  const context = { ownerId: 'owner', sessionId: 'same-session' }
  completedAudioTurn(provider, context, 'old-turn')
  provider.observeAudio(context.ownerId, { type: 'session_ended' }, context)
  completedAudioTurn(provider, context, 'new-turn')
  const [reconnected] = provider.audioSessions.values()
  assert.deepEqual([...reconnected.completed.keys()], ['new-turn'])
  await provider.flush(context.ownerId, context)
  assert.equal([...provider.audioSessions.values()][0], reconnected)
})
