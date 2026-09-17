import assert from 'node:assert/strict'
import test from 'node:test'
import { WebSocketServer } from 'ws'
import { config } from '../src/core/config.mjs'
import { RealtimeFrontend } from '../src/voice/realtime-provider.mjs'
import { gptLiveProvider } from '../src/voice/providers/gpt-live.mjs'
import { googleLiveProvider } from '../src/voice/providers/google-live.mjs'
import { createGoogleLiveProtocol } from '../src/voice/providers/google-live-protocol.mjs'
import { describeActiveRealtime } from '../src/voice/providers/registry.mjs'

function withConfig(t, patch) {
  const previous = Object.fromEntries(
    Object.keys(patch).map(key => [key, config[key]]),
  )
  Object.assign(config, patch)
  t.after(() => Object.assign(config, previous))
}

test('configures GPT-Live against the OpenAI Realtime WebSocket contract', t => {
  withConfig(t, {
    openaiApiKey: 'openai-test',
    gptLiveRealtimeUrl: 'wss://api.openai.com/v1/realtime?region=test',
    gptLiveModel: 'gpt-realtime-2.1',
    gptLiveVoice: 'marin',
  })

  assert.equal(gptLiveProvider.isConfigured(), true)
  const url = new URL(gptLiveProvider.url())
  assert.equal(url.origin, 'wss://api.openai.com')
  assert.equal(url.searchParams.get('model'), 'gpt-realtime-2.1')
  assert.equal(url.searchParams.get('region'), 'test')
  assert.deepEqual(gptLiveProvider.headers(), {
    Authorization: 'Bearer openai-test',
  })

  const session = gptLiveProvider.buildSession({
    agentContext: {},
    sessionOptions: {},
  })
  assert.equal(session.type, 'realtime')
  assert.equal(session.audio.input.format.rate, 24000)
  assert.equal(session.audio.output.voice, 'marin')
  assert.equal(
    describeActiveRealtime('gpt-live').modelCapabilities.functionCalling,
    true,
  )
})

test('maps Google Live WebSocket messages into the shared realtime lifecycle', () => {
  const protocol = createGoogleLiveProtocol()
  assert.deepEqual(protocol.connectionMessages({
    session: { model: 'models/gemini-3.8-live', responseModalities: ['AUDIO'] },
  }), [{
    setup: { model: 'models/gemini-3.8-live', responseModalities: ['AUDIO'] },
  }])
  assert.deepEqual(protocol.audioAppend('AAAA'), {
    realtimeInput: {
      audio: { data: 'AAAA', mimeType: 'audio/pcm;rate=16000' },
    },
  })
  assert.equal(
    protocol.normalizeIncoming({ setupComplete: {} }).type,
    'session.updated',
  )

  const audio = protocol.normalizeIncoming({
    serverContent: {
      modelTurn: {
        parts: [{
          inlineData: {
            data: 'AQID',
            mimeType: 'audio/pcm;rate=24000',
          },
        }],
      },
      outputTranscription: { text: '你好' },
      turnComplete: true,
    },
  })
  assert.deepEqual(audio.map(event => event.type), [
    'response.created',
    'response.audio.delta',
    'response.audio_transcript.done',
    'response.done',
  ])
  assert.equal(audio[1].sampleRate, 24000)

  const tool = protocol.normalizeIncoming({
    toolCall: {
      functionCalls: [{ id: 'call_1', name: 'lookup', args: { q: '天气' } }],
    },
  })
  assert.equal(tool[1].type, 'response.function_call_arguments.done')
  assert.equal(tool[1].name, 'lookup')
  assert.equal(tool[1].arguments, '{"q":"天气"}')
  assert.deepEqual(protocol.conversationItemCreate(
    protocol.functionOutputItem('call_1', { ok: true }),
  ), {
    toolResponse: {
      functionResponses: [{
        id: 'call_1',
        name: 'lookup',
        response: { ok: true },
      }],
    },
  })
})

test('connects to a Google Live mock service with setup and text input', async t => {
  withConfig(t, {
    googleApiKey: 'google-test',
    googleLiveModel: 'gemini-3.8-live',
    googleLiveVoice: '',
  })
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise(resolve => server.once('listening', resolve))
  const received = []
  const events = []

  server.once('connection', socket => {
    socket.on('message', raw => {
      const message = JSON.parse(raw.toString())
      received.push(message)
      if (message.setup) {
        socket.send(JSON.stringify({ setupComplete: {} }))
      } else if (message.realtimeInput?.text) {
        socket.send(JSON.stringify({
          serverContent: {
            modelTurn: {
              parts: [{ inlineData: { data: 'AAAA', mimeType: 'audio/pcm;rate=24000' } }],
            },
            turnComplete: true,
          },
        }))
      }
    })
  })
  const address = server.address()
  withConfig(t, {
    googleLiveRealtimeUrl: `ws://127.0.0.1:${address.port}/ws`,
  })
  const frontend = new RealtimeFrontend({
    provider: googleLiveProvider,
    agentContext: {},
    onEvent: event => events.push(event),
    responseStartTimeoutMs: 500,
  })
  t.after(async () => {
    frontend.close()
    await new Promise(resolve => server.close(resolve))
  })

  await frontend.connect()
  assert.equal(frontend.ready, true)
  assert.equal(received[0].setup.model, 'models/gemini-3.8-live')

  await frontend.sendUserText('你好')
  assert.ok(received.some(message => message.realtimeInput?.text === '你好'))
  assert.ok(events.some(event => event.type === 'response.audio.delta'))
})
