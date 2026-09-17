import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import { WebSocketServer } from 'ws'
import { config } from '../src/core/config.mjs'
import { dashscopeProvider } from '../src/voice/providers/dashscope.mjs'
import { validateRealtimeProvider } from '../src/voice/providers/provider-registry.mjs'
import { RealtimeConfigurationError } from '../src/voice/realtime-errors.mjs'
import { RealtimeFrontend } from '../src/voice/realtime-provider.mjs'
import {
  DASHSCOPE_AUDIO_FLASH_REALTIME_MODEL,
  DASHSCOPE_OMNI_FLASH_REALTIME_MODEL,
  DASHSCOPE_OMNI_PLUS_REALTIME_MODEL,
  DEFAULT_DASHSCOPE_REALTIME_MODEL,
} from '../../shared/realtime-provider-catalog.mjs'

function configure(t, model = DASHSCOPE_OMNI_FLASH_REALTIME_MODEL, voice = 'Cherry') {
  const previous = {
    audioModel: config.audioModel,
    audioVoice: config.audioVoice,
    dashscopeApiKey: config.dashscopeApiKey,
  }
  t.after(() => Object.assign(config, previous))
  Object.assign(config, { audioModel: model, audioVoice: voice, dashscopeApiKey: 'test-only-key' })
}

test('rejects only the known Omni/Cherry mismatch before opening a socket', async t => {
  configure(t)
  for (const model of [DASHSCOPE_OMNI_FLASH_REALTIME_MODEL, DASHSCOPE_OMNI_PLUS_REALTIME_MODEL]) {
    config.audioModel = model
    for (const sessionOptions of [{}, { voice: '  Cherry  ' }, { voice: ' ' }]) {
      const frontend = new RealtimeFrontend({ provider: dashscopeProvider, sessionOptions })
      await assert.rejects(frontend.connect(), error => {
        assert.ok(error instanceof RealtimeConfigurationError)
        assert.equal(error.code, 'REALTIME_CONFIGURATION_ERROR')
        assert.ok(error.message.includes(model))
        assert.match(error.message, /音色 Cherry.*默认音色 Ethan/)
        return true
      })
      assert.equal(frontend.ws, null)
      assert.equal(config.audioVoice, 'Cherry', 'Never rewrite saved configuration')
    }
    config.audioVoice = 'Ethan'
    const overridden = new RealtimeFrontend({ provider: dashscopeProvider, sessionOptions: { voice: 'Cherry' } })
    await assert.rejects(overridden.connect(), /音色 Cherry/)
    assert.equal(overridden.ws, null)
    assert.equal(config.audioVoice, 'Ethan')
    config.audioVoice = 'Cherry'
  }
})

test('leaves defaults, unknown voices and other model families untouched', t => {
  configure(t)
  for (const model of [DASHSCOPE_OMNI_FLASH_REALTIME_MODEL, DASHSCOPE_OMNI_PLUS_REALTIME_MODEL,
    DEFAULT_DASHSCOPE_REALTIME_MODEL, DASHSCOPE_AUDIO_FLASH_REALTIME_MODEL]) {
    config.audioModel = model
    config.audioVoice = ''
    dashscopeProvider.validateSessionOptions()
    assert.equal(dashscopeProvider.voice(), model.includes('omni') ? 'Ethan' : 'longanqian')
    for (const voice of ['Serena', 'future-system-voice', 'qwen-omni-vc-custom-123',
      'qwen3.5-omni-plus-realtime-custom-voice']) {
      config.audioVoice = voice
      assert.doesNotThrow(() => dashscopeProvider.validateSessionOptions())
      assert.equal(dashscopeProvider.voice(), voice)
    }
  }
  config.audioModel = DEFAULT_DASHSCOPE_REALTIME_MODEL
  assert.doesNotThrow(() => dashscopeProvider.validateSessionOptions({ sessionOptions: { voice: 'Cherry' } }))
})

test('sends per-session and unknown voices unchanged to the upstream provider', async t => {
  configure(t)
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await once(server, 'listening')
  t.after(() => {
    for (const socket of server.clients) socket.terminate()
    server.close()
  })
  const received = []
  server.on('connection', socket => {
    socket.send(JSON.stringify({ type: 'session.created' }))
    socket.on('message', raw => {
      const event = JSON.parse(raw)
      if (event.type !== 'session.update') return
      received.push(event.session.voice)
      socket.send(JSON.stringify({ type: 'session.updated' }))
    })
  })
  const provider = { ...dashscopeProvider, url: () => `ws://127.0.0.1:${server.address().port}` }
  const voices = ['Serena', 'future-system-voice', 'qwen-omni-vc-custom-123',
    'qwen3.5-omni-plus-realtime-custom-voice']
  for (const voice of voices) {
    const frontend = new RealtimeFrontend({ provider, sessionOptions: { voice } })
    t.after(() => frontend.close())
    await frontend.connect()
    assert.equal(frontend.ready, true)
    frontend.close()
  }
  assert.deepEqual(received, voices)
  assert.equal(config.audioVoice, 'Cherry', 'Session overrides must not change the process default')
})

test('keeps the optional validation hook provider-neutral and preserves its error', async t => {
  configure(t, DEFAULT_DASHSCOPE_REALTIME_MODEL, 'longanqian')
  const failure = new RealtimeConfigurationError('custom provider rejected selection')
  const options = { voice: 'private-voice' }
  const frontend = new RealtimeFrontend({
    provider: {
      ...dashscopeProvider,
      key: 'private-provider',
      validateSessionOptions({ sessionOptions }) {
        assert.equal(sessionOptions, options)
        throw failure
      },
    },
    sessionOptions: options,
  })
  await assert.rejects(frontend.connect(), error => error === failure)
  assert.equal(frontend.ws, null)
  const { validateSessionOptions: _validate, ...withoutHook } = dashscopeProvider
  assert.doesNotThrow(() => validateRealtimeProvider(withoutHook))
  assert.throws(() => validateRealtimeProvider({ ...dashscopeProvider, validateSessionOptions: true }), /validateSessionOptions/)
})
