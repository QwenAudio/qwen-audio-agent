import assert from 'node:assert/strict'
import test from 'node:test'
import { TaskManager } from '../src/task/task-manager.mjs'
import { ToolCallHandler } from '../src/voice/tools/tool-call-handler.mjs'
import { TurnTranscripts } from '../src/voice/tools/turn-transcripts.mjs'

function waitFor(predicate, attempts = 100) {
  return new Promise((resolve, reject) => {
    let remaining = attempts
    const check = () => {
      if (predicate()) {
        resolve()
        return
      }
      remaining -= 1
      if (remaining <= 0) {
        reject(new Error('test condition timed out'))
        return
      }
      setTimeout(check, 1)
    }
    check()
  })
}

function setup({ quickLookup, quickQueryTimeoutMs = 15_000 } = {}) {
  const outputs = []
  const ensuredResponses = []
  const results = []
  const timeouts = []
  const failures = []
  const manager = new TaskManager({ progressEventIntervalMs: 50 })
  const transcripts = new TurnTranscripts({ waitMs: 5 })
  const frontend = {
    sendFunctionOutput: async (...args) => outputs.push(args),
    ensureResponse: async (...args) => ensuredResponses.push(args),
  }
  const handler = new ToolCallHandler({
    taskManager: manager,
    ownerId: 'owner',
    sessionId: 'voice',
    transcripts,
    getFrontend: () => frontend,
    getTurnId: () => 'turn-one',
    getTurnGeneration: () => 1,
    backendRuntime: {
      supportsQuickLookup: () => true,
      quickLookup,
      run: async () => ({ content: 'normal work completed' }),
      cancel: async taskId => ({ taskId, state: 'cancelled' }),
    },
    onQuickQueryResult: value => { results.push(value) },
    onQuickQueryTimeout: value => { timeouts.push(value) },
    onQuickQueryFailure: value => { failures.push(value) },
    quickQueryTimeoutMs,
  })
  return {
    outputs,
    ensuredResponses,
    results,
    timeouts,
    failures,
    manager,
    handler,
  }
}

function quickCall(callId = 'quick-call') {
  return {
    call_id: callId,
    name: 'quick_lookup',
    arguments: JSON.stringify({ query: 'How do I configure MCP?' }),
  }
}

test('acknowledges immediately and delivers the verified quick result later', async () => {
  const pending = Promise.withResolvers()
  const kit = setup({
    quickLookup: async () => pending.promise,
  })

  await kit.handler.handle(quickCall(), {
    turnId: 'turn-one',
    turnGeneration: 1,
    responseId: 'response-one',
  })
  await kit.handler.finishToolResponse('response-one')
  assert.equal(kit.outputs[0][1].status, 'accepted')
  assert.equal(kit.outputs[0][1].request_id.startsWith('quick_'), true)
  assert.match(kit.ensuredResponses[0][1].response.instructions, /承接/)
  assert.equal(kit.results.length, 0)

  pending.resolve({ content: 'Use the configured MCP server.' })
  await waitFor(() => kit.results.length === 1)
  assert.equal(kit.results[0].result.content, 'Use the configured MCP server.')
  assert.equal(kit.timeouts.length, 0)
  assert.equal(kit.failures.length, 0)
})

test('promotes a timed-out lookup to one normal Work', async () => {
  const kit = setup({
    quickQueryTimeoutMs: 5,
    quickLookup: (_query, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      void resolve
    }),
  })

  await kit.handler.handle(quickCall('timeout-call'), {
    turnId: 'turn-one',
    turnGeneration: 1,
    responseId: 'response-timeout',
  })
  await waitFor(() => kit.timeouts.length === 1)
  assert.equal(kit.timeouts[0].task.status, 'queued')
  assert.equal(kit.timeouts[0].task.objective, 'How do I configure MCP?')
  const finished = await kit.manager.wait(kit.timeouts[0].task.id)
  assert.equal(finished.status, 'completed')
  assert.equal(kit.failures.length, 0)
})

test('drops a pending lookup when the user interrupts it', async () => {
  const pending = Promise.withResolvers()
  let aborted = false
  const kit = setup({
    quickLookup: async (_query, { signal }) => {
      signal.addEventListener('abort', () => { aborted = true }, { once: true })
      return pending.promise
    },
  })

  await kit.handler.handle(quickCall('interrupt-call'), {
    turnId: 'turn-one',
    turnGeneration: 1,
    responseId: 'response-interrupt',
  })
  kit.handler.cancelQuickQueries('new_user_turn')
  pending.resolve({ content: 'late result' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(aborted, true)
  assert.equal(kit.results.length, 0)
  assert.equal(kit.timeouts.length, 0)
})
