import assert from 'node:assert/strict'
import test from 'node:test'
import { RealtimeFrontend, REALTIME_PROVIDERS } from '../src/voice/realtime-provider.mjs'

const flush = () => new Promise(resolve => setImmediate(resolve))
const busyMessage = 'Conversation already has a pending response request'

test('JEV regeneration input_busy waits for native speech_stopped, not a backoff timer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = harness(t)
  const outcome = h.frontend.ensureResponse({ turnId: 'latest' }, { waitForSpeechStopped: true, shouldCreate: () => true })
  await flush()
  const error = { type: 'error', error: { code: 'speech_busy', message: 'Cannot create response while user is speaking.' } }
  h.frontend.handleLifecycle(error)
  assert.equal(error.__voiceRetried, true)
  t.mock.timers.tick(20_000)
  await flush()
  assert.equal(h.responses().length, 1)
  h.frontend.handleLifecycle({ type: 'input_audio_buffer.speech_stopped', item_id: 'user' })
  await flush()
  assert.equal(h.responses().length, 2)
  h.start('replacement')
  h.done('replacement')
  assert.equal((await outcome).completed, true)
})

test('native stop received while request was in flight also allows JEV recovery', async t => {
  const h = harness(t)
  const outcome = h.frontend.ensureResponse({}, { waitForSpeechStopped: true })
  await flush()
  h.frontend.handleLifecycle({ type: 'input_audio_buffer.speech_stopped' })
  h.frontend.handleLifecycle({ type: 'error', error: { message: 'Cannot create response while user is speaking.' } })
  await flush()
  assert.equal(h.responses().length, 2)
  h.start('replacement'); h.done('replacement')
  assert.equal((await outcome).completed, true)
})

for (const operation of ['cancel', 'resetResponses']) {
  test(`JEV input-busy wait is invalidated by ${operation}`, async t => {
    const h = harness(t)
    const outcome = h.frontend.ensureResponse({}, { waitForSpeechStopped: true })
    await flush()
    h.frontend.handleLifecycle({ type: 'error', error: { message: 'Cannot create response while user is speaking.' } })
    h.frontend[operation]()
    h.frontend.handleLifecycle({ type: 'input_audio_buffer.speech_stopped' })
    await flush()
    assert.equal(h.responses().length, 1)
    assert.equal((await outcome).cancelled, true)
  })
}

test('ordinary agent refusal keeps original behavior without the JEV option', async t => {
  const h = harness(t)
  const outcome = h.frontend.ensureResponse({})
  await flush()
  const error = { type: 'error', error: { message: 'Cannot create response while user is speaking.' } }
  h.frontend.handleLifecycle(error)
  assert.notEqual(error.__voiceRetried, true)
  assert.equal((await outcome).failed, true)
  h.frontend.handleLifecycle({ type: 'input_audio_buffer.speech_stopped' })
  await flush()
  assert.equal(h.responses().length, 1)
})

test('JEV recovery does not claim a refusal explicitly bound to another request', async t => {
  const h = harness(t)
  const outcome = h.frontend.ensureResponse({}, { waitForSpeechStopped: true })
  await flush()
  const error = { type: 'error', error: { event_id: 'different-request', message: 'Cannot create response while user is speaking.' } }
  h.frontend.handleLifecycle(error)
  assert.notEqual(error.__voiceRetried, true)
  assert.equal((await outcome).failed, true)
})

function harness(t, options = {}) {
  const sent = [], diagnostics = []
  const frontend = new RealtimeFrontend({
    provider: REALTIME_PROVIDERS.dashscope,
    onDiagnostic: event => diagnostics.push(event),
    ...options,
  })
  frontend.ready = true
  frontend.ws = { readyState: 1, send: raw => sent.push(JSON.parse(raw)) }
  t.after(() => frontend.resetResponses())
  return {
    frontend, sent, diagnostics,
    responses: () => sent.filter(event => event.type === 'response.create'),
    busy: () => {
      const event = { type: 'error', error: { type: 'invalid_request_error', message: busyMessage } }
      frontend.handleLifecycle(event)
      return event
    },
    ack: item => frontend.handleLifecycle({ type: 'conversation.item.created', item }),
    start: id => {
      const event = { type: 'response.created', response: { id } }
      frontend.handleLifecycle(event)
      return event
    },
    done: id => frontend.handleLifecycle({ type: 'response.done', response: { id, status: 'completed' } }),
  }
}

test('DashScope recognizes pending and active response slot refusals', () => {
  const provider = REALTIME_PROVIDERS.dashscope
  for (const message of [busyMessage, 'Conversation already has an active response',
    'Cannot create response while another response is in progress.']) {
    assert.equal(provider.classifyError(message), 'response_slot_busy')
  }
  assert.equal(provider.capabilities.singleResponseSlot, true)
  assert.equal(provider.classifyError('invalid input format'), 'other')
})

test('retries only response.create after a refused tool continuation, never the tool result', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = harness(t)
  const outcome = h.frontend.sendFunctionOutput('call-1', { status: 'accepted', task_id: 'task_1' })
  await flush()
  h.ack(h.sent[0].item)
  await flush()
  assert.equal(h.responses().length, 1)
  assert.equal(h.busy().__voiceRetried, true)
  t.mock.timers.tick(1200)
  await flush()
  assert.equal(h.responses().length, 1)
  h.start('server-pending')
  h.done('server-pending')
  await flush()
  assert.equal(h.responses().length, 2)
  assert.deepEqual(h.responses()[1].response, h.responses()[0].response)
  assert.equal(h.sent.filter(event => event.type === 'conversation.item.create').length, 1)
  h.start('continuation')
  h.done('continuation')
  assert.equal((await outcome).completed, true)
  assert.ok(h.diagnostics.some(event => event.event === 'realtime.response_refused'))
})

test('rechecks the response slot after awaiting a tool result receipt', async t => {
  const h = harness(t)
  const outcome = h.frontend.sendFunctionOutput('call-1', { status: 'accepted' })
  await flush()
  const automatic = h.start('automatic')
  assert.equal(automatic.__voiceOrigin, 'model')
  h.ack(h.sent[0].item)
  await flush()
  assert.equal(h.responses().length, 0)
  h.done('automatic')
  await flush()
  assert.equal(h.responses().length, 1)
  h.start('continuation')
  h.done('continuation')
  assert.equal((await outcome).completed, true)
})

test('busy refusal preserves automatic speech and an unrelated environment context receipt', async t => {
  const h = harness(t)
  const outcome = h.frontend.speak('结果来了', 'announcement')
  await flush()
  // A metadata-free provider can announce its own response before refusing
  // the concurrent client request. Its response must remain active.
  h.start('automatic')
  const context = h.frontend.createConversationItem(h.frontend.protocol.userTextItem('视觉输入已关闭'))
  const refused = h.busy()
  assert.equal(refused.__voiceRetried, true)
  assert.equal(refused.response_id, undefined)
  assert.equal(h.frontend.activeResponses.has('automatic'), true)
  assert.equal(h.frontend.conversationItemWaiters.size, 1)
  h.ack(h.sent.at(-1).item)
  await context
  assert.equal(h.responses().length, 1)
  h.done('automatic')
  await flush()
  assert.equal(h.responses().length, 2)
  h.start('announcement')
  h.done('announcement')
  assert.equal((await outcome).completed, true)
})

for (const operation of ['cancel', 'resetResponses', 'cancelResponses']) {
  test(`${operation} settles a refused response during backoff and prevents late replay`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const h = harness(t)
    const outcome = h.frontend.speak('旧回复', 'permission')
    await flush()
    assert.equal(h.busy().__voiceRetried, true)
    h.frontend[operation](() => true)
    let result
    outcome.then(value => { result = value })
    await flush()
    assert.equal(result?.cancelled, true)
    t.mock.timers.tick(10_000)
    await flush()
    assert.equal(h.responses().length, 1)
  })
}

test('bounds refusal retries and surfaces exhaustion instead of looping forever', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = harness(t)
  const outcome = h.frontend.speak('结果来了')
  await flush()
  for (const delay of [1200, 2600, 5000]) {
    assert.equal(h.busy().__voiceRetried, true)
    t.mock.timers.tick(delay)
    h.done('server-pending')
    await flush()
  }
  assert.equal(h.busy().__voiceRetried, undefined)
  assert.equal((await outcome).failed, true)
  t.mock.timers.tick(60_000)
  await flush()
  assert.equal(h.responses().length, 4)
})

test('a refused request without a matching client response never retires automatic speech', t => {
  const h = harness(t)
  h.start('automatic')
  h.busy()
  assert.equal(h.frontend.activeResponses.has('automatic'), true)
  h.done('automatic')
})

test('unknown server occupancy waits, cancels on timeout, and retries only after acknowledgement', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = harness(t)
  const outcome = h.frontend.speak('需要授权', 'permission')
  await flush()
  h.busy()
  t.mock.timers.tick(29_999)
  await flush()
  assert.equal(h.responses().length, 1)
  assert.equal(h.sent.some(event => event.type === 'response.cancel'), false)
  t.mock.timers.tick(1)
  await flush()
  assert.equal(h.sent.at(-1).type, 'response.cancel')
  assert.equal(h.responses().length, 1)
  h.frontend.handleLifecycle({ type: 'error', error: { message: 'no active response' } })
  await flush()
  assert.equal(h.responses().length, 2)
  h.start('permission')
  h.done('permission')
  assert.equal((await outcome).completed, true)
})

test('unacknowledged cancellation closes the uncertain connection without sending another response', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = harness(t)
  let terminated = 0
  h.frontend.ws.terminate = () => { terminated++ }
  const outcome = h.frontend.speak('第一条')
  const next = h.frontend.speak('第二条')
  await flush()
  t.mock.timers.tick(30_000)
  await flush()
  assert.equal((await outcome).timedOut, true)
  assert.equal(h.responses().length, 1)
  t.mock.timers.tick(1000)
  await next
  assert.equal(terminated, 1)
  assert.equal(h.frontend.ready, false)
  assert.equal(h.responses().length, 1)
})

test('timed-out start quarantines late speech until cancellation completes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = harness(t)
  const outcome = h.frontend.speak('旧进度')
  await flush()
  t.mock.timers.tick(30_000)
  await outcome
  assert.equal(h.start('late').__voiceContext.suppressed, true)
  const audio = { type: 'response.audio.delta', response_id: 'late', delta: 'AAA=' }
  h.frontend.handleLifecycle(audio)
  assert.equal(audio.__voiceContext.suppressed, true)
  h.done('late')
  assert.equal(h.frontend.responseSlot.blocked, false)
})

test('retry rechecks validity so completed work cannot replay an old acknowledgement', async t => {
  const h = harness(t)
  let current = true
  const outcome = h.frontend.ensureResponse({ taskId: 'task_1' }, { shouldCreate: () => current })
  await flush()
  h.busy()
  current = false
  h.done('server-pending')
  assert.equal((await outcome).skipped, true)
  assert.equal(h.responses().length, 1)
})

test('late output from a now-obsolete continuation is suppressed before playback', async t => {
  const h = harness(t)
  let current = true
  const outcome = h.frontend.ensureResponse({ taskId: 'task_1' }, { shouldCreate: () => current })
  await flush()
  h.start('receipt')
  current = false
  const audio = { type: 'response.audio.delta', response_id: 'receipt', delta: 'AAA=' }
  h.frontend.handleLifecycle(audio)
  assert.equal(audio.__voiceContext.suppressed, true)
  h.done('receipt')
  await outcome
})

test('task completion does not truncate an acknowledgement already streaming', async t => {
  const h = harness(t)
  let current = true
  const outcome = h.frontend.ensureResponse({}, { shouldCreate: () => current })
  await flush()
  h.start('receipt')
  const audio = () => ({ type: 'response.audio.delta', response_id: 'receipt', delta: 'AAA=' })
  h.frontend.handleLifecycle(audio())
  current = false
  const next = audio()
  h.frontend.handleLifecycle(next)
  assert.notEqual(next.__voiceContext?.suppressed, true)
  h.done('receipt')
  await outcome
})

test('policy-cancelled A cannot revive or consume B through late lifecycle events', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = harness(t)
  h.start('A')
  h.frontend.cancel({ retireResponses: true })
  h.frontend.handleLifecycle({ type: 'error', error: { message: 'Conversation has no active response.' } })
  assert.equal(h.frontend.activeResponses.size, 0)
  const outcome = h.frontend.ensureResponse({ turnId: 'new-turn' })
  await flush()
  assert.equal(h.responses().length, 1)
  const lateCreated = h.start('A')
  assert.equal(lateCreated.__voiceContext.suppressed, true)
  assert.equal(h.frontend.pendingResponses.length, 1, 'late A cannot claim the replacement request')
  const replacement = h.start('B')
  assert.equal(replacement.__voiceContext.turnId, 'new-turn')
  const phase = h.frontend.responseSlot.phase
  for (const type of ['response.audio_transcript.delta', 'response.audio.delta',
    'response.function_call_arguments.done', 'response.done', 'error']) {
    const event = { type, response_id: 'A', delta: 'late', response: { id: 'A', status: 'completed' }, error: { message: 'old response failed' } }
    h.frontend.handleLifecycle(event)
    assert.equal(event.__voiceContext.suppressed, true)
    assert.deepEqual([...h.frontend.activeResponses], ['B'])
    assert.equal(h.frontend.responseSlot.phase, phase, 'late A cannot release B slot')
    assert.equal(h.frontend.responseWaiters.has('B'), true)
  }
  h.done('B')
  assert.equal((await outcome).completed, true)
  const evenLater = { type: 'response.audio_transcript.delta', response_id: 'A', delta: 'late after B' }
  h.frontend.handleLifecycle(evenLater)
  assert.equal(evenLater.__voiceContext.suppressed, true)
  assert.equal(h.frontend.activeResponses.size, 0)
  await h.frontend.whenIdle()
  h.frontend.resetResponses()
  assert.equal(h.frontend.retiredResponses.size, 0)
})

for (const status of ['cancelled', 'completed']) {
  test(`JEV cancel accepts explicit ${status} terminal before filtering retired output`, t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const h = harness(t)
    h.start('A')
    h.frontend.cancel({ retireResponses: true })
    assert.equal(h.frontend.responseSlot.phase, 'cancelling')
    h.done('unrelated')
    assert.equal(h.frontend.policyCancellation.awaiting, true)
    assert.equal(h.frontend.responseSlot.phase, 'cancelling')
    const terminal = { type: 'response.done', response: { id: 'A', status } }
    h.frontend.handleLifecycle(terminal)
    assert.equal(h.frontend.policyCancellation.awaiting, false)
    assert.equal(terminal.__voiceContext.suppressed, true)
    assert.equal(h.frontend.responseSlot.phase, 'idle')
    t.mock.timers.tick(h.frontend.responseCancelGraceMs + 1)
    assert.equal(h.frontend.ready, true, 'confirmed terminal cancels forced recovery')
    assert.ok(h.diagnostics.some(e => e.event === 'realtime.policy_cancel'
      && e.state === (status === 'cancelled' ? 'cancelled' : 'already_finished')))
  })
}

test('no-active cancel error retires JEV A only and is not logged as cancel success', t => {
  const h = harness(t)
  h.start('A')
  h.frontend.cancel({ retireResponses: true })
  h.frontend.activeResponses.add('B')
  const eventId = h.sent.find(e => e.type === 'response.cancel').event_id
  h.frontend.handleLifecycle({ type: 'error', response_id: 'A', error: {
    param: 'response.cancel', event_id: eventId, message: 'Conversation has no active response.' } })
  assert.deepEqual([...h.frontend.activeResponses], ['B'])
  assert.equal(h.frontend.policyCancellation.awaiting, false)
  assert.ok(h.diagnostics.some(e => e.event === 'realtime.policy_cancel' && e.state === 'already_inactive'))
  assert.ok(!h.diagnostics.some(e => e.event === 'realtime.policy_cancel' && e.state === 'cancelled'))
})

test('a no-active error bound to another cancel request does not acknowledge the JEV cancel', t => {
  const h = harness(t)
  h.start('A')
  h.frontend.cancel({ retireResponses: true })
  h.frontend.handleLifecycle({ type: 'error', error: { event_id: 'other-request',
    param: 'response.cancel', message: 'Conversation has no active response.' } })
  assert.equal(h.frontend.policyCancellation.awaiting, true)
  assert.equal(h.frontend.responseSlot.phase, 'cancelling')
})

test('JEV explicitly discards a response already completed while buffered', t => {
  const h = harness(t)
  h.start('A'); h.done('A')
  h.frontend.cancel({ retireResponses: true, responseIds: ['A'] })
  assert.equal(h.sent.filter(e => e.type === 'response.cancel').length, 0)
  const late = { type: 'response.audio_transcript.delta', response_id: 'A', delta: 'obsolete' }
  h.frontend.handleLifecycle(late)
  assert.equal(late.__voiceContext.suppressed, true)
  assert.equal(h.frontend.activeResponses.has('A'), false)
})

test('missing JEV cancel confirmation retains existing recovery, not synthetic success', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = harness(t)
  h.start('A')
  h.frontend.cancel({ retireResponses: true })
  assert.equal(h.frontend.policyCancellation.awaiting, true)
  t.mock.timers.tick(h.frontend.responseCancelGraceMs + 1)
  assert.equal(h.frontend.ready, false)
  assert.ok(h.diagnostics.some(e => e.event === 'realtime.policy_cancel' && e.state === 'unconfirmed_reset'))
})

test('policy tombstones also survive cancel grace expiry without a native done', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = harness(t)
  // A provider that recovers locally after the grace interval, without closing
  // the connection. A forced disconnect resets all response state instead.
  h.frontend.capabilities = { ...h.frontend.capabilities, singleResponseSlot: false }
  h.start('A')
  h.frontend.cancel({ retireResponses: true })
  t.mock.timers.tick(h.frontend.responseCancelGraceMs + 1)
  const event = { type: 'response.audio_transcript.delta', response_id: 'A', delta: 'late' }
  h.frontend.handleLifecycle(event)
  assert.equal(event.__voiceContext.suppressed, true)
  assert.equal(h.frontend.activeResponses.has('A'), false)
})

test('function output with createResponse=false is acknowledged while source is active', async t => {
  const h = harness(t)
  h.start('source')
  const output = h.frontend.sendFunctionOutput('call', { ok: true }, { turnId: 't' }, { createResponse: false })
  await flush()
  const sent = h.sent.filter(event => event.type === 'conversation.item.create')
  assert.equal(sent.length, 1)
  assert.equal(sent[0].item.type, 'function_call_output')
  assert.ok(h.frontend.activeResponses.has('source'))
  h.ack(sent[0].item)
  await output
  assert.equal(h.responses().length, 0)
  h.done('source')
  await h.frontend.whenIdle()
})

test('events tagged with an old transport cannot alter new transport state', t => {
  const seen = []
  const h = harness(t, { onEvent: event => seen.push(event) })
  const previous = h.frontend.transportGeneration
  h.frontend.resetResponses()
  h.frontend.transportGeneration++
  h.start('current')
  const phase = h.frontend.responseSlot.phase
  for (const event of [
    { type: 'response.created', response: { id: 'old' } },
    { type: 'response.audio_transcript.delta', response_id: 'old', delta: 'late' },
    { type: 'response.done', response: { id: 'current', status: 'completed' } },
    { type: 'error', error: { message: 'Conversation has no active response.' } },
  ]) assert.deepEqual(h.frontend.handleProviderEvent(event, { transportGeneration: previous }), [])
  assert.deepEqual([...h.frontend.activeResponses], ['current'])
  assert.equal(h.frontend.responseSlot.phase, phase)
  assert.deepEqual(seen, [])
})
