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
    backendRuntime: { async runIsolated(input, options) {
      requests.push({ input, options })
      return { content: JSON.stringify({ decision, differences: decision === 'match' ? [] : [{ field: 'name', asr: 'Yusuf Rossi', frontend: 'Yusuf Razi', possible_asr_error: 'surname' }], question: '姓是 Rossi 还是 Razi？' }) }
    } },
  })
  runtime.sendOutput = async (...args) => outputs.push(args)
  runtime.createWork = input => { work.push(input); return { id: 'task' } }
  runtime.taskOperations = { list: () => [] }
  return { runtime, transcripts, outputs, work, requests }
}

test('configuration is explicit, off by default, rejects misspellings', () => {
  assert.deepEqual(asrReviewOptions({}), { enabled: false, delegation: 'confirm' })
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
  runtime.backendRuntime.runIsolated = async () => ({ content: 'not JSON' })
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

test('capability query uses isolated backend and reports failure without claiming inability', async () => {
  const { runtime, outputs, requests } = host()
  await runtime.executeCapabilityQuery({ callId: 'c', turnId: 't3', args: { request: 'send email' } })
  assert.match(requests[0].input.objective, /不执行任何用户操作/)
  runtime.backendRuntime.runIsolated = async () => { throw new Error('offline') }
  await runtime.executeCapabilityQuery({ callId: 'd', turnId: 't3', args: { request: 'send email' } })
  assert.equal(outputs[1][1].status, 'unavailable')
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
