import test from 'node:test'
import assert from 'node:assert/strict'
import { assistantText, toolCall, isTaskBlocking, safeEvent, withTauPolicy, affectsTurnSettlement } from '../realtime-harness.mjs'

test('Realtime 和 Gateway 的最终文本，忽略流式片段和用户转写', () => {
  assert.equal(assistantText({ type: 'transcript.final', role: 'assistant', content: 'result' }), 'result')
  assert.equal(assistantText({ type: 'response.text.done', text: 'result' }), 'result')
  assert.equal(assistantText({ type: 'transcript.final', role: 'user', content: 'private' }), '')
  assert.equal(assistantText({ type: 'response.text.delta', delta: 'partial' }), '')
})

test('工具调用保留原始参数；不把坏 JSON 静默变成空对象', () => {
  assert.deepEqual(toolCall({ type: 'response.function_call_arguments.done', call_id: 'c', name: 'get_order', arguments: '{"id":"123"}' }),
    { callId: 'c', name: 'get_order', args: { id: '123' } })
  assert.throws(() => toolCall({ type: 'response.function_call_arguments.done', arguments: 'invalid' }))
})

test('后台运行时不能提前把阶段性回复交给用户；等审批时允许用户回答', () => {
  assert.equal(isTaskBlocking({ status: 'running' }), true)
  assert.equal(isTaskBlocking({ status: 'delegated' }), true)
  assert.equal(isTaskBlocking({ status: 'running', inputRequest: { status: 'pending' } }), false)
  assert.equal(isTaskBlocking({ status: 'completed' }), false)
  assert.equal(isTaskBlocking({ status: 'failed' }), false)
})

test('等待审批时的后台轮询心跳不阻塞模拟用户回答；真正的新消息会推迟结算', () => {
  assert.equal(affectsTurnSettlement({ type: 'task.progress' }), false)
  assert.equal(affectsTurnSettlement({ type: 'task.snapshot' }), false)
  assert.equal(affectsTurnSettlement({ type: 'agent.activity' }), false)
  assert.equal(affectsTurnSettlement({ type: 'transcript.final' }), true)
  assert.equal(affectsTurnSettlement({ type: 'task.input.requested' }), true)
  assert.equal(affectsTurnSettlement({ type: 'tool.call' }), true)
})

test('注入完整官方 policy，不受 Assistant profile 字数截断；不改原始 provider', () => {
  const original = { protocol: { normalizeIncoming: e => e, responseCreate: r => ({ type: 'response.create', response: r }) },
    buildSession: () => ({ instructions: 'framework', tools: ['native'], modalities: ['audio'], voice: 'v', output_audio_format: 'pcm' }),
    buildSpeakResponse: text => ({ instructions: text }), buildResultInjection: text => ({ item: text, response: {} }) }
  const policy = 'official policy '.repeat(1000)
  const definition = { name: 'write', description: 'official', inputSchema: { type: 'object' } }
  const only = withTauPolicy(original, { policy, mode: 'realtime-only', definitions: [definition] })
  const full = withTauPolicy(original, { policy, mode: 'harness', definitions: [definition] })
  const session = only.buildSession({ configured: false })
  assert.ok(session.instructions.includes(policy))
  assert.ok(!session.instructions.includes('framework'))
  assert.deepEqual(session.tools[0].function.parameters, definition.inputSchema)
  assert.deepEqual(session.modalities, ['text'])
  assert.equal(session.voice, undefined)
  const harnessInstructions = full.buildSession({ configured: false }).instructions
  assert.ok(!harnessInstructions.includes('framework'))
  assert.ok(harnessInstructions.includes(policy))
  assert.ok(harnessInstructions.indexOf(policy) < harnessInstructions.indexOf('Use frontend MCP tools'))
  assert.match(harnessInstructions, /original selection criteria, and unresolved candidates/)
  assert.match(harnessInstructions, /NOT a business inability/)
  assert.match(harnessInstructions, /without an extra generic confirmation/)
  assert.match(harnessInstructions, /NEW explicit customer approval/)
  assert.match(harnessInstructions, /MUST call spawn_thinking in that same turn/)
  assert.match(harnessInstructions, /Never claim the service lacks the capability/)
  assert.match(harnessInstructions, /decline the current preview with respond_agent_input/)
  assert.match(harnessInstructions, /do not cancel the whole task/)
  assert.ok(harnessInstructions.length - policy.length < 2_500)
  const evaTime = withTauPolicy(original, { policy, mode: 'harness', definitions: [definition],
    currentDateTime: '2026-03-20 09:30:00' }).buildSession({ configured: false }).instructions
  assert.match(evaTime, /2026-03-20 09:30:00/)
  assert.doesNotMatch(evaTime, /2024-05-15 15:00:00/)
  const legacy = withTauPolicy(original, { policy, mode: 'harness', definitions: [definition], promptVariant: 'legacy' })
  const legacyInstructions = legacy.buildSession({ configured: false }).instructions
  assert.ok(legacyInstructions.startsWith('framework'))
  assert.ok(legacyInstructions.includes('Delegate ALL database updates'))
  assert.match(legacyInstructions, /MUST call spawn_thinking in that same turn/)
  assert.match(legacyInstructions, /DECLINE the current preview with respond_agent_input/)
  assert.match(legacyInstructions, /do not cancel the whole task/)
  assert.ok(legacyInstructions.includes(policy))
  assert.ok(legacyInstructions.length > harnessInstructions.length)
  assert.throws(() => withTauPolicy(original, { policy, mode: 'harness', definitions: [], promptVariant: 'unknown' }))
  assert.deepEqual(full.buildSession({ configured: true }).tools, ['native'])
  assert.equal(original.buildSession().voice, 'v')
  const protocol = full.createProtocol()
  protocol.responseCreate({})
  protocol.normalizeIncoming({ type: 'response.created', response: { id: 'r' } })
  assert.equal(full.benchmarkState.responseCreates, 1)
  assert.equal(full.benchmarkState.activeResponses.size, 1)
  protocol.normalizeIncoming({ type: 'response.done', response: { id: 'r' } })
  assert.equal(full.benchmarkState.activeResponses.size, 0)
})

test('轨迹不保存 PCM 数据；序列化不改原事件', () => {
  const event = { type: 'response.audio.delta', delta: 'base64pcm' }
  assert.equal(safeEvent(event).delta, '<audio>')
  assert.equal(event.delta, 'base64pcm')
})
