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
    audioProvider: 'gpt-live',
    realtimeCredential: 'openai-test',
    realtimeEndpoint: 'wss://api.openai.com/v1/realtime?region=test',
    realtimeModel: 'gpt-realtime-2.1',
    realtimeVoice: 'marin',
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
    session: { model: 'models/gemini-3.8-live', generationConfig: { responseModalities: ['AUDIO'] } },
  }), [{
    setup: { model: 'models/gemini-3.8-live', generationConfig: { responseModalities: ['AUDIO'] } },
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
    audioProvider: 'google-live',
    realtimeCredential: 'google-test',
    realtimeModel: 'gemini-3.8-live',
    realtimeVoice: '',
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
    realtimeEndpoint: `ws://127.0.0.1:${address.port}/ws`,
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
  assert.deepEqual(received[0].setup.generationConfig.responseModalities, ['AUDIO'])
  assert.equal(received[0].setup.responseModalities, undefined)

  await frontend.sendUserText('你好')
  assert.ok(received.some(message => message.realtimeInput?.text === '你好'))
  assert.ok(events.some(event => event.type === 'response.audio.delta'))
})

function containsKey(value, key) {
  if (!value || typeof value !== 'object') return false
  return Object.hasOwn(value, key)
    || Object.values(value).some(child => containsKey(child, key))
}

test('Google Live setup passes Gemini tool schema validation', async t => {
  withConfig(t, {
    audioProvider: 'google-live',
    realtimeCredential: 'google-test',
    realtimeModel: 'gemini-3.8-live',
    realtimeVoice: '',
  })
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise(resolve => server.once('listening', resolve))
  let setup = null

  // Mirrors the live service: `parameters` only accepts Gemini's OpenAPI
  // subset, and an unknown keyword closes the socket before setupComplete.
  server.once('connection', socket => {
    socket.once('message', raw => {
      setup = JSON.parse(raw.toString()).setup
      const declarations = (setup.tools || []).flatMap(tool => tool.functionDeclarations || [])
      if (declarations.some(declaration => containsKey(declaration.parameters, 'additionalProperties'))) {
        socket.close(1007, 'Invalid JSON payload received. Unknown name "additionalProperties"')
        return
      }
      socket.send(JSON.stringify({ setupComplete: {} }))
    })
  })
  withConfig(t, {
    realtimeEndpoint: `ws://127.0.0.1:${server.address().port}/ws`,
  })
  const frontend = new RealtimeFrontend({
    provider: googleLiveProvider,
    agentContext: {},
    onEvent: () => {},
    responseStartTimeoutMs: 500,
  })
  t.after(async () => {
    frontend.close()
    await new Promise(resolve => server.close(resolve))
  })

  await frontend.connect()
  assert.equal(frontend.ready, true)
  const declarations = setup.tools.flatMap(tool => tool.functionDeclarations || [])
  assert.ok(declarations.length > 0)
  assert.ok(declarations.some(declaration => containsKey(declaration.parametersJsonSchema, 'additionalProperties')))
  assert.ok(declarations.every(declaration => declaration.parameters === undefined))
})

test('createGoogleLiveProtocol formats declarations with parametersJsonSchema', () => {
  const protocol = createGoogleLiveProtocol()
  const declarations = protocol.googleTools([
    {
      function: {
        name: 'sample_tool',
        description: 'a test tool',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
    },
  ])
  assert.equal(declarations.length, 1)
  const fn = declarations[0].functionDeclarations[0]
  assert.equal(fn.name, 'sample_tool')
  assert.equal(fn.parameters, undefined)
  assert.deepEqual(fn.parametersJsonSchema, {
    type: 'object',
    properties: {},
    additionalProperties: false,
  })
})

test('Google Live waits for turnComplete and preserves interruption status', () => {
  const protocol = createGoogleLiveProtocol()
  const started = protocol.normalizeIncoming({ serverContent: { modelTurn: { parts: [{ text: 'hello' }] } } })
  const responseId = started[0].response.id
  const generation = protocol.normalizeIncoming({ serverContent: { generationComplete: true } })
  assert.equal([generation].flat().some(event => event.type === 'response.done'), false)
  protocol.normalizeIncoming({ serverContent: { interrupted: true } })
  assert.deepEqual(protocol.normalizeIncoming({ serverContent: { turnComplete: true } }), [{
    type: 'response.done', response: { id: responseId, status: 'cancelled' },
  }])
})
