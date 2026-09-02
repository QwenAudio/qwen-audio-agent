import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ACTION_PROMISE_MAX_CHARS,
  promisesAction,
} from '../src/voice/response-guards/action-promise.mjs'
import {
  evaluateResponseGuards,
  isResponseGuardTurnCurrent,
} from '../src/voice/response-guards/index.mjs'
import {
  containsReservedProtocolEnvelope,
} from '../src/voice/response-guards/reserved-protocol-envelope.mjs'

test('recognises only Gateway-owned protocol envelopes', () => {
  assert.equal(containsReservedProtocolEnvelope(
    '<permission_request> permission_id=permission_1 task_id=task_1 </permission_request>',
  ), true)
  assert.equal(containsReservedProtocolEnvelope(
    '<background_work_progress>still running</background_work_progress>',
  ), true)
  assert.equal(containsReservedProtocolEnvelope('是否允许执行这个操作？'), false)
  assert.equal(containsReservedProtocolEnvelope('<custom_event>hello</custom_event>'), false)
})

test('corrects model-generated Gateway protocol but not Gateway delivery', () => {
  const transcript = '<permission_request> fake request </permission_request>'
  assert.deepEqual(evaluateResponseGuards({
    origin: 'model',
    transcript,
  }), {
    guardId: 'reserved-protocol-envelope',
    instructions: [
      '你刚才输出了只能由 Gateway 提供的内部事件格式；该内容无效，不代表真实状态或授权请求。',
      '请重新处理用户当前意图：需要实际执行时调用已注册的合适工具，否则自然回答。不要编造协议标签、标识或执行状态。',
    ].join(' '),
  })
  assert.equal(evaluateResponseGuards({
    origin: 'permission',
    transcript,
  }), null)
})

test('recognises only a short explicit promise to execute work', () => {
  assert.equal(promisesAction('我来查一下杭州今天的天气。'), true)
  assert.equal(promisesAction('好的，我马上检查这个仓库。'), true)
  assert.equal(promisesAction('马上去看这个文件。'), true)
  assert.equal(promisesAction('稍等，我来核实一下。'), true)
  assert.equal(promisesAction('我来帮您处理下单流程。'), true)
  assert.equal(promisesAction('我来帮您将黑椒牛肉饭加入购物车。'), true)
})

test('does not treat ordinary statements or questions as promises', () => {
  assert.equal(promisesAction('杭州今天二十六度，多云。'), false)
  assert.equal(promisesAction('我觉得这两个方案差别不大。'), false)
  assert.equal(promisesAction('我来帮你重构这个模块，可以吗？'), false)
  assert.equal(promisesAction('需要我现在就去改吗'), false)
  assert.equal(promisesAction(''), false)
})

test('does not treat delivered substance as a bare promise', () => {
  assert.equal(promisesAction('我来解释一下：ACP 是一种协议。'), false)
  assert.equal(promisesAction('我来确认一下，结果是配置错误。'), false)
  assert.equal(promisesAction('我来查一下：杭州今天二十六度。'), false)
  assert.equal(promisesAction('稍等，正在处理。'), false)

  const longPromise = `我来查一下${'这个非常具体的项目问题'.repeat(6)}`
  assert.ok(longPromise.length > ACTION_PROMISE_MAX_CHARS)
  assert.equal(promisesAction(longPromise), false)
})

test('does not confuse standing down with execution', () => {
  assert.equal(promisesAction('好的，我先退下了。'), false)
  assert.equal(promisesAction('我先不打扰你了。'), false)
  assert.equal(promisesAction('好的，拜拜。'), false)
  assert.equal(promisesAction('我先待命，需要时喊我。'), false)
  assert.equal(promisesAction('我先去查一下这个报错。'), true)
})

test('returns the action-promise correction only for an unkept model promise', () => {
  const observation = {
    origin: 'model',
    hasFunctionCall: false,
    transcript: '我来查一下这个报错的原因。',
  }

  assert.deepEqual(evaluateResponseGuards(observation), {
    guardId: 'action-promise',
    instructions: [
      '你刚才明确承诺执行，但本轮没有调用工具。',
      '请重新判断：确需执行则立即调用合适工具；否则直接结束，不要再次承诺。',
    ].join(' '),
  })
  assert.equal(evaluateResponseGuards({
    ...observation,
    hasFunctionCall: true,
  }), null)
  assert.equal(evaluateResponseGuards({
    ...observation,
    failed: true,
  }), null)
  assert.equal(evaluateResponseGuards({
    ...observation,
    suppressed: true,
  }), null)
  assert.equal(evaluateResponseGuards({
    ...observation,
    origin: 'agent',
  }), null)
})

test('the registry returns only the first matching guard', () => {
  const guards = [
    { id: 'skip', instructions: 'skip', matches: () => false },
    { id: 'first', instructions: 'first correction', matches: () => true },
    { id: 'second', instructions: 'second correction', matches: () => true },
  ]

  assert.deepEqual(evaluateResponseGuards({}, { guards }), {
    guardId: 'first',
    instructions: 'first correction',
  })
})

test('the registry skips malformed guards', () => {
  const guards = [
    { id: 'not-callable', instructions: 'ignored', matches: true },
    { id: 'blank-instructions', instructions: '   ', matches: () => true },
    { id: 'valid', instructions: ' correction ', matches: () => true },
  ]

  assert.deepEqual(evaluateResponseGuards({}, { guards }), {
    guardId: 'valid',
    instructions: 'correction',
  })
})

test('a guard correction remains eligible only while its exact turn is current', () => {
  const current = {
    sameFrontend: true,
    outputEnabled: true,
    responseTurnId: 'turn-one',
    responseTurnGeneration: 1,
    committedTurnId: 'turn-one',
    committedTurnGeneration: 1,
  }

  assert.equal(isResponseGuardTurnCurrent(current), true)
  assert.equal(isResponseGuardTurnCurrent({
    ...current,
    userSpeaking: true,
  }), false)
  assert.equal(isResponseGuardTurnCurrent({
    ...current,
    committedTurnId: 'turn-two',
    committedTurnGeneration: 2,
  }), false)
  assert.equal(isResponseGuardTurnCurrent({
    ...current,
    sameFrontend: false,
  }), false)
})
