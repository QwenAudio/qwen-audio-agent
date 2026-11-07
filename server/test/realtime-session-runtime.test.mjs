import assert from 'node:assert/strict'
import test from 'node:test'
import { createRealtimeSessionRuntime, permissionResponseGate } from '../src/voice/realtime-session-runtime.mjs'
import { RealtimeFrontend, REALTIME_PROVIDERS } from '../src/voice/realtime-provider.mjs'
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

function harness(t, {
  backend = true, ownerId = 'runtime-owner', sessionId = 'conversation',
  taskManager = new TaskManager(), ...overrides
} = {}) {
  const events = [], frontends = [], tasks = [], observations = [], done = []
  const runs = new Map(), memoryListeners = new Set()
  const manager = taskManager
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
  const connect = async (options = {}, protocol = {}) => {
    runtime.start()
    send({ type: Input.CONNECT, inputEnabled: true, outputEnabled: true, ...options }, {
      descriptor: { type: 'test', instanceId: 'instance' }, capabilities: [],
      ...protocol,
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

test('negotiated receipt-less audio keeps result notifications pending while tasks and conversation work', async t => {
  const h = harness(t)
  const f = await h.connect({}, { capabilitiesNegotiated: true, capabilities: ['input.audio', 'input.text'] })
  h.send({ type: Input.TEXT_MESSAGE, text: 'hello' })
  await until(() => f.inputs.length === 1)
  f.emit({ type: 'response.created', response: { id: 'r' } })
  f.emit({ type: 'response.audio.delta', response_id: 'r', delta: 'AAA=' })
  f.emit({ type: 'response.audio_transcript.done', response_id: 'r', transcript: 'hello there' })
  f.emit({ type: 'response.done', response: { id: 'r', status: 'completed' } })
  assert.equal(h.events.find(e => e.type === 'transcript.final' && e.role === 'assistant').content, 'hello there')
  const task = h.request('background work')
  await until(() => h.runs.has(task.id))
  h.runs.get(task.id).resolve({ content: 'completed work' })
  await h.manager.wait(task.id)
  await tick()
  assert.equal(h.manager.get(task.id).status, 'completed')
  assert.equal(h.manager.get(task.id).notificationStatus, 'pending')
  assert.equal(f.deliveries.some(d => d.origin === 'announcement'), false)
  assert.ok(h.tasks.some(e => e.task?.id === task.id))
  assert.ok(h.conversationSync.frontendContext({ ownerId: h.ownerId, sessionId: h.sessionId })
    .some(message => message.content === 'hello there'))
})

test('negotiated text-only clients still receive and confirm task notifications without audio receipts', async t => {
  const h = harness(t)
  const f = await h.connect({ textOnly: true, inputEnabled: false }, {
    capabilitiesNegotiated: true, capabilities: ['input.text'],
  })
  const task = h.request('text-only work')
  await until(() => h.runs.has(task.id))
  h.runs.get(task.id).resolve({ content: 'text result' })
  await h.manager.wait(task.id)
  await until(() => f.deliveries.some(d => d.origin === 'announcement'))
  const delivery = f.deliveries.find(d => d.origin === 'announcement')
  f.emit({ type: 'response.created', response: { id: 'text-result' },
    __voiceOrigin: delivery.origin, __voiceContext: delivery.context })
  f.emit({ type: 'response.text.done', response_id: 'text-result', text: 'text result' })
  f.emit({ type: 'response.done', response: { id: 'text-result', status: 'completed' } })
  assert.equal(h.manager.get(task.id).notificationStatus, 'delivered')
})

test('invalid speech releases a completed task without another user turn', async t => {
  const h = harness(t)
  const f = await h.connect()
  const task = h.request('diagnostic work')
  await until(() => h.runs.has(task.id))
  f.emit({ type: 'input_audio_buffer.speech_started', item_id: 'noise' })
  f.emit({ type: 'input_audio_buffer.speech_stopped', item_id: 'noise', reason: 'turn_invalid' })
  h.runs.get(task.id).resolve({ content: 'diagnostic result' })
  await h.manager.wait(task.id)
  assert.equal(h.events.findLast(e => e.type === 'voice.state').state, 'idle')
  await until(() => f.deliveries.some(d => d.origin === 'announcement'))
})

test('a turn the reply watchdog gives up on no longer holds Gateway requests', async t => {
  const h = harness(t)
  h.provider.responseStartTimeoutMs = 20
  const f = await h.connect()
  const task = h.request('diagnostic work')
  await until(() => h.runs.has(task.id))
  f.emit({ type: 'input_audio_buffer.speech_started', item_id: 'unanswered' })
  f.emit({ type: 'input_audio_buffer.speech_stopped', item_id: 'unanswered' })
  await until(() => h.frontends.length === 2 && h.frontends[1].ready)
  h.runs.get(task.id).resolve({ content: 'diagnostic result' })
  await h.manager.wait(task.id)
  await until(() => h.frontends[1].deliveries.some(d => d.origin === 'announcement'))
})

test('interruption clears old audio without requiring a client cancellation receipt', async t => {
  const h = harness(t)
  const f = await h.connect()
  const task = h.request('diagnostic work')
  await until(() => h.runs.has(task.id))
  h.send({ type: Input.TEXT_MESSAGE, text: 'hello' })
  await until(() => f.inputs.length === 1)
  f.emit({ type: 'response.created', response: { id: 'old-audio' } })
  f.emit({ type: 'response.audio.delta', response_id: 'old-audio', delta: 'AAA=', sampleRate: 24000 })
  f.emit({ type: 'response.done', response: { id: 'old-audio', status: 'completed' } })
  h.runs.get(task.id).resolve({ content: 'diagnostic result' })
  await h.manager.wait(task.id)
  // Generation completion is not playback completion: keep waiting normally.
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(f.deliveries.length, 0)
  assert.equal(h.manager.get(task.id).notificationStatus, 'delivering')
  h.send({ type: Input.INTERRUPT })
  assert.equal(h.events.at(-1).type, 'playback.clear')
  await until(() => f.deliveries.some(d => d.origin === 'announcement'))
})

for (const sourceDoneFirst of [false, true]) {
  test(`tool output failure releases task delivery (source done first: ${sourceDoneFirst})`, async t => {
    const h = harness(t)
    const f = await h.connect()
    let rejectOutput
    f.sendFunctionOutput = () => new Promise((_resolve, reject) => { rejectOutput = reject })
    h.send({ type: Input.TEXT_MESSAGE, text: 'run a background task' })
    await until(() => f.inputs.length === 1)
    f.emit({ type: 'response.created', response: { id: 'failed-tool-output' } })
    f.emit({ type: 'response.function_call_arguments.done', response_id: 'failed-tool-output',
      call_id: 'diagnostic-spawn', name: 'spawn_thinking', arguments: '{"objective":"diagnostic task"}' })
    await until(() => rejectOutput)
    const done = () => f.emit({ type: 'response.done', response: { id: 'failed-tool-output', status: 'completed' } })
    if (sourceDoneFirst) done()
    rejectOutput(new Error('tool output transport failure'))
    await until(() => h.events.some(e => e.type === 'error' && e.message.includes('tool output transport failure')))
    if (!sourceDoneFirst) done()
    const task = h.manager.list({ active: true })[0]
    await until(() => h.runs.has(task.id))
    h.runs.get(task.id).resolve({ content: 'diagnostic completed result' })
    await h.manager.wait(task.id)
    await until(() => f.deliveries.some(d => d.origin === 'announcement'))
  })
}

test('failure to request a tool continuation releases task delivery', async t => {
  const h = harness(t)
  const f = await h.connect()
  f.ensureResponse = async () => { throw new Error('continuation transport failure') }
  h.send({ type: Input.TEXT_MESSAGE, text: 'run a background task' })
  await until(() => f.inputs.length === 1)
  f.emit({ type: 'response.created', response: { id: 'failed-follow-up' } })
  f.emit({ type: 'response.function_call_arguments.done', response_id: 'failed-follow-up',
    call_id: 'spawn', name: 'spawn_thinking', arguments: '{"objective":"task"}' })
  await until(() => f.outputs.length === 1)
  f.emit({ type: 'response.done', response: { id: 'failed-follow-up', status: 'completed' } })
  await until(() => h.events.some(e => e.type === 'error' && e.message === 'continuation transport failure'))
  const task = h.manager.list({ active: true })[0]
  await until(() => h.runs.has(task.id))
  h.runs.get(task.id).resolve({ content: 'completed result' })
  await h.manager.wait(task.id)
  await until(() => f.deliveries.some(d => d.origin === 'announcement'))
})

test('an older tool output failure cannot release a newer user turn', async t => {
  const h = harness(t)
  const f = await h.connect()
  let rejectOutput
  f.sendFunctionOutput = () => new Promise((_resolve, reject) => { rejectOutput = reject })
  h.send({ type: Input.TEXT_MESSAGE, text: 'run a background task' })
  await until(() => f.inputs.length === 1)
  f.emit({ type: 'response.created', response: { id: 'old-tool' } })
  f.emit({ type: 'response.function_call_arguments.done', response_id: 'old-tool',
    call_id: 'spawn', name: 'spawn_thinking', arguments: '{"objective":"task"}' })
  await until(() => rejectOutput)
  f.emit({ type: 'response.done', response: { id: 'old-tool', status: 'completed' } })
  h.send({ type: Input.TEXT_MESSAGE, text: 'another question' })
  await until(() => f.inputs.length === 2)
  rejectOutput(new Error('old tool output failed'))
  await until(() => h.events.some(e => e.type === 'error' && e.message === 'old tool output failed'))
  const task = h.manager.list({ active: true })[0]
  await until(() => h.runs.has(task.id))
  h.runs.get(task.id).resolve({ content: 'completed result' })
  await h.manager.wait(task.id)
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(f.deliveries.length, 0)
  f.emit({ type: 'response.created', response: { id: 'new-reply' } })
  f.emit({ type: 'response.done', response: { id: 'new-reply', status: 'completed' } })
  await until(() => f.deliveries.some(d => d.origin === 'announcement'))
})

test('speech clears old audio and invalid speech does not leave task delivery blocked', async t => {
  const h = harness(t)
  const f = await h.connect()
  const task = h.request('work')
  await until(() => h.runs.has(task.id))
  h.send({ type: Input.TEXT_MESSAGE, text: 'hello' })
  await until(() => f.inputs.length === 1)
  f.emit({ type: 'response.created', response: { id: 'old-audio' } })
  f.emit({ type: 'response.audio.delta', response_id: 'old-audio', delta: 'AAA=', sampleRate: 24000 })
  f.emit({ type: 'response.done', response: { id: 'old-audio', status: 'completed' } })
  f.emit({ type: 'input_audio_buffer.speech_started', item_id: 'noise' })
  h.runs.get(task.id).resolve({ content: 'completed result' })
  await h.manager.wait(task.id)
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(f.deliveries.length, 0, 'speech must still block delivery')
  f.emit({ type: 'input_audio_buffer.speech_stopped', item_id: 'noise', reason: 'turn_invalid' })
  await until(() => f.deliveries.some(d => d.origin === 'announcement'))
})

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

// A real frontend on a fake socket, so shouldCreate is checked as in production.
function wiredFrontend(t) {
  const sent = []
  const frontend = new RealtimeFrontend({ provider: REALTIME_PROVIDERS.dashscope, onDiagnostic() {} })
  frontend.ready = true
  frontend.ws = { readyState: 1, send: raw => sent.push(JSON.parse(raw)) }
  t.after(() => frontend.resetResponses())
  return { frontend, creates: () => sent.filter(event => event.type === 'response.create').length }
}

// The user answers a pending permission by voice; returns the runtime's
// fallback request once it fires.
async function spokenPermissionAnswer(t) {
  const h = harness(t)
  const f = await h.connect()
  const requested = []
  f.ensureResponse = async (context, options) => { requested.push({ context, options }) }
  const task = h.request('write a file')
  await until(() => h.runs.has(task.id))
  h.runs.get(task.id).onEvent({ type: 'backend.permission.requested', permission: {
    id: 'auth_spoken', status: 'pending', summary: 'write a file',
  } })
  await until(() => f.deliveries.some(delivery => delivery.origin === 'permission'))
  f.emit({ type: 'input_audio_buffer.speech_started', item_id: 'answer' })
  f.emit({ type: 'input_audio_buffer.speech_stopped', item_id: 'answer' })
  f.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'answer', transcript: '同意' })
  await until(() => requested.length === 1)
  return { h, f, task, request: requested[0] }
}

test('a spoken permission answer without an automatic reply sends one response.create', async t => {
  const { h, task, request } = await spokenPermissionAnswer(t)
  const wired = wiredFrontend(t)
  wired.frontend.ensureResponse(request.context, request.options).catch(() => {})
  await until(() => wired.creates() > 0)
  await tick()
  assert.equal(wired.creates(), 1)
  assert.equal(h.manager.get(task.id).authorization.status, 'pending')
})

test('an automatic reply that starts before the fallback is sent takes over its turn', async t => {
  const { f, request } = await spokenPermissionAnswer(t)
  f.emit({ type: 'response.created', response: { id: 'automatic' } })
  const wired = wiredFrontend(t)
  assert.equal((await wired.frontend.ensureResponse(request.context, request.options)).skipped, true)
  assert.equal(wired.creates(), 0)
})

test('the pending-permission gate decides once and skips a stale or refused request', async t => {
  const gate = state => permissionResponseGate({
    isCandidate: () => state.candidate,
    hasPendingPermission: () => state.pending,
    claim: () => { state.candidate = false; state.claims += 1 },
  })
  // Still pending at the pre-send re-check: one request goes out and stays
  // wanted once the backend has settled the permission.
  const open = { candidate: true, pending: true, claims: 0 }
  const a = wiredFrontend(t)
  const shouldCreate = gate(open)
  a.frontend.ensureResponse({ turnId: 'turn-1' }, { shouldCreate }).catch(() => {})
  await until(() => a.creates() === 1)
  assert.equal(open.claims, 1)
  open.pending = false
  assert.equal(shouldCreate(), true)
  // Settled while the frontend waited for an active response: nothing is sent
  // and the turn is never claimed.
  const settled = { candidate: true, pending: true, claims: 0 }
  const b = wiredFrontend(t)
  b.frontend.handleLifecycle({ type: 'response.created', response: { id: 'busy' } })
  const skipped = b.frontend.ensureResponse({ turnId: 'turn-1' }, { shouldCreate: gate(settled) })
  await tick()
  settled.pending = false
  b.frontend.handleLifecycle({ type: 'response.done', response: { id: 'busy', status: 'completed' } })
  assert.equal((await skipped).skipped, true)
  assert.equal(b.creates(), 0)
  assert.equal(settled.claims, 0)
  // Refused as busy because the model answered on its own: once that reply has
  // settled the permission, the retry is dropped instead of asking again.
  const raced = { candidate: true, pending: true, claims: 0 }
  const c = wiredFrontend(t)
  const retried = c.frontend.ensureResponse({ turnId: 'turn-1' }, { shouldCreate: gate(raced) })
  await until(() => c.creates() === 1)
  c.frontend.handleLifecycle({ type: 'response.created', response: { id: 'auto-1' } })
  c.frontend.handleLifecycle({ type: 'error', error: { type: 'invalid_request_error', message: 'Conversation already has an active response' } })
  raced.pending = false
  c.frontend.handleLifecycle({ type: 'response.done', response: { id: 'auto-1', status: 'completed' } })
  // A second request would wait for its own response.created; fail fast instead.
  const outcome = await Promise.race([retried, new Promise(resolve => setTimeout(resolve, 500, 'resent'))])
  assert.equal(outcome.skipped, true)
  assert.equal(c.creates(), 1)
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

for (const completesAfterClose of [true, false]) {
  test(`new session does not announce previous session results (completes after close: ${completesAfterClose})`, async t => {
    const a = harness(t, { ownerId: 'user_personal', sessionId: 'call-A' })
    const frontendA = await a.connect()
    const task = a.request('private task for A')
    await until(() => a.runs.has(task.id))
    if (completesAfterClose) a.runtime.close()
    a.runs.get(task.id).resolve({ content: 'private result for A' })
    await a.manager.wait(task.id)
    if (!completesAfterClose) {
      await until(() => frontendA.deliveries.some(delivery => delivery.origin === 'announcement'))
      assert.equal(a.manager.get(task.id).notificationStatus, 'delivering')
      a.runtime.close()
    }
    assert.equal(a.manager.get(task.id).notificationStatus, 'pending')
    const b = harness(t, { ownerId: 'user_personal', sessionId: 'call-B', taskManager: a.manager })
    const frontendB = await b.connect()
    // Allow the zero-delay announcement batch timer to run if onReady claimed it.
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(frontendB.deliveries.length, 0)
    assert.equal(a.manager.get(task.id).notificationStatus, 'pending')
    b.runtime.close()
    const resumed = harness(t, { ownerId: 'user_personal', sessionId: 'call-A', taskManager: a.manager })
    const frontendResumed = await resumed.connect()
    await until(() => frontendResumed.deliveries.some(delivery => delivery.origin === 'announcement'))
    assert.match(frontendResumed.deliveries[0].text, /private result for A/u)
  })
}

test('input state separates client mute, host suspension and deactivation', async t => {
  const h = harness(t, { backend: false })
  await h.connect()
  assert.deepEqual(h.runtime.inputState(), { inputEnabled: true, inputSuspended: false, inputActive: true })
  h.send({ type: Input.INPUT_MUTE })
  assert.deepEqual(h.runtime.inputState(), { inputEnabled: false, inputSuspended: false, inputActive: false })
  h.runtime.applyInputSuspension({ suspended: true, owner: 'host', reason: 'test' })
  assert.deepEqual(h.runtime.inputState(), { inputEnabled: false, inputSuspended: true, inputActive: false })
  h.send({ type: Input.INPUT_UNMUTE })
  assert.deepEqual(h.runtime.inputState(), { inputEnabled: true, inputSuspended: true, inputActive: false })
  h.runtime.applyInputSuspension({ suspended: false })
  assert.deepEqual(h.runtime.inputState(), { inputEnabled: true, inputSuspended: false, inputActive: true })
  h.runtime.deactivate({ type: 'replacement' })
  assert.deepEqual(h.runtime.inputState(), { inputEnabled: false, inputSuspended: false, inputActive: false })
  h.runtime.close()
  assert.equal(h.runtime.inputState().inputActive, false)
})

test('policy review injects correction before regenerated next-turn audio and tools can dispatch', async t => {
  let resolveReview
  const verdict = new Promise(resolve => { resolveReview = resolve })
  const h = harness(t, { policyReviewSettings: { enabled: true, timeoutMs: 500, endpoint: 'unused' },
    policyReviewDecide: async ({ rules }) => { await verdict; return [{ id: rules[0].id }] } })
  const f = await h.connect({}, { capabilitiesNegotiated: true, capabilities: ['input.audio', 'input.text'] })
  const resumed = []
  f.ensureResponse = async (...args) => resumed.push(args)
  h.send({ type: Input.TEXT_MESSAGE, text: 'check my account' })
  await until(() => f.inputs.length === 1)
  f.emit({ type: 'response.created', response: { id: 'reviewed' } })
  f.emit({ type: 'response.audio.delta', response_id: 'reviewed', delta: 'FIRST=' })
  f.emit({ type: 'response.audio_transcript.done', response_id: 'reviewed', transcript: '已经处理好了' })
  f.emit({ type: 'response.done', response: { id: 'reviewed', status: 'completed' } })
  await tick()
  h.send({ type: Input.TEXT_MESSAGE, text: 'what happened?' })
  await until(() => f.inputs.length === 2)
  const audioBefore = h.events.filter(e => e.audio).length
  f.emit({ type: 'response.created', response: { id: 'speculative' } })
  f.emit({ type: 'response.audio.delta', response_id: 'speculative', delta: 'DISCARD=' })
  f.emit({ type: 'response.function_call_arguments.done', response_id: 'speculative', call_id: 'bad', name: 'spawn_thinking', arguments: '{"objective":"must not run"}' })
  assert.equal(h.events.filter(e => e.audio).length, audioBefore)
  assert.equal(h.events.filter(e => e.type === 'response.interrupted' && e.responseId === 'speculative').length, 0)
  assert.equal(h.manager.list({}).length, 0)
  resolveReview([{ id: 'rule_no_false_completion', rule: '没有执行不得声称完成' }])
  await until(() => resumed.length > 0)
  assert.equal(f.deliveries.at(-1).origin, 'policy-review')
  assert.equal(f.deliveries.at(-1).settings.route, 'context')
  assert.match(f.deliveries.at(-1).text, /已经处理好了/)
  assert.equal(h.events.filter(e => e.type === 'response.interrupted' && e.responseId === 'speculative').length, 1)
  f.emit({ type: 'response.created', response: { id: 'regenerated' } })
  f.emit({ type: 'response.audio.delta', response_id: 'regenerated', delta: 'CORRECT=' })
  assert.ok(h.events.some(e => e.audio === 'CORRECT='))
  assert.ok(!h.events.some(e => e.audio === 'DISCARD='))
})

test('policy review off does not call reviewer, cancel, inject context or alter frontend prompt', async t => {
  const h = harness(t, { policyReviewSettings: { enabled: false }, policyReviewDecide: () => assert.fail('disabled review') })
  const f = await h.connect({}, { capabilitiesNegotiated: true, capabilities: ['input.audio', 'input.text'] })
  h.send({ type: Input.TEXT_MESSAGE, text: 'hello' })
  await until(() => f.inputs.length === 1)
  const cancels = f.cancels
  f.emit({ type: 'response.created', response: { id: 'ordinary' } })
  f.emit({ type: 'response.audio.delta', response_id: 'ordinary', delta: 'PASS=' })
  f.emit({ type: 'response.audio_transcript.done', response_id: 'ordinary', transcript: 'hello there' })
  f.emit({ type: 'response.done', response: { id: 'ordinary', status: 'completed' } })
  await tick()
  assert.equal(f.cancels, cancels)
  assert.equal(f.deliveries.length, 0)
  assert.equal(f.updates.length, 0)
  assert.ok(h.events.some(e => e.audio === 'PASS='))
})

for (const verdictKind of ['ok', 'timeout']) {
  test(`policy ${verdictKind} replays a complete buffered reply without cancelling or regeneration`, async t => {
    let resolve
    const verdict = new Promise(done => { resolve = done })
    const h = harness(t, { policyReviewSettings: { enabled: true, timeoutMs: verdictKind === 'timeout' ? 15 : 500, endpoint: 'unused' },
      policyReviewDecide: () => verdict })
    const f = await h.connect({}, { capabilitiesNegotiated: true, capabilities: ['input.audio', 'input.text'] })
    let regenerated = 0
    f.ensureResponse = async () => { regenerated++ }
    h.send({ type: Input.TEXT_MESSAGE, text: 'hello' })
    await until(() => f.inputs.length === 1)
    f.emit({ type: 'response.created', response: { id: 'first' } })
    f.emit({ type: 'response.audio_transcript.done', response_id: 'first', transcript: 'hello' })
    f.emit({ type: 'response.done', response: { id: 'first', status: 'completed' } })
    await tick()
    const cancels = f.cancels
    f.emit({ type: 'response.created', response: { id: 'buffered' } })
    f.emit({ type: 'response.audio.delta', response_id: 'buffered', delta: 'HELD=' })
    f.emit({ type: 'response.audio_transcript.done', response_id: 'buffered', transcript: 'second answer' })
    f.emit({ type: 'response.done', response: { id: 'buffered', status: 'completed' } })
    assert.ok(!h.events.some(e => e.audio === 'HELD='))
    assert.ok(!h.events.some(e => e.type === 'response.started' && e.responseId === 'buffered'))
    if (verdictKind === 'ok') resolve([])
    await until(() => h.events.some(e => e.audio === 'HELD='))
    assert.equal(h.events.filter(e => e.audio === 'HELD=').length, 1)
    assert.equal(f.cancels, cancels)
    assert.equal(regenerated, 0)
  })
}

test('back-to-back policy verdicts release a same-turn queued repair after an announcement', async t => {
  let reviews = 0
  const h = harness(t, { policyReviewSettings: { enabled: true, timeoutMs: 500, endpoint: 'unused' },
    policyReviewDecide: async ({ rules }) => ++reviews <= 2 ? [{ id: rules[0].id }] : [] })
  const f = await h.connect({}, { capabilitiesNegotiated: true, capabilities: ['input.audio', 'input.text'] })
  const requests = []
  let completeFirst
  const first = new Promise(resolve => { completeFirst = resolve })
  f.ensureResponse = (...args) => {
    requests.push(args)
    return requests.length === 1 ? first : Promise.resolve({ completed: true })
  }
  h.send({ type: Input.TEXT_MESSAGE, text: 'perform the operation' })
  await until(() => f.inputs.length === 1)
  f.emit({ type: 'response.created', response: { id: 'original' } })
  f.emit({ type: 'response.audio_transcript.done', response_id: 'original', transcript: 'cannot do it' })
  f.emit({ type: 'response.done', response: { id: 'original', status: 'completed' } })
  await until(() => requests.length === 1)
  f.emit({ type: 'response.created', __voiceOrigin: 'announcement', response: { id: 'announcement' } })
  f.emit({ type: 'response.audio_transcript.done', response_id: 'announcement', transcript: 'another failure result' })
  f.emit({ type: 'response.done', response: { id: 'announcement', status: 'completed' } })
  await until(() => reviews === 2)
  await tick()
  f.emit({ type: 'response.created', response: { id: 'first-repair' } })
  f.emit({ type: 'response.audio.delta', response_id: 'first-repair', delta: 'HELD=' })
  f.emit({ type: 'response.done', response: { id: 'first-repair', status: 'completed' } })
  assert.ok(!h.events.some(e => e.audio === 'HELD='))
  completeFirst({ completed: true })
  await until(() => requests.length === 2)
  assert.match(requests[1][1].response.instructions, /original/)
  assert.match(requests[1][1].response.instructions, /announcement/)
  f.emit({ type: 'response.created', response: { id: 'second-repair' } })
  f.emit({ type: 'response.audio.delta', response_id: 'second-repair', delta: 'RELEASED=' })
  assert.ok(h.events.some(e => e.audio === 'RELEASED='))
  assert.ok(h.events.some(e => e.type === 'response.interrupted' && e.responseId === 'first-repair'))
})

test('business delegation waits for the complete spoken response and its unified JEV verdict', async t => {
  let release
  const verdict = new Promise(resolve => { release = resolve })
  const packets = []
  const h = harness(t, { policyReviewSettings: { enabled: true, timeoutMs: 500, endpoint: 'unused' },
    policyReviewDecide: async packet => { packets.push(packet); return verdict } })
  const f = await h.connect({}, { capabilitiesNegotiated: true, capabilities: ['input.audio', 'input.text'] })
  h.send({ type: Input.TEXT_MESSAGE, text: 'book an appointment' })
  await until(() => f.inputs.length === 1)
  f.emit({ type: 'response.created', response: { id: 'proposal' } })
  f.emit({ type: 'response.audio_transcript.delta', response_id: 'proposal', delta: 'Let me check.' })
  f.emit({ type: 'response.function_call_arguments.done', response_id: 'proposal', call_id: 'proposed-call',
    name: 'spawn_thinking', arguments: '{"objective":"book an appointment"}' })
  await tick()
  assert.equal(packets.length, 0)
  f.emit({ type: 'response.audio.delta', response_id: 'proposal', delta: 'CURRENT=' })
  f.emit({ type: 'response.audio_transcript.done', response_id: 'proposal', transcript: 'Let me check the full request.' })
  f.emit({ type: 'response.done', response: { id: 'proposal', status: 'completed' } })
  await until(() => packets.length === 1)
  assert.ok(h.events.some(e => e.audio === 'CURRENT='))
  assert.equal(h.manager.list({}).length, 0)
  assert.equal(f.outputs.length, 0)
  assert.equal(packets[0].state.phase, 'played_response')
  assert.equal(packets[0].state.assistant_text, 'Let me check the full request.')
  assert.equal(packets[0].state.proposed_tools[0].executed, false)
  release([])
  await until(() => h.manager.list({}).length === 1 && f.outputs.length === 1)
  assert.equal(f.outputs[0].result.status, 'accepted')
})

test('JEV denial returns an unexecuted tool receipt before correction and never creates backend work', async t => {
  let release, acknowledge
  const verdict = new Promise(resolve => { release = resolve })
  const receipt = new Promise(resolve => { acknowledge = resolve })
  const packets = []
  const h = harness(t, { policyReviewSettings: { enabled: true, timeoutMs: 500, endpoint: 'unused' },
    policyReviewDecide: async packet => { packets.push(packet); await verdict; return packet.rules.map(({ id }) => ({ id })) } })
  const f = await h.connect({}, { capabilitiesNegotiated: true, capabilities: ['input.audio', 'input.text'] })
  const resumes = []
  f.ensureResponse = async (...args) => { resumes.push(args) }
  f.sendFunctionOutput = async (callId, result, context, settings) => {
    f.outputs.push({ callId, result, context, settings }); await receipt
  }
  h.send({ type: Input.TEXT_MESSAGE, text: 'change the booking' })
  await until(() => f.inputs.length === 1)
  f.emit({ type: 'response.created', response: { id: 'denied-proposal' } })
  f.emit({ type: 'response.function_call_arguments.done', response_id: 'denied-proposal', call_id: 'denied-call',
    name: 'spawn_thinking', arguments: '{"objective":"change the booking"}' })
  f.emit({ type: 'response.text.done', response_id: 'denied-proposal', text: 'I cannot do that.' })
  f.emit({ type: 'response.done', response: { id: 'denied-proposal', status: 'completed' } })
  await until(() => packets.length === 1)
  release()
  await until(() => f.outputs.length === 1)
  assert.equal(h.manager.list({}).length, 0)
  assert.equal(f.outputs[0].result.error_code, 'policy_review_rejected')
  assert.equal(f.outputs[0].result.executed, false)
  assert.equal(f.outputs[0].result.retryable, true)
  const ruleIds = packets[0].rules.map(rule => rule.id)
  assert.deepEqual(f.outputs[0].result.corrections.map(item => item.id), ruleIds)
  assert.equal(f.outputs[0].settings.createResponse, false)
  assert.equal(resumes.length, 0)
  acknowledge()
  await until(() => resumes.length === 1)
  const injected = f.deliveries.find(delivery => delivery.origin === 'policy-review')
  assert.deepEqual(JSON.parse(injected.text).corrections[0].violations.map(item => item.id), ruleIds)
  for (const id of ruleIds) assert.ok(resumes[0][1].response.instructions.includes(id))
  assert.equal(h.manager.list({}).length, 0)
})

for (const reject of [false, true]) test(`backend work starts only after unified JEV review (${reject ? 'reject' : 'allow'})`, async t => {
  let release
  const verdict = new Promise(resolve => { release = resolve })
  const packets = []
  const h = harness(t, { policyReviewSettings: { enabled: true, timeoutMs: 1000, endpoint: 'unused' },
    policyReviewDecide: async packet => { packets.push(packet); await verdict; return reject ? [{ id: packet.rules[0].id }] : [] } })
  const f = await h.connect({ textOnly: true }, { capabilitiesNegotiated: true, capabilities: ['input.text'] })
  const resumes = []
  f.ensureResponse = async (...args) => { resumes.push(args); return { completed: true } }
  h.send({ type: Input.TEXT_MESSAGE, text: 'do the work' })
  await until(() => f.inputs.length === 1)
  f.emit({ type: 'response.created', response: { id: 'source-with-task' } })
  f.emit({ type: 'response.function_call_arguments.done', response_id: 'source-with-task', call_id: 'task-call',
    name: 'spawn_thinking', arguments: '{"objective":"do the work"}' })
  await tick(); assert.equal(packets.length, 0)
  f.emit({ type: 'response.text.done', response_id: 'source-with-task', text: 'I cannot do the work.' })
  f.emit({ type: 'response.done', response: { id: 'source-with-task', status: 'completed' } })
  await until(() => packets.length === 1)
  assert.equal(h.manager.list({}).length, 0)
  release()
  if (!reject) {
    await until(() => f.outputs.some(o => o.result.task_id))
    const taskId = f.outputs.find(o => o.result.task_id).result.task_id
    await until(() => h.runs.has(taskId))
    h.runs.get(taskId).resolve({ content: 'Business completed once.' })
    await h.manager.wait(taskId)
    await until(() => f.deliveries.some(d => d.origin === 'announcement'))
    assert.equal(h.manager.list({}).length, 1)
  } else {
    await until(() => resumes.length === 1)
    assert.equal(h.manager.list({}).length, 0)
    assert.equal(f.deliveries.some(d => d.origin === 'announcement'), false)
    assert.equal(f.outputs[0].result.executed, false)
    assert.match(resumes[0][1].response.instructions, /先调用 spawn_thinking/)
    assert.match(resumes[0][1].response.instructions, /澄清先前的能力判断/)
  }
})

for (const hasTools of [false, true]) test(`unified review waits for actual playback completion (tools=${hasTools})`, async t => {
  const packets = []
  let release
  const verdict = new Promise(resolve => { release = resolve })
  const h = harness(t, { policyReviewSettings: { enabled: true, timeoutMs: 500, endpoint: 'unused' },
    policyReviewDecide: async packet => { packets.push(packet); return verdict } })
  const f = await h.connect()
  h.send({ type: Input.TEXT_MESSAGE, text: 'perform my request' })
  await until(() => f.inputs.length === 1)
  f.emit({ type: 'response.created', response: { id: 'playing' } })
  f.emit({ type: 'response.audio.delta', response_id: 'playing', delta: 'ORIGINAL=' })
  if (hasTools) for (const [id, objective] of [['one', 'first work'], ['two', 'second work']]) {
    f.emit({ type: 'response.function_call_arguments.done', response_id: 'playing', call_id: id,
      name: 'spawn_thinking', arguments: JSON.stringify({ objective }) })
  }
  f.emit({ type: 'response.audio_transcript.done', response_id: 'playing', transcript: 'The complete spoken request.' })
  f.emit({ type: 'response.done', response: { id: 'playing', status: 'completed' } })
  await tick()
  assert.equal(packets.length, 0)
  assert.equal(h.manager.list({}).length, 0)
  assert.ok(h.events.some(e => e.audio === 'ORIGINAL='))
  f.emit({ type: 'response.created', response: { id: 'next-playing' } })
  f.emit({ type: 'response.audio.delta', response_id: 'next-playing', delta: 'NEXT=' })
  assert.ok(!h.events.some(e => e.audio === 'NEXT='))
  h.send({ type: Input.PLAYBACK_ENDED, responseId: 'playing' })
  await until(() => packets.length === 1)
  assert.equal(packets[0].state.proposed_tools.length, hasTools ? 2 : 0)
  assert.equal(packets[0].state.assistant_text, 'The complete spoken request.')
  assert.equal(h.manager.list({}).length, 0)
  release([])
  await until(() => h.events.some(e => e.audio === 'NEXT='))
  if (hasTools) await until(() => h.manager.list({}).length === 2)
  assert.equal(packets.length, 1)
})

for (const speaking of [false, true]) test(`rejected unified batch cancels speculative reply and reissues old tools after speech (speaking=${speaking})`, async t => {
  let release
  const verdict = new Promise(resolve => { release = resolve })
  let reviews = 0
  const h = harness(t, { policyReviewSettings: { enabled: true, timeoutMs: 1000, endpoint: 'unused' },
    policyReviewDecide: async ({ rules }) => { reviews++; await verdict; return [{ id: rules[0].id }] } })
  const f = await h.connect()
  const requests = []
  f.ensureResponse = async (...args) => { requests.push(args); return { completed: true } }
  h.send({ type: Input.TEXT_MESSAGE, text: 'please act' })
  await until(() => f.inputs.length === 1)
  f.emit({ type: 'response.created', response: { id: 'bad-batch' } })
  f.emit({ type: 'response.audio.delta', response_id: 'bad-batch', delta: 'HEARD=' })
  for (const [callId, objective] of [['bad-1', 'first action'], ['bad-2', 'second action']]) {
    f.emit({ type: 'response.function_call_arguments.done', response_id: 'bad-batch', call_id: callId,
      name: 'spawn_thinking', arguments: JSON.stringify({ objective }) })
  }
  f.emit({ type: 'response.audio_transcript.done', response_id: 'bad-batch', transcript: 'I cannot do that.' })
  f.emit({ type: 'response.done', response: { id: 'bad-batch', status: 'completed' } })
  h.send({ type: Input.PLAYBACK_ENDED, responseId: 'bad-batch' })
  await until(() => reviews === 1)
  f.emit({ type: 'response.created', response: { id: 'speculative-batch' } })
  f.emit({ type: 'response.audio.delta', response_id: 'speculative-batch', delta: 'NEVER_PLAY=' })
  if (speaking) f.emit({ type: 'input_audio_buffer.speech_started', item_id: 'new-user' })
  const cancels = f.cancels
  release()
  await until(() => f.deliveries.some(d => d.origin === 'policy-review'))
  assert.equal(h.manager.list({}).length, 0)
  assert.ok(!h.events.some(e => e.audio === 'NEVER_PLAY='))
  assert.ok(f.cancels > cancels)
  if (speaking) {
    assert.equal(requests.length, 0)
    f.emit({ type: 'input_audio_buffer.speech_stopped', item_id: 'new-user' })
  }
  await until(() => requests.length === 1)
  assert.match(requests[0][1].response.instructions, /先调用 spawn_thinking/)
  assert.match(requests[0][1].response.instructions, /bad-1/)
  assert.match(requests[0][1].response.instructions, /bad-2/)
  assert.equal(requests[0][1].waitForSpeechStopped, true)
})

test('disconnect while tool calls await the playback boundary never submits those calls', async t => {
  let reviews = 0
  const h = harness(t, { policyReviewSettings: { enabled: true, timeoutMs: 10, endpoint: 'unused' },
    policyReviewDecide: async () => { reviews++; return [] } })
  const f = await h.connect()
  h.send({ type: Input.TEXT_MESSAGE, text: 'do the work' })
  await until(() => f.inputs.length === 1)
  f.emit({ type: 'response.created', response: { id: 'lost-source' } })
  f.emit({ type: 'response.function_call_arguments.done', response_id: 'lost-source', call_id: 'lost-call',
    name: 'spawn_thinking', arguments: '{"objective":"never submitted"}' })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(reviews, 0)
  assert.equal(h.manager.list({}).length, 0)
  f.disconnect()
  await tick()
  assert.equal(reviews, 0)
  assert.equal(h.manager.list({}).length, 0)
})
