import assert from 'node:assert/strict'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { WebSocketServer } from 'ws'
import { config } from '../src/core/config.mjs'
import { dashscopeProvider } from '../src/voice/providers/dashscope.mjs'
import { RealtimeFrontend } from '../src/voice/realtime-provider.mjs'
import { DASHSCOPE_OMNI_38_FLASH_REALTIME_MODEL as MODEL } from '../../shared/realtime-model-catalog.mjs'

function configure(t) {
  const values = {
    audioModel: MODEL, audioVoice: '', dashscopeApiKey: 'test-key',
    audioRealtimeBaseUrl: 'wss://workspace.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime',
  }
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, config[key]]))
  Object.assign(config, values)
  t.after(() => Object.assign(config, previous))
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return
    await delay(10)
  }
  assert.fail('Timed out waiting for a protocol event')
}

// Local protocol fixture: no real model, microphone, or backend is used by CI.
async function harness(t) {
  configure(t)
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await once(server, 'listening')
  config.audioRealtimeBaseUrl = `ws://127.0.0.1:${server.address().port}/realtime`
  const received = [], events = [], errors = []
  let socket, connection
  const emit = event => socket.send(JSON.stringify(event))
  server.on('connection', (ws, request) => {
    socket = ws
    connection = request
    ws.on('message', raw => {
      const event = JSON.parse(raw)
      received.push(event)
      if (event.type === 'session.update') emit({ type: 'session.updated', session: event.session })
      if (event.type === 'conversation.item.create') {
        // Omni may assign its own item ID. Keep call_id/content intact.
        emit({ type: 'conversation.item.created', item: { ...event.item, id: `server-${received.length}` } })
      }
    })
    emit({ type: 'session.created' })
  })
  const frontend = new RealtimeFrontend({
    provider: dashscopeProvider, onEvent: event => events.push(event),
    onError: error => errors.push(error), responseStartTimeoutMs: 2000,
    responseCompletionTimeoutMs: 3000,
  })
  t.after(() => {
    frontend.close()
    for (const client of server.clients) client.terminate()
    server.close()
  })
  await frontend.connect()
  const reply = id => {
    emit({ type: 'response.created', response: { id, status: 'in_progress' } })
    emit({ type: 'response.audio.delta', response_id: id, delta: Buffer.alloc(480).toString('base64') })
    emit({ type: 'response.audio_transcript.done', response_id: id, transcript: '测试完成。' })
    emit({ type: 'response.done', response: { id, status: 'completed', output: [] } })
  }
  return { frontend, received, events, errors, emit, reply, connection }
}

test('3.8 configures nested PCM formats, Tina and semantic VAD only on initial setup', t => {
  configure(t)
  const session = dashscopeProvider.buildSession({ configured: false })
  assert.deepEqual(session.audio, {
    input: { format: { type: 'pcm', sample_rate: 16000 } },
    output: { format: { type: 'pcm', sample_rate: 24000 }, voice: 'Tina' },
  })
  assert.deepEqual(session.turn_detection, { type: 'semantic_vad' })
  assert.deepEqual(session.modalities, ['text', 'audio'])
  for (const key of ['voice', 'input_audio_format', 'output_audio_format']) assert.equal(key in session, false)
  assert.ok(session.tools.length)
  assert.ok(session.tools.every(tool => tool.type === 'function' && tool.function.parameters))
  config.audioVoice = 'custom-voice'
  assert.equal(dashscopeProvider.buildSession({ configured: false }).audio.output.voice, 'custom-voice')
  assert.equal(dashscopeProvider.buildSession({ configured: false, sessionOptions: { voice: 'session-voice' } }).audio.output.voice, 'session-voice')
  const refresh = dashscopeProvider.buildSession({ configured: true })
  assert.deepEqual(Object.keys(refresh).sort(), ['instructions', 'tools'])
})

test('3.8 rejects legacy public endpoints before connecting and allows workspace/proxy endpoints', async t => {
  configure(t)
  for (const host of ['dashscope.aliyuncs.com', 'dashscope-intl.aliyuncs.com', 'dashscope-us.aliyuncs.com']) {
    config.audioRealtimeBaseUrl = `wss://${host}/api-ws/v1/realtime`
    const frontend = new RealtimeFrontend({ provider: dashscopeProvider })
    await assert.rejects(frontend.connect(), /业务空间专属地址/)
    assert.equal(frontend.ws, null)
  }
  for (const url of ['wss://workspace.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime',
    'wss://workspace.ap-southeast-1.maas.aliyuncs.com/api-ws/v1/realtime', 'wss://proxy.example/realtime']) {
    config.audioRealtimeBaseUrl = url
    assert.doesNotThrow(() => dashscopeProvider.validateSessionOptions())
  }
  config.audioRealtimeBaseUrl = ''
  assert.throws(() => dashscopeProvider.validateSessionOptions(), /有效的.*WebSocket/)
})

test('3.8 handshake and audio replies use the existing DashScope transport', async t => {
  const h = await harness(t)
  assert.equal(new URL(h.connection.url, config.audioRealtimeBaseUrl).searchParams.get('model'), MODEL)
  assert.equal(h.connection.headers.authorization, 'Bearer test-key')
  const pending = h.frontend.sendUserText('你好')
  await waitFor(() => h.received.some(event => event.type === 'response.create'))
  h.reply('audio-response')
  assert.equal((await pending).completed, true)
  assert.equal(h.events.filter(event => event.type === 'response.audio.delta').length, 1)
  assert.equal(h.frontend.provider.outputSampleRate, 24000)
  assert.deepEqual(h.errors, [])
})

test('3.8 function result acknowledgement resumes exactly one audio response', async t => {
  const h = await harness(t)
  h.emit({ type: 'response.created', response: { id: 'tool-response' } })
  h.emit({ type: 'response.function_call_arguments.done', response_id: 'tool-response',
    call_id: 'opaque-call-id', name: 'spawn_thinking', arguments: '{"objective":"查询内存"}' })
  h.emit({ type: 'response.done', response: { id: 'tool-response', status: 'completed', output: [] } })
  await waitFor(() => h.events.some(event => event.type === 'response.done'))
  const call = h.events.find(event => event.type === 'response.function_call_arguments.done')
  const output = { status: 'accepted', task_id: '42' }
  const pending = h.frontend.sendFunctionOutput(call.call_id, output)
  await waitFor(() => h.received.some(event => event.type === 'response.create'))
  const itemIndex = h.received.findIndex(event => event.item?.type === 'function_call_output')
  assert.equal(h.received[itemIndex].item.call_id, call.call_id)
  assert.deepEqual(JSON.parse(h.received[itemIndex].item.output), output)
  assert.equal(h.received[itemIndex + 1].type, 'response.create')
  h.reply('tool-reply')
  assert.equal((await pending).completed, true)
  assert.equal(h.received.filter(event => event.type === 'response.create').length, 1)
  assert.deepEqual(h.errors, [])
})

test('3.8 retries a pending-response refusal without resending the function output or reconnecting', async t => {
  const h = await harness(t)
  const output = { status: 'accepted', task_id: '42' }
  const pending = h.frontend.sendFunctionOutput('call-busy', output)
  const responses = () => h.received.filter(event => event.type === 'response.create')
  await waitFor(() => responses().length === 1)
  h.emit({ type: 'error', error: {
    type: 'invalid_request_error',
    message: 'Conversation already has a pending response request',
  } })
  await waitFor(() => h.frontend.responseSlot.blocked)
  assert.equal(responses().length, 1)
  h.emit({ type: 'response.done', response: { id: 'server-pending', status: 'completed' } })
  await waitFor(() => responses().length === 2)
  h.reply('tool-retry')
  assert.equal((await pending).completed, true)
  assert.equal(h.events.find(event => event.type === 'error').__voiceRetried, true)
  assert.equal(h.events.filter(event => event.type === 'response.created').length, 1)
  assert.equal(h.received.filter(event => event.item?.type === 'function_call_output').length, 1)
  assert.equal(h.received.filter(event => event.type === 'session.update').length, 1)
  assert.deepEqual(h.errors, [])
})

test('3.8 backend result waits for active speech, then proactively generates one reply', async t => {
  const h = await harness(t)
  h.emit({ type: 'response.created', response: { id: 'speaking' } })
  await waitFor(() => h.frontend.activeResponses.has('speaking'))
  const text = 'task_id=42\n这台电脑安装了 24 GB 内存。'
  const pending = h.frontend.injectResult(text, 'announcement', { taskId: '42' })
  await delay(20)
  assert.equal(h.received.some(event => event.type === 'response.create'), false)
  h.emit({ type: 'response.done', response: { id: 'speaking', status: 'completed' } })
  await waitFor(() => h.received.some(event => event.type === 'response.create'))
  assert.equal(h.received.find(event => event.item?.type === 'message').item.content[0].text, text)
  assert.equal(h.received.find(event => event.type === 'response.create').response.tool_choice, 'none')
  h.reply('announcement')
  assert.equal((await pending).completed, true)
  const created = h.events.find(event => event.response?.id === 'announcement')
  assert.equal(created.__voiceOrigin, 'announcement')
  assert.equal(created.__voiceContext.taskId, '42')
  assert.equal(h.received.filter(event => event.type === 'response.create').length, 1)
  assert.deepEqual(h.errors, [])
})

test('3.8 exposes speech interruption events and supports cancel followed by another reply', async t => {
  const h = await harness(t)
  const pending = h.frontend.sendUserText('说个故事')
  await waitFor(() => h.received.some(event => event.type === 'response.create'))
  h.emit({ type: 'response.created', response: { id: 'interrupted' } })
  h.emit({ type: 'input_audio_buffer.speech_started', item_id: 'user-speech', audio_start_ms: 10 })
  await waitFor(() => h.events.some(event => event.type === 'input_audio_buffer.speech_started'))
  h.frontend.cancel()
  assert.equal((await pending).cancelled, true)
  await waitFor(() => h.received.some(event => event.type === 'response.cancel'))
  h.emit({ type: 'response.done', response: { id: 'interrupted', status: 'cancelled' } })
  const next = h.frontend.sendUserText('继续')
  await waitFor(() => h.received.filter(event => event.type === 'response.create').length === 2)
  h.reply('resumed')
  assert.equal((await next).completed, true)
  assert.equal(h.received.filter(event => event.type === 'response.cancel').length, 1)
  assert.deepEqual(h.errors, [])
})

test('3.8 primes video with silence when muted, without creating turns or responses', async t => {
  const h = await harness(t)
  assert.equal(h.frontend.appendImage('old-frame'), true)
  assert.equal(h.frontend.appendImage('latest-frame'), true)
  h.frontend.appendAudio(Buffer.alloc(3200).toString('base64'))
  await waitFor(() => h.received.filter(event => event.type === 'input_audio_buffer.append').length === 2)
  assert.deepEqual(h.received.map(event => event.type), [
    'session.update', 'input_audio_buffer.append', 'input_image_buffer.append',
    'input_image_buffer.append', 'input_audio_buffer.append',
  ])
  assert.equal(Buffer.from(h.received[1].audio, 'base64').length, 640)
  assert.equal(h.received[2].image, 'old-frame')
  assert.equal(h.received[3].image, 'latest-frame')
  assert.deepEqual(h.errors, [])
})

test('3.8 server-side VAD cancellation before speech_started does not send a redundant cancel', async t => {
  const h = await harness(t)
  const pending = h.frontend.sendUserText('说个故事')
  await waitFor(() => h.received.some(event => event.type === 'response.create'))
  h.emit({ type: 'response.created', response: { id: 'server-cancelled' } })
  h.emit({ type: 'response.done', response: { id: 'server-cancelled', status: 'cancelled' } })
  h.emit({ type: 'input_audio_buffer.speech_started', item_id: 'next-input', audio_start_ms: 10 })
  assert.equal((await pending).status, 'cancelled')
  await waitFor(() => h.events.some(event => event.type === 'input_audio_buffer.speech_started'))
  h.frontend.cancel()
  const next = h.frontend.sendUserText('现在继续')
  await waitFor(() => h.received.filter(event => event.type === 'response.create').length === 2)
  assert.equal(h.received.some(event => event.type === 'response.cancel'), false)
  h.reply('after-vad')
  assert.equal((await next).completed, true)
  assert.deepEqual(h.errors, [])
})
