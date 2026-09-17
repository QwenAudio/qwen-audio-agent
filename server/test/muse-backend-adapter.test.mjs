import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  MuseBackendAdapter,
  createMuseBackendAdapter,
} from '../src/backend/adapters/muse/backend-adapter.mjs'
import {
  verifyBackendAdapterConformance,
} from '../src/backend/backend-adapter-conformance.mjs'

function completedOutcome(terminal = 'completed', error) {
  return {
    kind: 'completed',
    observedStart: true,
    params: {
      terminal,
      ...(error ? { error } : {}),
    },
  }
}

function finalItem(text, turnId = 'turn-1') {
  return {
    itemId: `agent-${turnId}`,
    kind: 'agentMessage',
    revision: 2,
    status: 'completed',
    turnId,
    text,
  }
}

function fakeRuntime({ hold = false, approval = false, inputRequest = false } = {}) {
  const started = Promise.withResolvers()
  const completion = Promise.withResolvers()
  if (!hold && !approval && !inputRequest) completion.resolve(completedOutcome())
  const calls = []
  let approvalHandler = null
  let approvalErrorHandler = null
  let pendingInputs = inputRequest ? [{
    userInputId: 'muse-input-1',
    sessionId: 'muse-session-1',
    turnId: 'turn-1',
    questions: [{
      id: 'framework',
      header: 'Framework',
      question: 'Which framework should be used?',
      selection: { mode: 'single' },
      options: [
        { label: 'React', description: 'Use React' },
        { label: 'Vue', description: 'Use Vue' },
      ],
    }],
  }] : []
  const session = {
    sessionId: 'muse-session-1',
    fold: { pendingUserInputs: () => pendingInputs },
    onApproval(handler) { approvalHandler = handler },
    onApprovalError(handler) { approvalErrorHandler = handler },
    async sendUserTurn(options) {
      calls.push({ method: 'turn/start', options })
      started.resolve()
      if (approval) {
        const decision = await approvalHandler({
          approvalId: 'private-approval-id',
          sessionId: 'muse-session-1',
          turnId: 'turn-1',
          toolName: 'shell',
          subject: { kind: 'shell', command: 'npm test' },
          availableChoices: [
            {
              choiceId: 'allow-once',
              decision: 'approved',
              label: 'Allow once',
              scope: 'once',
            },
            {
              choiceId: 'allow-persistent',
              decision: 'approvedPolicyAmendment',
              label: 'Always allow',
              scope: 'localPersistent',
            },
            {
              choiceId: 'deny',
              decision: 'denied',
              label: 'Deny',
              scope: 'once',
            },
          ],
        })
        calls.push({ method: 'approval/decision', decision })
        completion.resolve(completedOutcome())
      }
      const completed = completion.promise
      return {
        turnId: 'turn-1',
        completed,
        async *items() {
          await completed
          yield finalItem('Muse finished the requested work.')
        },
      }
    },
  }
  let commandNumber = 0
  const connection = {
    mintCommandId: () => `command-${++commandNumber}`,
    async command(method, params) {
      calls.push({ method, params })
      if (method.startsWith('userInput/')) {
        pendingInputs = []
        completion.resolve(completedOutcome())
      }
      return { status: 'accepted' }
    },
  }
  const client = {
    async startSession(options) {
      calls.push({ method: 'session/start', options })
      return session
    },
    async close() {
      calls.push({ method: 'client/close' })
    },
  }
  return {
    completion,
    started: started.promise,
    calls,
    session,
    connection,
    clientFactory: async () => ({
      client,
      connection,
      initializeResult: { sessionDurability: 'durable' },
    }),
    failApproval: failure => approvalErrorHandler?.(failure),
  }
}

function work(index = 1) {
  return {
    id: `muse-task-${index}`,
    ownerId: 'owner-1',
    instruction: `Implement Muse task ${index}`,
  }
}

test('Muse backend adapter satisfies the public BackendPort contract', async () => {
  await verifyBackendAdapterConformance({
    createFixture: ({ hold }) => {
      const runtime = fakeRuntime({ hold })
      const backend = createMuseBackendAdapter({
        clientFactory: runtime.clientFactory,
        timeoutMs: 0,
      })
      return {
        name: 'Muse Code',
        backend,
        work: work(1),
        nextWork: work(2),
        started: runtime.started,
      }
    },
  })
})

test('reports a missing Muse executable before the MSP handshake', async () => {
  const backend = new MuseBackendAdapter({
    museBin: 'E:\\qwen-audio-agent\\.missing-muse\\muse.exe',
    env: { PATH: process.env.PATH },
    timeoutMs: 0,
  })
  const health = await backend.health()
  assert.equal(health.ok, false)
  assert.match(health.error, /未找到 Muse Code 可执行文件/)
  await backend.close()
})

test('submits MSP turns and returns the final agent message', async () => {
  const runtime = fakeRuntime()
  const backend = new MuseBackendAdapter({
    clientFactory: runtime.clientFactory,
    directory: '/workspace',
    model: 'muse-spark-1.3',
    timeoutMs: 0,
    env: { PATH: process.env.PATH },
  })
  const events = []
  backend.subscribe(event => events.push(event))
  const outcome = await backend.submit({
    ...work(),
    inputParts: [{
      type: 'file',
      mime: 'image/png',
      url: 'data:image/png;base64,aGVsbG8=',
    }],
  })
  assert.equal(outcome.content, 'Muse finished the requested work.')
  assert.deepEqual(outcome.artifacts, [])
  assert.ok(events.some(event => event.type === 'backend.message'))
  const start = runtime.calls.find(call => call.method === 'session/start')
  assert.deepEqual(start.options, {
    workspaceRoot: '/workspace',
    modelId: 'muse-spark-1.3',
  })
  const turn = runtime.calls.find(call => call.method === 'turn/start')
  assert.equal(turn.options.input[0].text, work().instruction)
  assert.deepEqual(turn.options.input[1], {
    type: 'image',
    mediaType: 'image/png',
    base64Data: 'aGVsbG8=',
  })
  await backend.close()
})

test('keeps the host working directory separate from the MSP workspace root', async () => {
  const runtime = fakeRuntime()
  const backend = new MuseBackendAdapter({
    clientFactory: runtime.clientFactory,
    directory: 'E:\\qwen-audio-agent',
    workspaceRoot: '/home/muse/workspace',
    timeoutMs: 0,
  })
  await backend.submit(work())
  const start = runtime.calls.find(call => call.method === 'session/start')
  assert.equal(start.options.workspaceRoot, '/home/muse/workspace')
  await backend.close()
})

test('maps Gateway permission decisions to server-offered Muse choices', async () => {
  const runtime = fakeRuntime({ approval: true })
  const backend = createMuseBackendAdapter({
    clientFactory: runtime.clientFactory,
    timeoutMs: 0,
  })
  const requested = Promise.withResolvers()
  backend.subscribe(event => {
    if (event.type === 'backend.permission.requested') requested.resolve(event)
  })
  const pending = backend.submit(work())
  const event = await requested.promise
  assert.notEqual(event.permission.id, 'private-approval-id')
  assert.equal(event.permission.operation.command, 'npm test')
  const permission = await backend.respondAuthorization(
    work().id,
    event.permission.id,
    'always',
    { ownerId: work().ownerId },
  )
  assert.equal(permission.status, 'approved')
  const outcome = await pending
  assert.equal(outcome.content, 'Muse finished the requested work.')
  const decision = runtime.calls.find(call => call.method === 'approval/decision')
  assert.equal(decision.decision.choiceId, 'allow-once')
  await backend.close()
})

test('uses Muse allowAll only for the explicit full permission mode', async () => {
  const runtime = fakeRuntime()
  const backend = createMuseBackendAdapter({
    clientFactory: runtime.clientFactory,
    permissionMode: 'full',
    timeoutMs: 0,
  })
  await backend.submit(work())
  const start = runtime.calls.find(call => call.method === 'session/start')
  assert.equal(start.options.approvalMode, 'allowAll')
  await backend.close()
})

test('cancels the exact active Muse turn without waiting for host shutdown', async () => {
  const runtime = fakeRuntime({ hold: true })
  const backend = createMuseBackendAdapter({
    clientFactory: runtime.clientFactory,
    timeoutMs: 0,
  })
  const pending = backend.submit(work())
  await runtime.started
  assert.deepEqual(await backend.cancel(work().id, {
    ownerId: work().ownerId,
  }), {
    taskId: work().id,
    state: 'cancelled',
  })
  await assert.rejects(pending, /cancelled/)
  const cancelled = runtime.calls.find(call => call.method === 'turn/cancel')
  assert.equal(cancelled.params.turnId, 'turn-1')
  assert.equal(cancelled.params.sessionId, 'muse-session-1')
  await backend.close()
})

test('projects MSP user input and sends a structured answer', async () => {
  const runtime = fakeRuntime({ inputRequest: true })
  const backend = createMuseBackendAdapter({
    clientFactory: runtime.clientFactory,
    timeoutMs: 0,
  })
  const requested = Promise.withResolvers()
  backend.subscribe(event => {
    if (event.type === 'backend.input.requested') requested.resolve(event)
  })
  const pending = backend.submit(work())
  const event = await requested.promise
  assert.equal(event.input.mode, 'form')
  await backend.respondInput(
    work().id,
    event.input.id,
    { action: 'accept', values: { framework: 'React' } },
    { ownerId: work().ownerId },
  )
  const outcome = await pending
  assert.equal(outcome.content, 'Muse finished the requested work.')
  const answer = runtime.calls.find(call => call.method === 'userInput/answer')
  assert.deepEqual(answer.params.answers, [{
    questionId: 'framework',
    selectedLabel: 'React',
  }])
  await backend.close()
})

test('AgentClient selects the MSP adapter for the Muse protocol', async () => {
  const previousConfigDirectory = process.env.QWAUDIO_CONFIG_DIR
  const configDirectory = mkdtempSync(join(tmpdir(), 'qwaudio-muse-test-'))
  process.env.QWAUDIO_CONFIG_DIR = configDirectory
  try {
    const { createAgentClient } = await import('../src/backend/adapters/agent-client.mjs')
    const runtime = fakeRuntime()
    const client = createAgentClient({
      protocol: 'muse',
      museClientFactory: runtime.clientFactory,
      backends: {
        muse: { directory: '/workspace', timeoutMs: 0 },
      },
    })
    assert.equal(client.protocol, 'muse')
    assert.equal(client.label, 'Muse Code')
    assert.equal((await client.submit(work())).content, 'Muse finished the requested work.')
    await client.close()
  } finally {
    if (previousConfigDirectory === undefined) delete process.env.QWAUDIO_CONFIG_DIR
    else process.env.QWAUDIO_CONFIG_DIR = previousConfigDirectory
    rmSync(configDirectory, { recursive: true, force: true })
  }
})

test('single-use authorization never selects a session or persistent grant', async t => {
  for (const scope of ['session', 'localPersistent']) {
    const backend = new MuseBackendAdapter({ timeoutMs: 0 })
    t.after(() => backend.close())
    const task = { taskId: 't', ownerId: 'o', turnId: 'turn' }
    const decision = backend.handleApproval({ records: new Set([task]) }, {
      turnId: 'turn', subject: { kind: 'shell', command: 'echo test' },
      availableChoices: [
        { choiceId: 'broad', decision: 'approved', scope },
        { choiceId: 'deny', decision: 'denied', scope: 'once' },
      ],
    })
    const [id] = backend.pendingAuthorizations.keys()
    for (const answer of ['once', 'always']) {
      await assert.rejects(backend.respondAuthorization('t', id, answer, { ownerId: 'o' }),
        /did not offer/)
    }
    assert.equal(backend.pendingAuthorizations.size, 1)
    await backend.respondAuthorization('t', id, 'reject', { ownerId: 'o' })
    assert.deepEqual(await decision, { choiceId: 'deny' })
  }
})

test('pre-cancelled tasks do not start a host or submit a turn', async t => {
  const runtime = fakeRuntime()
  let starts = 0
  const backend = new MuseBackendAdapter({
    clientFactory: async () => { starts++; return runtime.clientFactory() }, timeoutMs: 0,
  })
  t.after(() => backend.close())
  const signal = AbortSignal.abort(new Error('Cancelled'))
  await assert.rejects(backend.submit(work(), { signal }), { code: 'WORK_CANCELLED' })
  assert.equal(starts, 0)
  assert.deepEqual(runtime.calls, [])
})

test('cancellation while creating a session prevents turn submission', async t => {
  const runtime = fakeRuntime()
  const creating = Promise.withResolvers()
  const release = Promise.withResolvers()
  const backend = new MuseBackendAdapter({
    timeoutMs: 0,
    clientFactory: async () => {
      const host = await runtime.clientFactory()
      host.client.startSession = async () => { creating.resolve(); return release.promise }
      return host
    },
  })
  t.after(() => backend.close())
  const pending = backend.submit(work())
  const rejected = assert.rejects(pending, { code: 'WORK_CANCELLED' })
  await creating.promise
  await backend.cancel(work().id, { ownerId: work().ownerId })
  await rejected
  release.resolve(runtime.session)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(runtime.calls.some(call => call.method === 'turn/start'), false)
})

test('cancellation during submission is prompt and cancels a late acknowledged turn', async t => {
  const runtime = fakeRuntime({ hold: true })
  const submitted = Promise.withResolvers()
  const acknowledge = Promise.withResolvers()
  const originalSend = runtime.session.sendUserTurn
  runtime.session.sendUserTurn = async options => {
    const turn = await originalSend(options)
    submitted.resolve()
    await acknowledge.promise
    return turn
  }
  const backend = new MuseBackendAdapter({ clientFactory: runtime.clientFactory, timeoutMs: 0 })
  t.after(() => backend.close())
  const pending = backend.submit(work())
  const rejected = assert.rejects(pending, { code: 'WORK_CANCELLED' })
  await submitted.promise
  await backend.cancel(work().id, { ownerId: work().ownerId })
  await rejected
  assert.equal(runtime.calls.some(call => call.method === 'turn/cancel'), false)
  acknowledge.resolve()
  await new Promise(resolve => setImmediate(resolve))
  const cancels = runtime.calls.filter(call => call.method === 'turn/cancel')
  assert.equal(cancels.length, 1)
  assert.equal(cancels[0].params.turnId, 'turn-1')
})

test('cancelled tasks cannot publish late text or progress', async t => {
  const runtime = fakeRuntime({ hold: true })
  const backend = new MuseBackendAdapter({ clientFactory: runtime.clientFactory, timeoutMs: 0 })
  t.after(() => backend.close())
  const events = []
  const pending = backend.submit(work(), { onEvent: event => events.push(event) })
  const rejected = assert.rejects(pending, { code: 'WORK_CANCELLED' })
  await runtime.started
  await backend.cancel(work().id)
  await rejected
  const count = events.length
  runtime.completion.resolve(completedOutcome())
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(events.length, count)
})

test('concurrent duplicate submissions are rejected before asynchronous startup', async t => {
  const runtime = fakeRuntime({ hold: true })
  const backend = new MuseBackendAdapter({ clientFactory: runtime.clientFactory, timeoutMs: 0 })
  t.after(() => backend.close())
  const pending = backend.submit(work())
  const rejected = assert.rejects(pending, { code: 'WORK_CANCELLED' })
  await assert.rejects(backend.submit(work()), /already active/)
  await runtime.started
  await backend.cancel(work().id)
  await rejected
  assert.equal(runtime.calls.filter(call => call.method === 'turn/start').length, 1)
})

test('isolated utility work does not reuse or replace the owner conversation', async t => {
  const runtime = fakeRuntime()
  const backend = new MuseBackendAdapter({ clientFactory: runtime.clientFactory, timeoutMs: 0 })
  t.after(() => backend.close())
  await backend.submit(work(1))
  const shared = backend.sessions.get('owner-1')
  await backend.submit({ ...work(2), continuity: 'isolated' })
  await backend.submit(work(3))
  assert.equal(backend.sessions.get('owner-1'), shared)
  assert.equal(runtime.calls.filter(call => call.method === 'session/start').length, 2)
})

test('closing during startup releases the late host instead of resurrecting it', async () => {
  const runtime = fakeRuntime()
  const host = Promise.withResolvers()
  const backend = new MuseBackendAdapter({ clientFactory: () => host.promise, timeoutMs: 0 })
  const pending = backend.submit(work())
  const rejected = assert.rejects(pending, { code: 'WORK_CANCELLED' })
  await backend.close()
  await rejected
  host.resolve(await runtime.clientFactory())
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(backend.ready, false)
  assert.equal(backend.client, null)
  assert.equal(runtime.calls.filter(call => call.method === 'client/close').length, 1)
})
