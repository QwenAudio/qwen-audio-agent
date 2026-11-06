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
    getPrompt: () => '# Routing\n\n仅当直接回答就能满足用户请求时，才直接回答。不要未经尝试就声称做不到。',
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

test('only refusal routing paragraph is extracted; other rules are excluded', () => {
  const rules = interactionRules('# Role\n\n不要暴露后台。\n# Routing\n\n仅当直接回答就能满足用户请求时，才直接回答。\n\n规则2\n# Background work\n\n取消任务。')
  assert.equal(rules.length, 1)
  assert.deepEqual(rules.map(rule => rule.text), ['仅当直接回答就能满足用户请求时，才直接回答。'])
})

test('next output is buffered without cancellation, ok replays audio and tools in order', async () => {
  const pending = deferred()
  const { review, calls, start } = harness(() => pending.promise)
  const replayed = []
  start()
  for (const type of ['response.created', 'response.audio.delta', 'response.function_call_arguments.done', 'response.done']) {
    assert.equal(review.intercept({ type, response_id: 'r2' }, {}, e => replayed.push(e.type)), true)
  }
  assert.deepEqual(calls, [])
  assert.deepEqual(replayed, [])
  pending.resolve([])
  await tick()
  assert.deepEqual(replayed, ['response.created', 'response.audio.delta', 'response.function_call_arguments.done', 'response.done'])
  assert.deepEqual(calls, [])
})

test('violation discards buffered output, injects original reply and fixed repair before regeneration', async () => {
  const pending = deferred()
  const { review, calls, start } = harness(async ({ rules }) => { await pending.promise; return [{ id: rules[0].id, correction: 'UNTRUSTED REMEDY' }] })
  start()
  review.intercept({ type: 'response.audio.delta', response_id: 'r2' }, {}, () => assert.fail('discarded'))
  assert.deepEqual(calls, [])
  pending.resolve()
  await tick()
  assert.equal(calls[0], 'cancel')
  const correction = calls[1].text.corrections[0]
  assert.equal(correction.assistant_text, '已经发送了')
  assert.equal(correction.turn_id, 't1')
  assert.match(correction.violations[0].correction, /先简短向用户说明/)
  assert.doesNotMatch(JSON.stringify(correction), /UNTRUSTED/)
  assert.equal(calls[2].resume[1].waitForSpeechStopped, true)
  assert.match(calls[2].resume[1].response.instructions, /再回答最新一轮/)
})

test('timeout replays buffered output without regeneration and ignores late verdict', async () => {
  const pending = deferred()
  const { review, calls, start } = harness(() => pending.promise, 5)
  const replayed = []
  start()
  review.intercept({ response: { id: 'r2' } }, {}, e => replayed.push(e))
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(replayed.length, 1)
  assert.deepEqual(calls, [])
  pending.resolve([{ id: 'late' }])
  await tick()
  assert.equal(review.violations.length, 0)
})

test('error fails open; closing discards buffer and forbids later playback', async () => {
  const { review, calls, start } = harness(async () => { throw new Error('offline') })
  let replayed = 0
  start()
  review.intercept({ response: { id: 'r2' } }, {}, () => replayed++)
  await tick()
  assert.equal(replayed, 1)
  assert.deepEqual(calls, [])
  const other = harness(() => new Promise(() => {}), 5)
  other.start()
  other.review.intercept({ response: { id: 'r2' } }, {}, () => assert.fail('closed'))
  other.review.close()
  await new Promise(resolve => setTimeout(resolve, 15))
  assert.deepEqual(other.calls, [])
})

test('JEV adapter sends choice questions and validates model, input hash and option ordering', async () => {
  function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical)
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  }
  const fetchImpl = async (_url, options) => {
    const input = JSON.parse(options.body)
    assert.equal(input.questions.length, 1)
    assert.match(input.questions[0].instructions, /只检查.*未经尝试就声称做不到/)
    assert.notEqual(input.questions[0].id, 'repeated_correction')
    const result = { backend: 'jev_omni', model: 'Jev-Omni/unified',
      input_hash: createHash('sha256').update(JSON.stringify(canonical(input))).digest('hex'),
      answers: input.questions.map(q => ({ question_id: q.id, primitive: q.primitive, option_ids: q.options.map(o => o.id), choice: 'violation' })) }
    return { ok: true, json: async () => result }
  }
  const result = await decidePolicy({ endpoint: 'http://local/decide', state: { text: '文本' }, rules: [{ id: 'r', text: '规则' }], fetchImpl })
  assert.equal(result.length, 1)
  assert.match(result[0].correction, /spawn_thinking/)
  await assert.rejects(decidePolicy({ endpoint: 'http://local/decide', state: {}, rules: [],
    fetchImpl: async () => ({ ok: true, json: async () => ({ backend: 'other' }) }) }))
})

test('Role and repeated user correction are outside the current scope', () => {
  assert.deepEqual(interactionRules('# Role\n\n不要暴露后台结构。'), [])
})

test('violation during user speech waits until stopped and resumes the latest turn', async () => {
  const { review, calls, start } = harness(async ({ rules }) => [{ id: rules[0].id }])
  let turn = { turnId: 't2', turnGeneration: 2, userSpeaking: true }
  review.getTurn = () => turn
  start()
  await tick()
  assert.equal(calls.filter(c => c.resume).length, 0)
  assert.equal(calls[0].origin, 'policy-review')
  turn = { turnId: 't3', turnGeneration: 3, userSpeaking: false }
  review.onInputEvent({ type: 'input_audio_buffer.speech_stopped' })
  await tick()
  assert.equal(calls.at(-1).resume[0].turnId, 't3')
  assert.equal(calls.at(-1).resume[1].shouldCreate(), true)
  turn = { turnId: 't4', turnGeneration: 4 }
  assert.equal(calls.at(-1).resume[1].shouldCreate(), false)
})

test('disabled configuration ignores unused endpoint and timeout settings', () => {
  assert.equal(policyReviewOptions({ QWEN_AUDIO_POLICY_REVIEW: 'off', QWEN_AUDIO_POLICY_REVIEW_TIMEOUT_MS: 'invalid' }).enabled, false)
})

test('injection failure retains original reply and fixed repair in response instructions', async () => {
  const { review, calls, start } = harness(async ({ rules }) => [{ id: rules[0].id }])
  review.getFrontend().injectDelivery = async () => { throw new Error('cannot inject') }
  start()
  await tick()
  assert.match(calls.at(-1).resume[1].response.instructions, /已经发送了/)
  assert.match(calls.at(-1).resume[1].response.instructions, /先用自然/)
})

test('user speech discards held old output; a successful review cannot replay it later', async () => {
  const pending = deferred()
  const { review, start } = harness(() => pending.promise)
  start()
  review.intercept({ response_id: 'r2' }, {}, () => assert.fail('superseded output'))
  review.onInputEvent({ type: 'input_audio_buffer.speech_started' })
  pending.resolve([])
  await tick()
  assert.equal(review.buffer.length, 0)
})

test('replayed completion starts another review which holds the following response', async () => {
  const first = deferred(), second = deferred()
  let count = 0
  const { review, start } = harness(() => (++count === 1 ? first.promise : second.promise))
  const replayed = []
  start()
  const replay = event => {
    if (review.intercept(event, {}, replay)) return
    replayed.push(event.response_id)
    if (event.response_id === 'r2') review.review({ responseId: 'r2', context: { turnId: 't2' }, text: 'reply2' })
  }
  review.intercept({ type: 'response.done', response_id: 'r2' }, {}, replay)
  review.intercept({ type: 'response.audio.delta', response_id: 'r3' }, {}, replay)
  first.resolve([])
  await tick()
  assert.deepEqual(replayed, ['r2'])
  second.resolve([])
  await tick()
  assert.deepEqual(replayed, ['r2', 'r3'])
})

test('an interrupted repair remains required before output for the new user turn', async () => {
  const { review, calls, start } = harness(async ({ rules }) => [{ id: rules[0].id }])
  const outcome = deferred()
  review.getFrontend().ensureResponse = (...args) => { calls.push({ resume: args }); return outcome.promise }
  let turn = { turnId: 't2', turnGeneration: 2, userSpeaking: false }
  review.getTurn = () => turn
  start()
  await tick()
  turn = { turnId: 't3', turnGeneration: 3, userSpeaking: true }
  review.onInputEvent({ type: 'input_audio_buffer.speech_started' })
  assert.equal(review.intercept({ response_id: 'new-speculation' }, {}, () => assert.fail('unrepaired')), true)
  outcome.resolve({ cancelled: true })
  await tick()
  assert.equal(calls.filter(c => c.resume).length, 1)
  turn.userSpeaking = false
  review.onInputEvent({ type: 'input_audio_buffer.speech_stopped' })
  await tick()
  assert.equal(calls.filter(c => c.resume).length, 2)
  assert.equal(calls.at(-1).resume[0].turnId, 't3')
})
