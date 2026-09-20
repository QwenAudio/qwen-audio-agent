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
        async sendFunctionOutput(callId, result, settings) { this.outputs.push({ callId, result, settings }) },
        async injectDelivery(text, origin, context, settings) {
          if (settings.shouldRespond && !settings.shouldRespond()) return { completed: false }
          this.deliveries.push({ text, origin, context, settings })
          return { completed: true, contextInjected: true }
        },
        async appendUserInputContext() {}, async ensureResponse() {}, async whenIdle() {},
        emit: options.onEvent,
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
  await until(() => h.frontends.length === 2 && h.frontends[1].deliveries.length > 0)
  assert.equal(h.runs.size, 1)
  assert.equal(h.manager.get(task.id).status, 'running')
  assert.ok(h.events.some(event => event.reason === 'provider_content_safety'))
})
