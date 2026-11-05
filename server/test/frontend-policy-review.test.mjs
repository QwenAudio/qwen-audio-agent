import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { FrontendPolicyReview, policyReviewOptions, interactionRules, decidePolicy } from '../src/voice/frontend-policy-review.mjs'
const tick = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
function harness(decide, timeoutMs = 100) {
  const calls = []
  const frontend = { cancel: () => calls.push('cancel'),
    injectDelivery: async (text, origin, _context, options) => { calls.push({ text: JSON.parse(text), origin, options }); return { contextInjected: true } },
    ensureResponse: async (...args) => calls.push({ resume: args }),
  }
  const review = new FrontendPolicyReview({ options: { enabled: true, timeoutMs }, decide,
    getPrompt: () => '# Routing\n\n不得虚构完成。\n\n# Background work\n\n先提交任务。',
    getHistory: () => [{ role: 'user', content: '我刚才说了不要再说已经发出', turnId: 't0' }],
    getTools: () => [{ name: 'send', status: 'failed' }], getTasks: () => [],
    getFrontend: () => frontend, getTurn: () => ({ turnId: 't2', turnGeneration: 2 }),
  })
  const start = () => review.review({ responseId: 'r1', context: { turnId: 't1' }, text: '已经发送了' })
  return { review, calls, start }
}

test('default off leaves all review hooks inert', () => {
  assert.equal(policyReviewOptions({}).enabled, false)
  assert.throws(() => policyReviewOptions({ QWEN_AUDIO_POLICY_REVIEW: 'on' }))
  const { review, calls, start } = harness(() => assert.fail())
  review.options.enabled = false
  start()
  assert.equal(review.intercept({ response: { id: 'r2' } }), false)
  assert.deepEqual(calls, [])
})

test('rules derive from system routing/background sections, not persona text', () => {
  const rules = interactionRules('# Role\n\n人设\n# Routing\n\n规则1\n\n规则2\n# Context\n\n其他')
  assert.equal(rules.length, 2)
  assert.deepEqual(rules.map(rule => rule.text), ['规则1', '规则2'])
})

test('current reply is unbuffered, next generation is cancelled until correction is injected', async () => {
  const pending = deferred()
  const { review, calls, start } = harness(async input => {
    assert.equal(input.state.tool_events[0].status, 'failed')
    assert.match(input.state.history[0].content, /不要再说/)
    return pending.promise
  })
  assert.equal(review.intercept({ response: { id: 'r1' } }), false)
  start()
  assert.deepEqual(calls, [])
  assert.equal(review.intercept({ response: { id: 'r2' } }), true)
  assert.equal(review.intercept({ response_id: 'r2', type: 'response.audio.delta' }), true)
  assert.deepEqual(calls, ['cancel'])
  pending.resolve([{ id: 'rule', rule: '不得虚构完成' }])
  await tick()
  assert.equal(calls[1].origin, 'policy-review')
  assert.equal(calls[1].options.route, 'context')
  assert.equal(calls[2].resume[0].turnId, 't2')
  assert.equal(review.intercept({ response: { id: 'r3' } }), false)
})

test('timeout fails open even if transport ignores abort; late violation is discarded', async () => {
  const pending = deferred()
  const { review, calls, start } = harness(() => pending.promise, 5)
  start()
  review.intercept({ response: { id: 'r2' } })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(calls.length, 2)
  assert.ok(calls[1].resume)
  pending.resolve([{ id: 'late', rule: 'late' }])
  await tick()
  assert.equal(review.violations.length, 0)
})

test('review errors fail open and disconnect prevents correction or regeneration', async () => {
  const { review, calls, start } = harness(async () => { throw new Error('offline') })
  start()
  review.intercept({ response: { id: 'r2' } })
  await tick()
  assert.ok(calls[1].resume)
  const other = harness(() => new Promise(() => {}), 5)
  other.start()
  other.review.intercept({ response: { id: 'r2' } })
  other.review.close()
  await new Promise(resolve => setTimeout(resolve, 15))
  assert.deepEqual(other.calls, ['cancel'])
})

test('JEV adapter sends choice questions and validates model, input hash and option ordering', async () => {
  function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical)
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  }
  const fetchImpl = async (_url, options) => {
    const input = JSON.parse(options.body)
    const result = { backend: 'jev_omni', model: 'Jev-Omni/unified',
      input_hash: createHash('sha256').update(JSON.stringify(canonical(input))).digest('hex'),
      answers: input.questions.map(q => ({ question_id: q.id, primitive: q.primitive, option_ids: q.options.map(o => o.id), choice: 'violation' })) }
    return { ok: true, json: async () => result }
  }
  const result = await decidePolicy({ endpoint: 'http://local/decide', state: { text: '文本' }, rules: [{ id: 'r', text: '规则' }], fetchImpl })
  assert.equal(result.length, 2)
  await assert.rejects(decidePolicy({ endpoint: 'http://local/decide', state: {}, rules: [],
    fetchImpl: async () => ({ ok: true, json: async () => ({ backend: 'other' }) }) }))
})

test('system Role restrictions about internal backend structure are reviewed', () => {
  assert.match(interactionRules('# Role\n\n不要暴露后台结构。')[0].text, /不要暴露/)
})

test('ready violation waits for the next response, and newer user turn owns regeneration', async () => {
  const { review, calls, start } = harness(async () => [{ id: 'repeated_correction', rule: '不要重复用户纠正的错误' }])
  start()
  await tick()
  assert.deepEqual(calls, [])
  let turn = { turnId: 't2', turnGeneration: 2 }
  review.getTurn = () => turn
  review.intercept({ response: { id: 'r2' } })
  turn = { turnId: 't3', turnGeneration: 3 }
  await tick()
  assert.equal(calls.at(-1).resume[0].turnId, 't3')
  assert.equal(calls.at(-1).resume[1].shouldCreate(), true)
  turn = { turnId: 't4', turnGeneration: 4 }
  assert.equal(calls.at(-1).resume[1].shouldCreate(), false)
})

test('disabled configuration ignores unused endpoint and timeout settings', () => {
  assert.equal(policyReviewOptions({ QWEN_AUDIO_POLICY_REVIEW: 'off', QWEN_AUDIO_POLICY_REVIEW_TIMEOUT_MS: 'invalid' }).enabled, false)
})

test('context injection failure still supplies correction through regeneration instructions', async () => {
  const { review, calls, start } = harness(async () => [{ id: 'rule', rule: '必须先执行' }])
  const frontend = review.getFrontend()
  frontend.injectDelivery = async () => { throw new Error('cannot inject') }
  start()
  await tick()
  review.intercept({ response: { id: 'r2' } })
  await tick()
  assert.match(calls.at(-1).resume[1].response.instructions, /必须先执行/)
})
