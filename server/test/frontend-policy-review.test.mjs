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

for (const outcome of [{ completed: true }, { cancelled: true }, { skipped: true }]) {
  test(`a second verdict survives earlier repair outcome ${Object.keys(outcome)[0]} in the same turn`, async () => {
  // Recorded airline13 ordering: first repair queued behind an announcement;
  // announcement verdict arrives before that repair's response.created.
  // Native completion resolves ensureResponse even while presentation is held.
  const { review, calls } = harness(async ({ rules }) => [{ id: rules[0].id }])
  const first = deferred(), second = deferred()
  let requests = 0
  review.getFrontend().ensureResponse = (...args) => {
    calls.push({ resume: args })
    return ++requests === 1 ? first.promise : second.promise
  }
  review.review({ responseId: 'earlier-answer', context: { turnId: 'same-turn' }, text: 'earlier refusal' })
  await tick()
  assert.equal(requests, 1)
  review.review({ responseId: 'backend-announcement', context: { turnId: 'same-turn' }, text: 'another refusal' })
  await tick()
  assert.equal(requests, 1)
  assert.equal(review.intercept({ type: 'response.created', response: { id: 'first-repair' } }, {}, () => assert.fail('obsolete repair')), true)
  assert.equal(review.intercept({ type: 'response.done', response: { id: 'first-repair' } }, {}, () => assert.fail('obsolete repair')), true)
  first.resolve(outcome)
  await tick()
  assert.equal(requests, 2, 'same-turn follow-up correction must not be stranded')
  assert.match(calls.at(-1).resume[1].response.instructions, /backend-announcement/)
  assert.match(calls.at(-1).resume[1].response.instructions, /earlier-answer/)
  assert.equal(review.buffer.length, 0)
  second.resolve({ completed: true })
  await tick()
  assert.equal(requests, 2, 'no duplicate replay after the final repair completes')
  review.close()
})

}

test('a skipped repair without a newer verdict or input does not spin the same request', async () => {
  const { review, start } = harness(async ({ rules }) => [{ id: rules[0].id }])
  let requests = 0
  review.getFrontend().ensureResponse = async () => { requests++; return { skipped: true } }
  start()
  await tick()
  await tick()
  assert.equal(requests, 1)
  review.close()
})

test('tool admission timeout/error allows dispatch and holds speculative output until verdict', async () => {
  for (const decide of [() => new Promise(() => {}), () => { throw new Error('offline') }]) {
    const { review } = harness(decide, 5)
    const pending = review.authorizeTool({ responseId: 'tool', callId: 'c', toolName: 'spawn_thinking', args: {}, context: { turnId: 't2', turnGeneration: 2 } })
    const replayed = []
    assert.equal(review.intercept({ type: 'response.audio.delta', response_id: 'next' }, { turnGeneration: 2 }, e => replayed.push(e)), true)
    assert.equal(replayed.length, 0)
    review.completeResponse({ responseId: 'tool', context: { turnId: 't2', turnGeneration: 2 }, text: 'Trying now.' })
    assert.equal((await pending).allowed, true)
    await tick()
    assert.equal(replayed.length, 1)
    review.close()
  }
})

test('task result gate waits only for its own source review and transfers actual results to correction', async () => {
  const pending = deferred()
  const { review, calls } = harness(async ({ rules }) => { await pending.promise; return [{ id: rules[0].id }] })
  review.recordTaskSource({ name: 'spawn_thinking', status: 'completed', taskId: 'task', responseId: 'source', turnId: 't1' })
  review.review({ responseId: 'source', context: { turnId: 't1' }, text: 'I cannot do that.' })
  const delivery = { id: 'result', origin: 'announcement', text: 'Business succeeded.', correlation: { taskIds: ['task'] } }
  let settled = false
  const admitted = review.admitDelivery(delivery).then(v => { settled = true; return v })
  assert.equal(await review.admitDelivery({ ...delivery, correlation: { taskIds: ['unrelated'] } }), null)
  assert.equal(await review.admitDelivery({ ...delivery, origin: 'permission' }), null)
  await tick(); assert.equal(settled, false)
  pending.resolve()
  assert.equal((await admitted).awaitingPolicyRepair, true)
  await tick()
  const resumes = calls.filter(c => c?.resume)
  assert.ok(resumes.some(c => c.resume[0].taskIds?.includes('task')))
  assert.ok(resumes.some(c => c.resume[1].response.instructions.includes('Business succeeded.')))
  assert.ok(resumes.some(c => c.resume[1].response.instructions.includes('不得重复业务操作')))
  review.close()
})

test('missing source terminal times out open, close releases waiters, and reused IDs do not reuse another turn verdict', async () => {
  const { review } = harness(() => [], 5)
  const make = (task, turnId) => review.recordTaskSource({ name: 'spawn_thinking', status: 'completed', taskId: task, responseId: 'same', turnId })
  const delivery = task => ({ id: task, origin: 'announcement', text: 'result', correlation: { taskId: task } })
  await review.review({ responseId: 'same', context: { turnId: 'old' }, text: 'old' })
  make('new', 'new')
  let settled = false
  const pending = review.admitDelivery(delivery('new')).then(v => { settled = true; return v })
  await tick(); assert.equal(settled, false)
  await new Promise(resolve => setTimeout(resolve, 15))
  assert.equal(await pending, null)
  make('closing', 'other')
  const closing = review.admitDelivery(delivery('closing'))
  review.close()
  assert.equal((await closing).cancelled, true)
})

test('unified batch waits for final transcripts and playback; timeout budget starts only with JEV', async () => {
  const packets = []
  const { review } = harness(async packet => { packets.push(packet); return [] }, 5)
  const context = { turnId: 't2', turnGeneration: 2 }
  const pending = review.authorizeTool({ responseId: 'spoken', callId: 'c', toolName: 'spawn_thinking', args: {}, context })
  review.observe({ type: 'response.audio.delta', response_id: 'spoken', delta: 'audio' }, context)
  review.observe({ type: 'response.audio_transcript.delta', response_id: 'spoken', output_index: 0, delta: 'first partial' }, context)
  review.completeResponse({ responseId: 'spoken', context, waitForPlayback: true })
  await new Promise(resolve => setTimeout(resolve, 15))
  assert.equal(packets.length, 0, 'waiting for playback is not an automatic approval')
  review.playbackEnded('spoken', context)
  await tick(); assert.equal(packets.length, 0, 'final transcript still missing')
  review.observe({ type: 'response.audio_transcript.done', response_id: 'spoken', output_index: 0, transcript: 'first complete. ' }, context)
  assert.equal((await pending).allowed, true)
  assert.equal(packets.length, 1)
  assert.equal(packets[0].state.assistant_text, 'first complete. ')
  review.close()
})

test('all spoken content parts and all deferred calls are reviewed once, rejection waits for both receipts before regeneration', async () => {
  const packets = []
  const { review, calls } = harness(async packet => { packets.push(packet); return [{ id: packet.rules[0].id }] })
  const context = { turnId: 't2', turnGeneration: 2 }
  const first = review.authorizeTool({ responseId: 'batch', callId: 'c1', toolName: 'first', args: {}, context })
  const second = review.authorizeTool({ responseId: 'batch', callId: 'c2', toolName: 'second', args: {}, context })
  for (const [index, transcript] of [[1, 'second.'], [0, 'first.']]) review.observe({ type: 'response.audio_transcript.done', response_id: 'batch', output_index: index, transcript }, context)
  review.completeResponse({ responseId: 'batch', context })
  const [one, two] = await Promise.all([first, second])
  assert.equal(packets.length, 1)
  assert.equal(packets[0].state.assistant_text, 'first.second.')
  assert.equal(packets[0].state.proposed_tools.length, 2)
  assert.equal(one.allowed, false); assert.equal(two.allowed, false)
  assert.ok(calls.includes('cancel'), 'cancel must not wait for function-result acknowledgements')
  one.finish()
  await tick(); assert.equal(calls.filter(c => c?.resume).length, 0)
  two.finish()
  await tick(); assert.equal(calls.filter(c => c?.resume).length, 1)
  review.close()
})

test('missing source terminal cannot bypass review; disconnect releases unexecuted calls', async () => {
  let reviews = 0
  const { review } = harness(async () => { reviews++; return [] }, 5)
  const pending = review.authorizeTool({ responseId: 'missing-terminal', callId: 'c', toolName: 'first', args: {}, context: { turnId: 't2' } })
  let settled = false
  pending.then(() => { settled = true })
  await new Promise(resolve => setTimeout(resolve, 15))
  assert.equal(reviews, 0); assert.equal(settled, false)
  review.abortResponses()
  assert.equal((await pending).cancelled, true)
  review.close()
})

test('completed native output supplies final text without transcript.done, and closed/suppressed calls never wait', async () => {
  const packets = []
  const { review } = harness(async packet => { packets.push(packet); return [] })
  const context = { turnId: 't2', turnGeneration: 2 }
  review.observe({ type: 'response.audio.delta', response_id: 'native-full', delta: 'audio' }, context)
  review.observe({ type: 'response.audio_transcript.delta', response_id: 'native-full', output_index: 0, delta: 'partial' }, context)
  const pending = review.authorizeTool({ responseId: 'native-full', callId: 'c', toolName: 'first', args: {}, context })
  review.completeResponse({ responseId: 'native-full', context, output: [{ type: 'message', content: [{ type: 'audio', transcript: 'Final transcript from native done.' }] }] })
  assert.equal((await pending).allowed, true)
  assert.equal(packets[0].state.assistant_text, 'Final transcript from native done.')
  assert.equal((await review.authorizeTool({ responseId: 'suppressed', callId: 's', context: { suppressed: true } })).cancelled, true)
  review.close()
  assert.equal((await review.authorizeTool({ responseId: 'closed', callId: 's', context })).cancelled, true)
})
