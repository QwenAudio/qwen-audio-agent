import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import { WebSocketServer } from 'ws'
import { config } from '../src/core/config.mjs'
import { RealtimeFrontend } from '../src/voice/realtime-provider.mjs'
import { stepfunProvider } from '../src/voice/providers/stepfun.mjs'
import { createStepFunProtocol } from '../src/voice/providers/stepfun-protocol.mjs'
import { describeActiveRealtime, validateRealtimeProvider } from '../src/voice/providers/registry.mjs'
import { buildFrontendToolContext } from '../src/frontend/tools/frontend-tool-context.mjs'
import { isResponseActivityEvent } from '../src/voice/response-lifecycle.mjs'

function configure(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, config[key]]))
  Object.assign(config, values)
  t.after(() => Object.assign(config, previous))
}

test('StepFun owns its credentials, model, voice, and 24 kHz audio contract', t => {
  configure(t, {
    stepfunApiKey: 'step-test',
    stepfunRealtimeUrl: 'wss://api.stepfun.com/v1/realtime?model=old&region=test',
    stepfunModel: 'stepaudio-3-realtime-preview',
    stepfunVoice: '',
    audioVoice: 'qwen-only',
  })
  validateRealtimeProvider(stepfunProvider)
  assert.equal(new URL(stepfunProvider.url()).searchParams.getAll('model').length, 1)
  assert.equal(new URL(stepfunProvider.url()).searchParams.get('model'), 'stepaudio-3-realtime-preview')
  assert.equal(new URL(stepfunProvider.url()).searchParams.get('region'), 'test')
  assert.deepEqual(stepfunProvider.headers(), { Authorization: 'Bearer step-test' })
  assert.equal(stepfunProvider.inputSampleRate, 24000)
  assert.equal(stepfunProvider.outputSampleRate, 24000)
  assert.equal(stepfunProvider.capabilities.conversationItemIdEcho, false)
  assert.equal(describeActiveRealtime('stepfun').modelCapabilities.functionCalling, true)
  assert.equal(describeActiveRealtime('stepfun').transportCapabilities.imageBufferInput, false)

  const session = stepfunProvider.buildSession({ configured: false })
  assert.equal(session.input_audio_format, 'pcm16')
  assert.equal(session.output_audio_format, 'pcm16')
  assert.deepEqual(session.turn_detection, { type: 'server_vad' })
  assert.equal(Object.hasOwn(session, 'voice'), false)
  assert.equal(stepfunProvider.buildSession({
    configured: false, sessionOptions: { voice: 'custom-step-voice' },
  }).voice, 'custom-step-voice')
  assert.equal(Object.hasOwn(stepfunProvider.buildSession({
    configured: true, sessionOptions: { voice: 'custom-step-voice' },
  }), 'voice'), false)
})

test('registers only Gateway functions, including its own web search', () => {
  const agentContext = { frontend: buildFrontendToolContext({
    backendAvailability: { snapshot: () => ({ configured: true }) },
    frontendRetrieval: { capabilities: () => ['web-search', 'url-fetch'] },
  }) }
  const { tools } = stepfunProvider.buildSession({ configured: false, agentContext })
  assert.ok(tools.every(tool => tool.type === 'function'))
  const names = tools.map(tool => tool.function.name)
  for (const name of ['spawn_thinking', 'web_search', 'get_agent_task_status', 'cancel_agent_task']) {
    assert.ok(names.includes(name), name)
  }
})

test('classifies an already-finished cancellation as benign, not a service failure', () => {
  for (const message of [
    'invalid_request_error: no ongoing response to cancel',
    'No active response found',
    'no response available to cancel',
  ]) {
    assert.equal(stepfunProvider.classifyError(message), 'no_active_response')
  }
  assert.equal(stepfunProvider.classifyError('invalid input_audio_format'), 'other')
})

test('normalizes thinking and cancellation without leaking connection state', () => {
  const protocol = createStepFunProtocol()
  protocol.normalizeIncoming({ type: 'response.created', response: { id: 'r1' } })
  const thinking = protocol.normalizeIncoming({
    type: 'response.thinking.delta', delta: 'internal thinking',
  })
  assert.deepEqual(thinking, { type: 'response.activity', response_id: 'r1' })
  assert.equal(isResponseActivityEvent(thinking), true)
  assert.equal(protocol.normalizeIncoming({
    type: 'response.function_call_arguments.done', name: 'spawn_thinking',
    call_id: 'call1', arguments: '{}',
  }).response_id, 'r1')
  assert.deepEqual(protocol.normalizeIncoming({ type: 'response.cancelled' }), {
    type: 'response.done', response: { id: 'r1', status: 'cancelled' },
  })
  assert.equal(protocol.normalizeIncoming({ type: 'response.cancelled' }), null)
  assert.equal(createStepFunProtocol().normalizeIncoming({ type: 'response.cancelled' }), null)
})

test('thinking activity refreshes the shared inactivity watchdog', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const frontend = new RealtimeFrontend({
    provider: stepfunProvider, responseInactivityTimeoutMs: 100,
  })
  t.after(() => frontend.close())
  frontend.ready = true
  frontend.send = () => {}
  const pending = frontend.ensureResponse()
  await new Promise(resolve => setImmediate(resolve))
  frontend.handleProviderEvent({ type: 'response.created', response: { id: 'thinking1' } })
  for (let index = 0; index < 4; index++) {
    t.mock.timers.tick(80)
    frontend.handleProviderEvent({ type: 'response.thinking.delta', response_id: 'thinking1', delta: 'private' })
  }
  frontend.handleProviderEvent({ type: 'response.done', response: { id: 'thinking1', status: 'completed' } })
  assert.deepEqual(await pending, { completed: true, responseId: 'thinking1' })
})

test('runs text, tool output, delivery, permission, and cancellation through a WebSocket', { timeout: 10000 }, async t => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await once(server, 'listening')
  t.after(() => new Promise(resolve => {
    for (const client of server.clients) client.terminate()
    server.close(resolve)
  }))
  configure(t, {
    stepfunApiKey: 'step-test',
    stepfunRealtimeUrl: `ws://127.0.0.1:${server.address().port}/v1/realtime`,
    stepfunModel: 'stepaudio-3-realtime-preview',
    stepfunVoice: '',
  })
  const outgoing = []
  const incoming = []
  const errors = []
  const heldResponse = Promise.withResolvers()
  let responseNumber = 0
  let mode = 'complete'
  let activeId = ''
  let peer
  const send = event => peer.send(JSON.stringify(event))
  server.on('connection', (ws, request) => {
    peer = ws
    assert.equal(request.headers.authorization, 'Bearer step-test')
    ws.on('message', raw => {
      const event = JSON.parse(raw)
      outgoing.push(event)
      if (event.type === 'session.update') send({ type: 'session.updated', session: event.session })
      if (event.type === 'conversation.item.create') {
        send({ type: 'conversation.item.created', item: { ...event.item, id: `server_${event.item.id}` } })
      }
      if (event.type === 'response.create') {
        assert.ok(!event.response || Object.keys(event.response).every(key => key === 'modalities'))
        activeId = `response_${++responseNumber}`
        send({ type: 'response.created', response: { id: activeId, status: 'in_progress' } })
        if (mode === 'hold') return
        if (mode === 'tool') {
          send({ type: 'response.function_call_arguments.done', call_id: 'call1',
            name: 'spawn_thinking', arguments: '{"objective":"check project"}' })
        } else {
          send({ type: 'response.audio.delta', delta: 'AAAAAA==' })
        }
        send({ type: 'response.done', response: { id: activeId, status: 'completed', output: [] } })
      }
      if (event.type === 'response.cancel') send({ type: 'response.cancelled', response_id: activeId })
    })
    send({ type: 'session.created', session: { id: 'session1' } })
  })
  const frontend = new RealtimeFrontend({
    provider: stepfunProvider,
    onEvent: event => {
      incoming.push(event)
      if (mode === 'hold' && event.type === 'response.created') heldResponse.resolve()
    },
    onError: error => errors.push(error),
    responseStartTimeoutMs: 1000,
  })
  t.after(() => frontend.close())
  await frontend.connect()
  assert.equal(frontend.ready, true)
  frontend.appendAudio('AAAAAA==')
  assert.equal((await frontend.sendUserText('你好')).completed, true)
  assert.ok(outgoing.some(event => event.type === 'input_audio_buffer.append'))
  assert.ok(incoming.some(event => event.type === 'response.audio.delta'))

  mode = 'tool'
  await frontend.sendUserText('检查项目')
  const call = incoming.find(event => event.type === 'response.function_call_arguments.done')
  assert.equal(call.response_id, 'response_2')
  mode = 'complete'
  await frontend.sendFunctionOutput(call.call_id, { status: 'started', work_id: 'work1' }, {}, { createResponse: false })
  assert.equal(responseNumber, 2)
  assert.equal((await frontend.ensureResponse({}, { response: { instructions: '请确认已经提交' } })).completed, true)

  const beforeDelivery = outgoing.length
  assert.equal((await frontend.injectDelivery('项目检查通过', 'announcement', {}, {
    instructions: '简短播报检查结果',
  })).completed, true)
  const deliveryEvents = outgoing.slice(beforeDelivery)
  assert.deepEqual(deliveryEvents.map(event => event.type), [
    'conversation.item.create', 'conversation.item.create', 'response.create',
  ])
  assert.equal(deliveryEvents[0].item.content[0].text, '项目检查通过')
  assert.equal(deliveryEvents[1].item.content[0].text, '简短播报检查结果')
  assert.equal((await frontend.speak('你好，欢迎回来')).completed, true)
  assert.equal((await frontend.injectPermission({ id: 'p1', taskId: 'work1', summary: '修改文件' })).completed, true)
  assert.ok(outgoing.some(event => event.item?.content?.[0]?.text?.includes('permission_id=p1')))

  mode = 'hold'
  const pending = frontend.speak('等待测试取消')
  await heldResponse.promise
  frontend.cancel()
  assert.equal((await pending).cancelled, true)
  await frontend.whenIdle()
  assert.ok(incoming.some(event => event.type === 'response.done' && event.response.status === 'cancelled'))
  mode = 'complete'
  assert.equal((await frontend.speak('取消后继续')).completed, true)
  assert.deepEqual(errors, [])
})
