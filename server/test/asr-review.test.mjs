import test from 'node:test'
import assert from 'node:assert/strict'
import { TurnTranscripts } from '../src/frontend/tools/turn-transcripts.mjs'
import { ToolCallHandler } from '../src/frontend/tools/tool-call-handler.mjs'
import { AgentTaskRuntime } from '../src/frontend/tools/agent-task-runtime.mjs'
import { asrReviewOptions, reviewWindow, reviewInterpretation, dualQueryInstruction } from '../src/frontend/tools/asr-review.mjs'

function host(decision = 'clarify') {
  const transcripts = new TurnTranscripts()
  const outputs = [], work = [], requests = []
  const runtime = new ToolCallHandler({
    ownerId: 'o', sessionId: 's', transcripts,
    asrReview: { enabled: true, delegation: 'confirm' },
    getFrontend: () => ({}), getTurnId: () => 't3', getTurnGeneration: () => 1,
    backendRuntime: { async run(input, options) {
      requests.push({ input, options })
      return { content: JSON.stringify({ decision, differences: decision === 'match' ? [] : [{ field: 'name', asr: 'Yusuf Rossi', frontend: 'Yusuf Razi', possible_asr_error: 'surname' }], question: '姓是 Rossi 还是 Razi？' }) }
    } },
  })
  runtime.sendOutput = async (...args) => outputs.push(args)
  runtime.createWork = input => { if (input.kind === 'asr_review') { runtime.reviewInput = input; return { id: 'review' } } work.push(input); return { id: 'task' } }
  runtime.taskOperations = { list: () => [], cancel: async () => {}, taskManager: { wait: async () => {
    const result = await runtime.backendRuntime.run(runtime.reviewInput, { signal: runtime.signal })
    return { status: 'completed', result: result.content }
  } } }
  return { runtime, transcripts, outputs, work, requests }
}

test('configuration is explicit, off by default, rejects misspellings', () => {
  assert.deepEqual(asrReviewOptions({}), { enabled: false, frontend: false, backend: false, delegation: 'confirm' })
  assert.throws(() => asrReviewOptions({ QWEN_AUDIO_ASR_REVIEW: 'true' }))
})

test('window includes current plus two prior user turns and assistant replies', () => {
  const messages = [1, 2, 3, 4].flatMap(i => [
    { role: 'user', turnId: `t${i}`, content: `user${i}` },
    { role: 'assistant', turnId: `t${i}`, content: `reply${i}` },
  ])
  const packet = reviewWindow(messages, 't3', 'current ASR')
  assert.deepEqual(packet.history.map(x => x.content), ['user1', 'reply1', 'user2', 'reply2', 'user3', 'reply3'])
  assert.equal(reviewWindow(messages, 't4', 'x').history[0].content, 'user2')
})

test('waits beyond ordinary transcript timeout for final ASR; no tool executes early', async () => {
  const { runtime, transcripts, outputs, requests } = host()
  let executions = 0
  const pending = runtime.executeExternalToolCall({ tool: { name: 'lookup' }, source: { execute: async () => { executions++; return {} } } },
    { callId: 'c', turnId: 't3', turnGeneration: 1, args: { name: 'Yusuf Razi' } })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(requests.length, 0)
  transcripts.record('t3', 'Find Yusuf Rossi')
  await pending
  assert.equal(executions, 0)
  assert.equal(outputs[0][1].status, 'clarification_required')
  assert.match(outputs[0][4].response.instructions, /口语/)
  assert.match(requests[0].input.objective, /Yusuf Rossi/)
})

test('matching frontend tool executes unchanged exactly once', async () => {
  const { runtime, transcripts, outputs } = host('match')
  transcripts.record('t3', 'find Yusuf Rossi')
  let executions = 0
  await runtime.executeExternalToolCall({ tool: { name: 'lookup' }, source: { execute: async (_name, args) => { executions++; assert.equal(args.name, 'Yusuf Rossi'); return { found: true } } } },
    { callId: 'c', turnId: 't3', turnGeneration: 1, args: { name: 'Yusuf Rossi' } })
  assert.equal(executions, 1)
  assert.equal(outputs[0][1].found, true)
})

test('malformed backend response fails closed, never executes', async () => {
  const { runtime, transcripts, outputs } = host()
  transcripts.record('t3', 'x')
  runtime.backendRuntime.run = async () => ({ content: 'not JSON' })
  await runtime.executeExternalToolCall({ tool: { name: 'lookup' }, source: { execute: () => assert.fail('must not execute') } },
    { callId: 'c', turnId: 't3', turnGeneration: 1, args: {} })
  assert.equal(outputs[0][1].error_code, 'asr_review_unavailable')
})

test('delegation mismatch in confirm mode returns question without submitting', async () => {
  const { runtime, transcripts, outputs, work } = host()
  transcripts.record('t3', 'find Yusuf Rossi')
  await new AgentTaskRuntime(runtime).executeSpawnThinkingToolCall({ callId: 'c', turnId: 't3', generation: 1,
    args: { objective: 'find Yusuf Razi' }, event: {}, callContext: {} })
  assert.equal(work.length, 0)
  assert.equal(outputs[0][1].status, 'clarification_required')
})

test('dual-query prompt contains both candidates, result precedence and action prohibition', async () => {
  const { runtime, transcripts } = host()
  transcripts.record('t3', 'find Yusuf Rossi')
  const review = await reviewInterpretation(runtime, { turnId: 't3', kind: 'delegation', interpretation: { objective: 'find Yusuf Razi' } })
  const prompt = dualQueryInstruction(review, 'find Yusuf Razi')
  assert.match(prompt, /Yusuf Rossi/)
  assert.match(prompt, /Yusuf Razi/)
  assert.match(prompt, /两种均查不到/)
  assert.match(prompt, /禁止.*操作尝试两种参数/)
})

test('capability query shares delegation submission and receipt, with a capability task kind', async () => {
  const { runtime, outputs, work, requests } = host()
  await runtime.executeCapabilityQuery({ callId: 'c', turnId: 't3', generation: 1,
    args: { request: 'send email' }, event: {}, callContext: {} })
  assert.equal(work.length, 1)
  assert.equal(work[0].kind, 'capability_query')
  assert.match(work[0].objective, /不执行用户请求中的实际操作/)
  assert.match(work[0].objective, /send email/)
  assert.equal(outputs[0][1].status, 'accepted')
  assert.equal(outputs[0][1].task_id, 'task')
  assert.equal(requests.length, 0, 'no separate isolated backend call or ASR review')
})

test('final transcript wait times out explicitly and is released on session close', async () => {
  const transcripts = new TurnTranscripts()
  assert.equal(await transcripts.finalTranscript('missing', 5), '')
  const pending = transcripts.finalTranscript('closed')
  transcripts.close()
  assert.equal(await pending, '')
})

test('a superseded turn never executes its tool after review returns', async () => {
  const { runtime, transcripts } = host('match')
  transcripts.record('t3', 'find Yusuf Rossi')
  runtime.getTurnGeneration = () => 2
  let closed = false
  runtime.closeStaleCall = async () => { closed = true }
  await runtime.executeExternalToolCall({ tool: { name: 'lookup' }, source: { execute: () => assert.fail('stale operation') } },
    { callId: 'c', turnId: 't3', turnGeneration: 1, args: {} })
  assert.equal(closed, true)
})

test('delegation dual-query submits both interpretations and current ASR', async () => {
  const { runtime, transcripts, work } = host()
  runtime.asrReview.delegation = 'dual-query'
  transcripts.record('t3', 'find Yusuf Rossi')
  // Submission receipt bookkeeping is unrelated to review; capture its payload.
  runtime.sendWorkReceipt = async () => {}
  await new AgentTaskRuntime(runtime).executeSpawnThinkingToolCall({ callId: 'c', turnId: 't3', generation: 1,
    args: { objective: 'find Yusuf Razi' }, event: {}, callContext: {} })
  assert.equal(work.length, 1)
  assert.match(work[0].objective, /Yusuf Rossi/)
  assert.match(work[0].objective, /Yusuf Razi/)
  assert.match(work[0].objective, /两种均查不到/)
})

test('disconnect during backend review cancels its signal and cannot execute', async () => {
  const { runtime, transcripts } = host('match')
  transcripts.record('t3', 'find Yusuf Rossi')
  const controller = new AbortController()
  runtime.signal = controller.signal
  runtime.closeStaleCall = async () => {}
  runtime.backendRuntime.run = async (_input, { signal }) => {
    assert.equal(signal, controller.signal)
    controller.abort()
    return { content: JSON.stringify({ decision: 'match', differences: [], question: '' }) }
  }
  await runtime.executeExternalToolCall({ tool: { name: 'lookup' }, source: { execute: () => assert.fail('disconnected operation') } },
    { callId: 'c', turnId: 't3', turnGeneration: 1, args: {} })
})

test('email spellings survive review verbatim, neither candidate is silently normalized', async () => {
  const { runtime, transcripts, requests } = host()
  transcripts.record('t3', 'email fatima.wilson5721@example.com')
  await reviewInterpretation(runtime, { turnId: 't3', kind: 'frontend-tool',
    interpretation: { tool: 'find_contact', arguments: { email: 'fathima.wilson5721@example.com' } } })
  assert.match(requests[0].input.objective, /fatima\.wilson5721@example\.com/)
  assert.match(requests[0].input.objective, /fathima\.wilson5721@example\.com/)
})

test('review off preserves ordinary frontend execution without ASR or backend', async () => {
  const { runtime, requests } = host()
  runtime.asrReview.enabled = false
  let executions = 0
  await runtime.executeExternalToolCall({ tool: { name: 'lookup' }, source: { execute: async () => { executions++; return {} } } },
    { callId: 'c', turnId: 't3', turnGeneration: 1, args: {} })
  assert.equal(executions, 1)
  assert.equal(requests.length, 0)
})

test('frontend-only review leaves backend delegation untouched', async () => {
  const { runtime, requests, work } = host()
  runtime.asrReview = { enabled: true, frontend: true, backend: false, delegation: 'dual-query' }
  await runtime.executeSpawnThinkingToolCall({ callId: 'c', turnId: 't3', generation: 1,
    args: { objective: 'find Yusuf Razi' }, event: {}, callContext: {} })
  assert.equal(requests.length, 0)
  assert.equal(work[0].objective, 'find Yusuf Razi')
})

test('delegation-only review leaves frontend tool execution untouched', async () => {
  const { runtime, requests } = host()
  runtime.asrReview = { enabled: true, frontend: false, backend: true, delegation: 'confirm' }
  let executions = 0
  await runtime.executeExternalToolCall({ tool: { name: 'lookup' }, source: { execute: async () => { executions++; return {} } } },
    { callId: 'c', turnId: 't3', turnGeneration: 1, args: {} })
  assert.equal(requests.length, 0)
  assert.equal(executions, 1)
})
