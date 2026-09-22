import assert from 'node:assert/strict'
import test from 'node:test'
import { createRealtimeSessionRuntime } from '../src/voice/realtime-session-runtime.mjs'
import { SessionObservers } from '../src/voice/session-observers.mjs'
import { InputAssetRegistry } from '../src/voice/input-asset-registry.mjs'
import { createTaskAnnouncementRuntime } from '../src/voice/announcement/task-announcement-runtime.mjs'
import { ConversationSync } from '../src/conversation/conversation-sync.mjs'
import { TaskManager } from '../src/task/task-manager.mjs'
import { TaskOperations } from '../src/orchestration/task-operations.mjs'
import { clientActionCapabilities, ClientActionName } from '../src/client/client-action-port.mjs'
import { GatewayClientEvent as Input } from '../../shared/protocol/realtime-events.mjs'
import { GatewayEventRouter } from '../src/client/client-event-router.mjs'
import { desktopClientTools } from '../../web/src/desktop/client-tools.js'

const tick = () => new Promise(resolve => setImmediate(resolve))
async function until(predicate) {
  const deadline = Date.now() + 2000
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'runtime condition timed out')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

function harness(t, { backend = true, ...overrides } = {}) {
  const ownerId = 'runtime-owner', sessionId = 'conversation'
  const events = [], frontends = [], tasks = [], observations = [], done = []
  const runs = new Map(), memoryListeners = new Set()
  const manager = new TaskManager()
  const conversationSync = new ConversationSync()
  const logger = { info() {}, warn() {}, error() {}, debug() {} }
  const provider = {
    key: 'test', label: 'Test', inputSampleRate: 16000, outputSampleRate: 24000,
    capabilities: { sessionOutputVoice: true },
    classifyError: message => message === 'input busy' ? 'input_busy'
      : message === 'unsafe' ? 'content_safety' : 'other',
  }
  const backendRuntime = {
    run: (_input, execution) => new Promise((resolve, reject) => {
      runs.set(execution.taskId, { ...execution, resolve })
      execution.signal.addEventListener('abort', () => reject(execution.signal.reason), { once: true })
    }),
    cancel: async () => ({ layer: 'backend', state: 'cancelled' }),
  }
  const operations = new TaskOperations({ taskManager: manager, backendRuntime })
  let active = false
  const runtime = createRealtimeSessionRuntime({
    ownerId, sessionId, logger, taskManager: manager, taskOperations: operations,
    backendRuntime, backendAvailability: { snapshot: () => ({ configured: backend, ok: backend, known: true }) },
    send: event => events.push(event), onTaskEvent: event => tasks.push(event),
    onResponseDone: event => done.push(event),
    observers: new SessionObservers([{
      onAudio: event => observations.push(event),
      onSessionClosed: event => observations.push({ ...event, closed: true }),
    }]),
    voiceAccess: {
      isActive: () => active,
      claim: () => { active = true; return { granted: true } },
      release: () => { const wasActive = active; active = false; return wasActive },
      changed() {},
    },
    actionCapabilities: clientActionCapabilities(),
    frontendToolSources: [],
    memoryService: {
      list: () => [{ id: 'memory-1', content: 'test preference' }],
      subscribe(listener) { memoryListeners.add(listener); return () => memoryListeners.delete(listener) },
    },
    inputAssets: new InputAssetRegistry(), conversationSync,
    config: { sleepTimeoutMs: 0, announcementQuietMs: 0, announcementBatchMs: 0, taskNotificationClaimTtlMs: 60000 },
    realtimeProviderRegistry: { resolve: () => provider }, defaultRealtimeProvider: 'test',
    taskAnnouncementFactory: createTaskAnnouncementRuntime,
    realtimeFrontendFactory: options => {
      const f = {
        provider, ready: false, inputs: [], audio: [], images: [], outputs: [], deliveries: [], updates: [], cancels: 0,
        initialContext: options.agentContext, sessionOptions: options.sessionOptions,
        async connect() { this.ready = true },
        close() { this.ready = false },
        cancel() { this.cancels++ }, cancelResponses() {}, clearPendingImage() {},
        appendAudio(value) { this.audio.push(value) },
        appendImage(value) { this.images.push(value) },
        updateAgentContext(context, settings) { this.updates.push({ context, settings }) },
        async sendUserInput(parts, context) { this.inputs.push({ parts, context }); return {} },
        async sendFunctionOutput(callId, result, context, settings) { this.outputs.push({ callId, result, context, settings }) },
        async injectDelivery(text, origin, context, settings) {
          if (settings.shouldRespond && !settings.shouldRespond()) return { completed: false }
          this.deliveries.push({ text, origin, context, settings })
          return { completed: true, contextInjected: true }
        },
        async appendUserInputContext() {}, async ensureResponse() {}, async whenIdle() {},
        emit: options.onEvent,
        settle: options.onResponseSettled,
        disconnect() { this.ready = false; options.onClose() },
      }
      frontends.push(f)
      return f
    },
    ...overrides,
  })
  const send = (event, options) => runtime.handleClientEvent(event, options)
  const connect = async (options = {}) => {
    runtime.start()
    send({ type: Input.CONNECT, inputEnabled: true, outputEnabled: true, ...options }, {
      descriptor: { type: 'test', instanceId: 'instance' }, capabilities: [],
    })
    await until(() => runtime.status().state === 'connected')
    return frontends.at(-1)
  }
  const request = objective => operations.submit({ objective }, { ownerId, sessionId })
  t.after(async () => {
    runtime.close()
    await Promise.all(manager.list({ active: true }).map(task => operations.cancel(task.id, { ownerId })))
  })
  return { runtime, send, connect, request, manager, operations, events, frontends, runs, tasks, observations,
    done, memoryListeners, provider, conversationSync, ownerId, sessionId }
}

test('frontend runtime chats without backend, socket, handshake or provider network', async t => {
  const h = harness(t, { backend: false })
  const f = await h.connect()
  assert.equal(f.initialContext.frontend.backendConfigured, false)
  h.send({ type: Input.TEXT_MESSAGE, text: 'hello' })
  await until(() => f.inputs.length === 1)
  f.emit({ type: 'response.created', response: { id: 'reply' } })
  f.emit({ type: 'response.audio_transcript.done', response_id: 'reply', transcript: 'hello back' })
  f.emit({ type: 'response.done', response: { id: 'reply', status: 'completed' } })
  assert.ok(h.events.some(event => event.type === 'transcript.final' && event.content === 'hello back'))
  assert.deepEqual(h.done, [{ id: 'reply', status: 'completed' }])
  assert.equal(h.manager.list({}).length, 0)
})

test('spawn receipt is asynchronous; ongoing work does not prevent further chat, interruption or close', async t => {
  const h = harness(t)
  const f = await h.connect()
  h.send({ type: Input.TEXT_MESSAGE, text: 'read memory' })
  await until(() => f.inputs.length === 1)
  f.emit({ type: 'response.created', response: { id: 'spawn-response' } })
  f.emit({ type: 'response.function_call_arguments.done', response_id: 'spawn-response',
    call_id: 'spawn-call', name: 'spawn_thinking', arguments: '{"objective":"read memory"}' })
  await until(() => f.outputs.length === 1)
  const receipt = f.outputs[0].result
  assert.equal(receipt.status, 'accepted')
  assert.match(receipt.task_id, /^task_\d+$/u)
  await until(() => h.runs.has(receipt.task_id))
  f.emit({ type: 'response.done', response: { id: 'spawn-response', status: 'completed' } })
  h.send({ type: Input.TEXT_MESSAGE, text: 'how are you?' })
  await until(() => f.inputs.length === 2)
  h.send({ type: Input.INTERRUPT })
  h.runtime.close()
  assert.equal(h.manager.get(receipt.task_id).status, 'running')
  assert.equal(h.runs.get(receipt.task_id).signal.aborted, false)
  const sent = h.events.length
  f.emit({ type: 'response.function_call_arguments.done', call_id: 'late', name: 'spawn_thinking', arguments: '{"objective":"late"}' })
  h.runs.get(receipt.task_id).resolve({ content: '24 GB' })
  await h.manager.wait(receipt.task_id)
  await tick()
  assert.equal(h.manager.list({}).length, 1, 'late provider events cannot create work after close')
  assert.equal(h.manager.get(receipt.task_id).notificationStatus, 'pending')
  assert.equal(h.events.length, sent)
})

test('microphone mute and host suspension do not close the model or cancel work', async t => {
  const h = harness(t)
  const f = await h.connect()
  const task = h.request('work')
  await until(() => h.runs.has(task.id))
  h.send({ type: Input.AUDIO_APPEND, audio: 'first' })
  h.send({ type: Input.INPUT_MUTE })
  h.send({ type: Input.AUDIO_APPEND, audio: 'muted' })
  h.send({ type: Input.INPUT_UNMUTE })
  h.runtime.applyInputSuspension({ suspended: true, owner: 'recorder' })
  h.send({ type: Input.AUDIO_APPEND, audio: 'suspended' })
  h.runtime.applyInputSuspension({ suspended: false })
  h.send({ type: Input.AUDIO_APPEND, audio: 'resumed' })
  assert.deepEqual(f.audio, ['first', 'resumed'])
  assert.equal(f.ready, true)
  assert.equal(h.manager.get(task.id).status, 'running')
  h.operations.cancel(task.id, { ownerId: h.ownerId })
  await h.manager.wait(task.id)
  assert.equal(h.manager.get(task.id).status, 'cancelled', 'only explicit Task cancellation stops work')
})

test('image buffering does not infer client state; only explicit environment events update context', async t => {
  const h = harness(t)
  const f = await h.connect({ inputEnabled: false })
  const frame = { type: Input.IMAGE_APPEND, image: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64') }
  h.send({ type: Input.IMAGE_APPEND, image: 'invalid-frame' })
  await tick()
  assert.equal(f.deliveries.length, 0, 'invalid frames must not announce active vision')
  h.send(frame)
  await tick()
  assert.equal(f.images.length, 1)
  assert.equal(f.audio.length, 0)
  assert.equal(f.deliveries.length, 0, 'a frame is not an environment state event')
  const router = new GatewayEventRouter()
  const publish = async state => {
    const result = await router.publish({
      event_id: `visual-${state}`, text: state === 'active' ? '已开启实时视觉输入' : '已停止实时视觉输入，当前无法看到新的画面',
    })
    h.runtime.handleClientDelivery(result)
    await tick()
  }
  await publish('active')
  assert.match(f.deliveries[0].text, /已开启实时视觉输入/)
  h.send({ type: Input.INPUT_MUTE })
  await tick()
  assert.equal(f.deliveries.length, 1, 'muting audio must not stop vision')
  h.send({ type: Input.IMAGE_CLEAR })
  h.send({ type: Input.IMAGE_CLEAR })
  await tick()
  assert.equal(f.deliveries.length, 1, 'clearing a buffer must not report camera shutdown')
  await publish('inactive')
  assert.equal(f.deliveries.length, 2)
  assert.match(f.deliveries[1].text, /已停止实时视觉输入/)
  assert.ok(f.deliveries.every(value => value.settings.route === 'context'))
  assert.equal(f.cancels, 0)
  h.send(frame)
  await tick()
  assert.equal(f.images.length, 2)
  assert.equal(f.deliveries.length, 2, 'new frames do not substitute for explicit state changes')
  h.runtime.applyInputSuspension({ suspended: true, owner: 'test' })
  h.send(frame)
  await tick()
  assert.equal(f.images.length, 2, 'host suspension still gates camera frames')
  assert.equal(f.deliveries.length, 2)
})

test('a tool continuation ending without a response releases the permission announcement window', async t => {
  const h = harness(t)
  const f = await h.connect()
  f.emit({ type: 'input_audio_buffer.speech_started', item_id: 'input-pending' })
  f.emit({ type: 'input_audio_buffer.speech_stopped', item_id: 'input-pending' })
  const turnId = h.events.findLast(event => event.type === 'turn.started').turnId
  const task = h.request('read file')
  await until(() => h.runs.has(task.id))
  h.runs.get(task.id).onEvent({ type: 'backend.permission.requested', permission: {
    id: 'auth-pending', status: 'pending', summary: 'read a file',
  } })
  await tick()
  assert.equal(f.deliveries.some(delivery => delivery.origin === 'permission'), false)
  f.settle({ origin: 'agent', context: { turnId }, outcome: { timedOut: true, phase: 'start' } })
  await until(() => f.deliveries.some(delivery => delivery.origin === 'permission'))
})

test('pending permission tool exposure and input-busy retry use the production coordinator', async t => {
  const h = harness(t)
  const f = await h.connect()
  const task = h.request('read file')
  await until(() => h.runs.has(task.id))
  h.runs.get(task.id).onEvent({ type: 'backend.permission.requested', permission: {
    id: 'auth_1', status: 'pending', summary: 'read a file',
  } })
  await until(() => f.deliveries.some(delivery => delivery.origin === 'permission'))
  assert.ok(f.updates.at(-1).context.frontend.capabilities.includes('permission.respond'))
  assert.doesNotThrow(() => f.emit({ type: 'error', __voiceOrigin: 'permission', error: { message: 'input busy' } }))
  assert.equal(h.manager.get(task.id).authorization.status, 'pending')
  assert.ok(!h.events.some(event => event.type === 'error'))
  h.runs.get(task.id).onEvent({ type: 'backend.permission.resolved', permission: { id: 'auth_1', status: 'approved' } })
  assert.equal(h.manager.get(task.id).authorization, null)
})

test('a transport reconnect restores an unresolved permission without restarting backend work', async t => {
  const h = harness(t)
  const f = await h.connect()
  const task = h.request('read memory')
  await until(() => h.runs.has(task.id))
  h.runs.get(task.id).onEvent({ type: 'backend.permission.requested', permission: {
    id: 'auth-reconnect', status: 'pending', summary: 'read memory',
  } })
  await until(() => f.deliveries.some(delivery => delivery.origin === 'permission'))
  const old = f.deliveries.find(delivery => delivery.origin === 'permission')
  f.disconnect()
  assert.equal(old.settings.shouldRespond(), false)
  await until(() => h.frontends.length === 2 && h.frontends[1].deliveries.some(delivery => delivery.origin === 'permission'))
  assert.ok(h.frontends[1].initialContext.frontend.capabilities.includes('permission.respond'))
  assert.equal(h.manager.get(task.id).authorization.status, 'pending')
  assert.equal(h.runs.size, 1)
})

test('deactivation receives only holder metadata and stops frontend activity, not backend work', async t => {
  const h = harness(t)
  const f = await h.connect()
  const task = h.request('keep working')
  await until(() => h.runs.has(task.id))
  const holder = { type: 'mobile', instanceId: 'replacement' }
  h.runtime.deactivate(holder)
  assert.equal(f.ready, false)
  assert.equal(h.runtime.status().state, 'disconnected')
  assert.deepEqual(h.events.find(event => event.type === 'voice.deactivated').holder, holder)
  h.send({ type: Input.AUDIO_APPEND, audio: 'inactive' })
  assert.deepEqual(f.audio, [])
  assert.equal(h.runs.get(task.id).signal.aborted, false)
  h.runtime.close()
  assert.equal(h.manager.get(task.id).status, 'running')
})

test('runtime-owned context/profile/voice updates stay isolated across connections', async t => {
  const h = harness(t), other = harness(t)
  const f = await h.connect(), otherFrontend = await other.connect()
  h.runtime.setAssistantProfile('brief answers')
  assert.equal(f.updates.at(-1).context.assistantProfile, 'brief answers')
  assert.equal(otherFrontend.updates.length, 0)
  for (const listener of h.memoryListeners) listener({ ownerId: h.ownerId, sessionId: 'other', source: 'client' })
  assert.equal(f.updates.at(-1).settings.refreshSession, true)
  const voice = h.runtime.updateOutputVoice('new-voice')
  assert.equal(voice.reconnecting, true)
  await until(() => h.frontends.length === 2 && h.runtime.status().state === 'connected')
  assert.equal(h.frontends[1].sessionOptions.voice, 'new-voice')
  assert.equal(h.frontends[1].initialContext.assistantProfile, 'brief answers')
  assert.equal(other.frontends.length, 1)
  h.runtime.close()
  h.runtime.close()
  assert.equal(h.memoryListeners.size, 0)
  assert.equal(h.observations.filter(event => event.closed).length, 1)
  assert.equal(otherFrontend.ready, true)
})

test('client sleep actions retain the model session and wake without rebuilding it', async t => {
  const h = harness(t)
  const f = await h.connect()
  h.send({ type: Input.CONNECT, inputEnabled: true, outputEnabled: true }, {
    descriptor: { type: 'desktop', instanceId: 'desktop' },
    capabilities: [clientActionCapabilities()[ClientActionName.ENTER_SLEEP]],
  })
  await tick()
  h.send({ type: Input.SLEEP })
  await until(() => h.events.some(event => event.type === 'client.action.request'))
  const action = h.events.find(event => event.type === 'client.action.request')
  assert.equal(h.runtime.receiveActionResult({ type: 'client.action.result', event_id: 'sleep-done',
    request_event_id: action.event_id, name: action.name, status: 'completed', output: {} }), true)
  await until(() => h.runtime.status().state === 'sleeping')
  assert.equal(f.ready, true)
  h.send({ type: Input.AUDIO_APPEND, audio: 'asleep' })
  assert.equal(f.audio.length, 0)
  h.send({ type: Input.WAKE })
  assert.equal(h.runtime.status().state, 'connected')
  assert.equal(h.frontends.length, 1)
})

test('client-owned sleep tool forwards once, records success silently, and presence gates input independently', async t => {
  const h = harness(t)
  h.runtime.start()
  h.send({ type: Input.CONNECT, inputEnabled: true, outputEnabled: true, clientTools: desktopClientTools }, {
    descriptor: { type: 'desktop', instanceId: 'desktop' }, capabilities: ['client.tools', 'client.presence'],
  })
  await until(() => h.frontends.length === 1 && h.runtime.status().state === 'connected')
  const f = h.frontends[0]
  assert.equal(f.initialContext.frontend.tools[0].function.name, 'enter_sleep')
  h.send({ type: Input.TEXT_MESSAGE, text: '请休息' })
  await until(() => f.inputs.length === 1)
  f.emit({ type: 'response.created', response: { id: 'sleep-response' } })
  f.emit({ type: 'response.function_call_arguments.done', response_id: 'sleep-response',
    call_id: 'sleep-call', name: 'enter_sleep', arguments: '{}' })
  await until(() => h.events.some(event => event.type === 'client.action.request'))
  const action = h.events.find(event => event.type === 'client.action.request')
  assert.equal(action.name, 'client.tool.enter_sleep')
  assert.equal(h.runtime.status().state, 'connected', 'a request is not a successful operation')
  h.runtime.receiveActionResult({ type: 'client.action.result', event_id: 'sleep-result',
    request_event_id: action.event_id, status: 'completed', output: { state: 'hidden' } })
  await until(() => f.outputs.length === 1)
  assert.equal(f.outputs[0].settings.createResponse, false)
  h.runtime.updateClientPresence('sleeping')
  assert.equal(h.runtime.status().state, 'sleeping')
  h.send({ type: Input.AUDIO_APPEND, audio: 'asleep' })
  assert.deepEqual(f.audio, [])
  assert.equal(f.ready, true)
  const notice = await new GatewayEventRouter().publish({ event_id: 'sleep-info', text: '客户端已休眠。' })
  h.runtime.handleClientDelivery(notice)
  await tick()
  assert.match(f.deliveries.at(-1).text, /客户端已休眠/)
  h.runtime.updateClientPresence('active')
  assert.equal(h.runtime.status().state, 'connected')
  assert.equal(h.frontends.length, 1)
  assert.equal(h.events.filter(event => event.type === 'client.action.request').length, 1)
})

test('closing before tool discovery or inactivity timeout cannot start a new model or action', async t => {
  let ready
  const h = harness(t, { frontendToolSourcesReady: new Promise(resolve => { ready = resolve }) })
  h.runtime.start()
  h.send({ type: Input.CONNECT, outputEnabled: true })
  h.runtime.handleClientDelivery({ name: 'desktop.presence.sleep_requested' })
  h.runtime.close()
  ready()
  const count = h.events.length
  await new Promise(resolve => setTimeout(resolve, 120))
  assert.equal(h.frontends.length, 0)
  assert.equal(h.events.length, count)
})

test('content-safety reconnect recovers frontend context without rerunning backend work', async t => {
  const h = harness(t)
  const f = await h.connect()
  const task = h.request('continue working')
  await until(() => h.runs.has(task.id))
  f.emit({ type: 'error', error: { message: 'unsafe' } })
  assert.equal(h.events.some(event => event.message?.includes('已自动恢复')), false)
  await until(() => h.frontends.length === 2 && h.frontends[1].deliveries.length > 0)
  assert.equal(h.runs.size, 1)
  assert.equal(h.manager.get(task.id).status, 'running')
  assert.ok(h.events.some(event => event.reason === 'provider_content_safety'))
  assert.ok(h.events.some(event => event.message?.includes('已自动恢复')))
})

test('rejected restoration quarantines only replay context and stops repeated reconnects', async t => {
  const h = harness(t)
  h.conversationSync.restore({ ownerId: h.ownerId, sessionId: h.sessionId, messages: [
    { id: 'u1', role: 'user', source: 'text-user', content: 'previous question' },
    { id: 'a1', role: 'assistant', source: 'realtime-direct', content: 'previous answer' },
  ] })
  const first = await h.connect()
  assert.equal(first.initialContext.recentMessages.length, 2)
  first.emit({ type: 'error', __voiceOrigin: 'restore', error: { message: 'unsafe' } })
  await until(() => h.frontends.length === 2)
  assert.deepEqual(h.frontends[1].initialContext.recentMessages, [])
  assert.equal(h.conversationSync.frontendContext(h).length, 2)
  h.frontends[1].emit({ type: 'error', error: { message: 'unsafe' } })
  await until(() => h.frontends.length === 3)
  h.frontends[2].emit({ type: 'error', error: { message: 'unsafe' } })
  assert.equal(h.runtime.status().state, 'unavailable')
  // Even incoming microphone data and late errors cannot reopen a blocked session.
  first.emit({ type: 'error', error: { message: 'unsafe' } })
  h.send({ type: Input.AUDIO_APPEND, audio: 'AAAA' })
  await new Promise(resolve => setTimeout(resolve, 600))
  assert.equal(h.frontends.length, 3)
  assert.ok(h.events.some(e => e.message?.includes('自动恢复已停止')))
})
