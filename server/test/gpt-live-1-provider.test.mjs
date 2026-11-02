import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import { setImmediate as tick, setTimeout as sleep } from 'node:timers/promises'
import { WebSocketServer } from 'ws'
import { config, resolveGptLive1Timing } from '../src/core/config.mjs'
import { RealtimeFrontend, realtimeEventErrorMessage } from '../src/voice/realtime-provider.mjs'
import { gptLive1Provider, sessionInputHistory } from '../src/voice/providers/gpt-live-1.mjs'
import { permissionResponseInstructions, progressResponseInstructions, resultResponseInstructions } from '../src/frontend/frontend-tools.mjs'
import { GPT_LIVE_1_TIMING_DEFAULTS, createGptLive1Protocol, clampCommentary, estimateTokens } from '../src/voice/providers/gpt-live-1-protocol.mjs'
import { defaultRealtimeProviderRegistry, describeActiveRealtime } from '../src/voice/providers/registry.mjs'
import { TurnTranscripts } from '../src/frontend/tools/turn-transcripts.mjs'
import { AnnouncementWindow } from '../src/voice/announcement/announcement-window.mjs'
import { InputAssetRegistry } from '../src/voice/input-asset-registry.mjs'
import { RealtimeInputRuntime } from '../src/voice/realtime-input-runtime.mjs'
import { RealtimeTurnState } from '../src/voice/realtime-turn-state.mjs'
import { createRealtimeModelCatalogs, resolveRealtimeModelProfile } from '../../shared/realtime-model-catalog.mjs'
import { assertRealtimeFrontendModel } from '../../shared/realtime-provider-catalog.mjs'
import { gatewaySetupStatus } from '../../shared/gateway/setup.mjs'

// 100 ms of 24 kHz PCM16 well above the speech threshold, and the digital silence streamed between answers.
const SPEECH = Buffer.alloc(4800, 0x20).toString('base64')
const SILENCE = Buffer.alloc(4800).toString('base64')

// Server frames without event ids: transcripts carry their session-timeline interval, output audio none.
const userSays = (delta, start_ms, end_ms) => ({ type: 'session.input_transcript.delta', delta, start_ms, end_ms })
const modelSays = (delta, start_ms, end_ms) => ({ type: 'session.output_transcript.delta', delta, start_ms, end_ms })
const MODEL_SPEECH = { type: 'session.output_audio.delta', delta: SPEECH }
const MODEL_SILENCE = { type: 'session.output_audio.delta', delta: SILENCE }
const INPUT_IDLE = { type: 'gpt-live-1.input_idle' }
const OUTPUT_IDLE = { type: 'gpt-live-1.output_idle' }
const STARTED = { type: 'session.started', session: { id: 'sess_1' } }
// Nested events of a delegated Responses backend response.
const backend = (delegation_id, event) => ({ type: 'response.event', delegation_id, event })
const created = id => ({ type: 'response.created', response: { id } })
const completed = id => ({ type: 'response.completed', response: { id, status: 'completed' } })
const toolCall = (call_id, name = 'get_current_time') =>
  ({ type: 'response.output_item.done', item: { type: 'function_call', call_id, name, arguments: '{}' } })

// Events the adapter emits.
const TURN_OPENS = ['input_audio_buffer.speech_started', 'conversation.item.input_audio_transcription.delta']
const TURN_ENDS = ['input_audio_buffer.speech_stopped', 'input_audio_buffer.committed']
const ANSWER_OPENS = ['response.created', 'response.output_audio.delta']
const ANSWER_ENDS = ['response.output_audio_transcript.done', 'response.done']
const USER_DELTA = 'conversation.item.input_audio_transcription.delta'
const USER_DONE = 'conversation.item.input_audio_transcription.completed'
const CAPTION = 'response.output_audio_transcript.delta'
const turnEnd = item_id => TURN_ENDS.map(type => ({ type, item_id }))
const caption = (response_id, delta) => ({ type: CAPTION, response_id, delta })
const voiceDone = (id, status = 'completed') => ({ type: 'response.done', response: { id, status }, response_id: id, __voicePlayback: true })
const types = events => events.map(event => event.type)
const has = (events, type) => events.some(event => event.type === type)
const openedId = events => events.find(event => event.type === 'response.created').response.id
const captionOf = events => events.filter(event => event.type === CAPTION).map(event => event.delta).join('')

function withConfig(t, patch) {
  const previous = Object.fromEntries(Object.keys(patch).map(key => [key, config[key]]))
  Object.assign(config, patch)
  t.after(() => Object.assign(config, previous))
}

// The adapter on a test clock: `feed` normalizes one server frame, `play` several.
function liveAdapter(options) {
  const live = { clock: 0 }
  const protocol = createGptLive1Protocol({ now: () => live.clock, ...options })
  const feed = raw => protocol.normalizeIncoming(raw)
  return Object.assign(live, protocol, { feed, play: (...frames) => frames.flatMap(raw => feed(raw)) })
}

// A frontend closed after the test; `feed` passes server frames through its adapter into the lifecycle.
function liveFrontend(t, options) {
  const frontend = new RealtimeFrontend({ provider: gptLive1Provider, agentContext: {}, ...options })
  t.after(() => frontend.close())
  const feed = (...frames) => frames.forEach(raw => {
    for (const event of [].concat(frontend.protocol.normalizeIncoming(raw))) frontend.handleLifecycle(event)
  })
  return { frontend, feed }
}

// A Gateway request record as the frontend queues it.
const gatewayRequest = fields => ({ origin: 'agent', context: {}, settled: false, resolve: () => {}, timer: null, ...fields })

// An open socket that records what the frontend sends.
function openSocket(frontend, sent = []) {
  frontend.ws = { readyState: 1, send: raw => sent.push(JSON.parse(raw)), close() {} }
  return sent
}

test('GPT-Live 1 registers with function calling; a deployment name joins its catalog once registered', t => {
  // The Realtime provider keeps its own aliases; none may resolve here.
  assert.notEqual(defaultRealtimeProviderRegistry.resolve('gpt-realtime').key, 'gpt-live-1')
  for (const name of ['gpt-live-1', 'gptlive1', 'openai-live', 'GPT-Live-1']) {
    assert.equal(defaultRealtimeProviderRegistry.resolve(name).key, 'gpt-live-1')
  }
  const active = describeActiveRealtime('gpt-live-1')
  const { functionCalling, audioInput, audioOutput } = active.modelCapabilities
  assert.deepEqual([active.model, functionCalling, audioInput, audioOutput], ['gpt-live-1', true, true, true])
  assert.equal(active.inputSampleRate, 24000)
  // Runtime switches: delegation updates, no history item, instructions as items, a per-session voice, interruptions played out, paced speech.
  const flags = { mutableSession: true, restoreConversationContext: false, perResponseInstructions: false, sessionOutputVoice: true, interruptionPlaysOut: true, pacedOutputAudio: true }
  for (const [flag, value] of Object.entries(flags)) assert.equal(gptLive1Provider.capabilities[flag], value, flag)
  assert.deepEqual(active.modelCatalog.map(profile => profile.id), ['gpt-live-1'])
  // Another model ID, such as a deployment name, is a model like any other: registered under the gpt-live-1 API.
  assert.throws(() => assertRealtimeFrontendModel({ provider: 'gpt-live-1', model: 'live-deployment-a' }), /不属于 gpt-live-1/)
  const catalogs = createRealtimeModelCatalogs({ providers: { 'gpt-live-1': { models: { 'live-deployment-a': { api: 'gpt-live-1' } } } } })
  withConfig(t, { realtimeModelCatalogs: catalogs })
  assert.deepEqual(gptLive1Provider.modelCatalog().map(entry => entry.id), ['gpt-live-1', 'live-deployment-a'])
  const profile = resolveRealtimeModelProfile('live-deployment-a', 'gpt-live-1', catalogs)
  assert.deepEqual([profile.family, profile.modelCapabilities.functionCalling], ['gpt-live-1', true])
})

test('GPT-Live 1 sends the configured key to the configured Live API endpoint, and reuses no other key', t => {
  const openai = 'wss://api.openai.com/v1/live/sessions'
  const other = 'wss://live.example.com/v1/live/sessions'
  withConfig(t, { audioProvider: 'gpt-live-1', realtimeCredential: 'openai-test', realtimeEndpoint: openai, realtimeModel: 'gpt-live-1', realtimeVoice: '' })
  assert.equal(gptLive1Provider.isConfigured(), true)
  // The model travels inside session.start, never as a URL query parameter.
  assert.equal(gptLive1Provider.url(), openai)
  assert.deepEqual(gptLive1Provider.headers(), { Authorization: 'Bearer openai-test' })
  assert.equal(gptLive1Provider.voice(), null)
  // Another endpoint is only another URL and key; a registered model ID travels in session.start.
  Object.assign(config, { realtimeCredential: 'deployment-key', realtimeEndpoint: other, realtimeModel: 'live-deployment-a' })
  assert.equal(gptLive1Provider.url(), other)
  assert.deepEqual(gptLive1Provider.headers(), { Authorization: 'Bearer deployment-key' })
  assert.equal(gptLive1Provider.buildSession({ agentContext: {}, sessionOptions: {} }).model, 'live-deployment-a')
  // Setup takes no OpenAI key meant for another provider.
  const base = { QWEN_AUDIO_REALTIME_PROVIDER: 'gpt-live-1' }
  assert.equal(gatewaySetupStatus({ ...base, QWEN_AUDIO_REALTIME_API_KEY: 'service-key' }).ready, true)
  const missing = gatewaySetupStatus({ ...base, OPENAI_API_KEY: 'sk-plain', GPT_LIVE_API_KEY: 'sk-plain' })
  assert.equal(missing.ready, false)
  assert.deepEqual(missing.missing.map(item => item.key), ['QWEN_AUDIO_REALTIME_API_KEY'])
})

test('GPT-Live 1 builds a strict session.start payload with Responses delegation and seeded history', t => {
  withConfig(t, { audioProvider: 'gpt-live-1', realtimeCredential: 'k', realtimeModel: 'gpt-live-1', realtimeVoice: '', gptLive1DelegationModel: 'gpt-6-sol' })
  const build = (sessionOptions, agentContext = {}) => gptLive1Provider.buildSession({ agentContext, sessionOptions })
  // The Live API rejects unknown fields at startup: no voice or history, no audio or input field.
  const { instructions, delegation: { type, responses }, ...rest } = build({})
  assert.deepEqual(rest, { model: 'gpt-live-1' })
  assert.ok(instructions.length > 0)
  const { instructions: backendPrompt, tools, ...settings } = responses
  assert.deepEqual({ type, ...settings }, { type: 'responses', model: 'gpt-6-sol', tool_choice: 'auto', parallel_tool_calls: true })
  assert.ok(tools.length > 0)
  assert.ok(tools.every(tool => tool.type === 'function' && tool.name && tool.parameters))
  assert.deepEqual(build({ voice: 'marin' }).audio, { output: { voice: 'marin' } })
  // The voice prompt has the guide's policy sections and the backend tools; the backend prompt the frontend rules.
  const expected = ['Backchannel policy:', 'Interruption policy:', 'Delegation policy:', 'Backend tools:', 'answers a question the backend asked']
  for (const text of expected) assert.ok(instructions.includes(text), text)
  assert.ok(instructions.includes(`\n- ${tools[0].name}: ${tools[0].description.slice(0, 10)}`), 'each tool with what it does')
  // The whole description: its first sentence need not say what the tool is for.
  const reminder = tools.find(tool => tool.name === 'schedule_reminder').description
  assert.ok(instructions.includes(`- schedule_reminder: ${reminder}\n`), 'whole description')
  assert.ok(backendPrompt.includes('## Task instructions'))
  // Prior conversation seeds session.input in the documented message shape.
  const recentMessages = [{ role: 'user', content: '帮我记一下明天开会' }, { role: 'assistant', content: '好的，已记下。' }, { role: 'system', content: 'ignored' }]
  assert.deepEqual(build({}, { recentMessages }).input, [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: '帮我记一下明天开会' }] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '好的，已记下。' }] },
  ])
  const many = sessionInputHistory(Array.from({ length: 200 }, (_, i) => ({ role: 'user', content: `m${i}` })))
  assert.deepEqual([many.length, many.at(-1).content[0].text], [64, 'm199'])
  // A CJK character is about one token: 5,000 + 5,000 exceed the budget, so only the latest two are seeded.
  const budgeted = sessionInputHistory([
    { role: 'user', content: '早'.repeat(5000) }, { role: 'assistant', content: '好'.repeat(5000) }, { role: 'user', content: '再见' },
  ])
  assert.deepEqual(budgeted.map(message => message.content[0].text.length), [5000, 2])
  assert.deepEqual(sessionInputHistory([{ role: 'user', content: '早'.repeat(7000) }]), [], 'a newest message over the budget seeds nothing')
})

test('GPT-Live 1 omits the seeded history once after the service rejected it at startup', () => {
  const recentMessages = [{ role: 'user', content: '早' }, { role: 'assistant', content: '好' }]
  const build = messages => gptLive1Provider.buildSession({ agentContext: { recentMessages: messages }, sessionOptions: {} })
  const protocol = gptLive1Provider.createProtocol({})
  protocol.connectionMessages({ session: build(recentMessages) })
  assert.equal(build(recentMessages).input.length, 2)
  const error = { code: 'invalid_value', param: 'session.input', message: 'input exceeds 8192 tokens', client_event_id: 'event_start' }
  protocol.normalizeIncoming({ type: 'error', error: { type: 'invalid_request_error', ...error } })
  // Another connection in the same process seeds its own history untouched.
  assert.equal(build([{ role: 'user', content: '午安' }]).input.length, 1)
  assert.equal(build(recentMessages).input, undefined, 'the retry connects without the history the service refused')
  assert.equal(build(recentMessages).input.length, 2, 'later connects seed it again')
})

test('GPT-Live 1 classifies errors by what they cost: the session, its capacity or only the turn', () => {
  for (const [message, kind] of [
    ['Unexpected server response: 401', 'fatal'],
    // A model that does not exist is configuration, not weather: no reconnect loop.
    ["model_not_deployed: invalid_request_error: Model deployment 'x' was not found.", 'fatal'],
    ['model_not_found: The model `x` does not exist', 'fatal'],
    ['Unexpected server response: 429', 'capacity_busy'], ['Too many concurrent sessions for this tier', 'capacity_busy'],
    // A failed backend response fails its turn; it is not session capacity.
    ['rate_limit_exceeded: Rate limit reached for requests', 'other'],
    // The service's own upstream auth failing mid-session fails only the turn.
    ['invalid_request_error: upstream authentication failed: Unauthorized', 'other'], ['immutable_field_update: instructions', 'other'],
    // Moderation that only cuts the current speech leaves the session open.
    ['content_filter: invalid_request_error: blocked by content policy', 'other'],
    // Realtime API wording means nothing on the Live API.
    ['Conversation already has an active response', 'other'],
  ]) {
    assert.equal(gptLive1Provider.classifyError(message), kind, message)
  }
})

test('GPT-Live 1 speaks announcements as commentary appends settled by their acknowledgement', () => {
  const live = liveAdapter()
  const say = gptLive1Provider.buildSpeakResponse('晚饭好了')
  assert.deepEqual(say, { __liveSay: '晚饭好了' })
  assert.deepEqual(live.responseCreate(say), { type: 'session.commentary.append', delegation_id: null, content: '晚饭好了' })
  // Appends cap at 500 tokens: a runaway one is clamped, not rejected; a CJK character is a whole token.
  const long = live.responseCreate({ __liveSay: 'x'.repeat(5000) })
  assert.ok(long.content.endsWith('…'))
  assert.ok(estimateTokens(long.content) <= 480, String(estimateTokens(long.content)))
  const cjk = clampCommentary('天'.repeat(1000))
  assert.ok(cjk.endsWith('…'))
  assert.ok([...cjk].length <= 481, String([...cjk].length))
  assert.equal(cjk, `${'天'.repeat(479)}…`, 'cut at the cap, not emptied')
  assert.equal(clampCommentary('晚饭好了'), '晚饭好了')
  // A spoken payload never turns into a backend instruction item.
  assert.equal(live.responseInstructionsItem({ __liveSay: '晚饭好了', instructions: 'ignored' }), null)
  // Without spoken content a response request continues the delegated backend.
  assert.deepEqual(live.responseCreate(undefined), { type: 'response.create' })
  assert.deepEqual(live.responseCreate({ modalities: ['audio'] }), { type: 'response.create' })
  // A request that forbids tools says so in its instruction item.
  const text = response => live.responseInstructionsItem(response)?.content[0].text
  assert.equal(text({ tool_choice: 'none' }), 'Do not call any tool in this response.')
  assert.equal(text({ tool_choice: 'none', instructions: '说明结果。' }), '说明结果。 Do not call any tool in this response.')
  // The acknowledgement settles the speak request as a playback response, which never gates Gateway work.
  const append = live.encodeOutgoing(live.responseCreate(say))
  assert.equal(append.type, 'session.commentary.append')
  const acked = live.feed({ type: 'session.commentary.appended', client_event_id: append.event_id })
  assert.deepEqual(types(acked), ['response.created', 'response.done'])
  assert.equal(acked[0].__voicePlayback, true)
  assert.equal(acked[1].response.id, acked[0].response.id)
  assert.deepEqual(live.feed({ type: 'session.commentary.appended', client_event_id: 'event_unknown' }), [])
  // A rejected commentary fails its own request, not the running backend response.
  const second = live.encodeOutgoing(live.responseCreate({ __liveSay: 'x' }))
  const rejected = live.feed({ type: 'error', error: { code: 'invalid_request_error', message: 'too long', client_event_id: second.event_id } })
  assert.deepEqual(types(rejected), ['response.created', 'error'])
  assert.equal(rejected[1].response_id, rejected[0].response.id)
  assert.equal(rejected[0].__voicePlayback, true, 'so it fails the speak request, not a queued backend request')
})

test('GPT-Live 1 routes results, permissions, tool results and history to the backend, whose prompt has the Gateway rules', () => {
  const protocol = gptLive1Provider.createProtocol({})
  const create = item => protocol.conversationItemCreate(item)
  const userText = text => ({ type: 'response.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } })
  const injection = gptLive1Provider.buildResultInjection('任务完成：报告已生成')
  assert.deepEqual(create(injection.item), userText('任务完成：报告已生成'))
  // The voice layer speaks the backend's reply, even after a stop; the backend prompt has the guidance.
  assert.deepEqual(injection.response, { __liveAnnounce: true })
  assert.equal(protocol.responseInstructionsItem(injection.response), null)
  assert.deepEqual(protocol.responseCreate(injection.response), { type: 'response.create' })
  const permission = gptLive1Provider.buildPermissionInjection({ id: 'perm_1', taskId: 'task_1', summary: '删除文件' })
  const permissionItem = create(permission.item)
  assert.equal(permissionItem.type, 'response.item.create')
  assert.match(permissionItem.item.content[0].text, /permission_id=perm_1/)
  assert.deepEqual(permission.response, { __liveAnnounce: true })
  assert.equal(protocol.responseInstructionsItem(permission.response), null)
  assert.equal(protocol.responseInstructionsItem(undefined), null)
  const { instructions } = gptLive1Provider.buildSession({ agentContext: {}, sessionOptions: {} }).delegation.responses
  assert.match(instructions, /## Gateway messages/)
  assert.match(instructions, /handle each as follows, without calling\ntools/)
  assert.ok(instructions.includes(permissionResponseInstructions))
  assert.ok(instructions.includes(resultResponseInstructions))
  assert.equal(protocol.responseInstructionsItem({ instructions: resultResponseInstructions }), null)
  assert.equal(protocol.responseInstructionsItem({ instructions: progressResponseInstructions }), null)
  assert.equal(protocol.responseInstructionsItem({ instructions: '只读第一条工具结果' })?.type, 'message',
    'other per-response instructions still travel as items')
  assert.deepEqual(create(protocol.functionOutputItem('call_1', { ok: true })), {
    type: 'response.item.create', item: { type: 'function_call_output', call_id: 'call_1', output: '{"ok":true}' },
  })
  assert.deepEqual(create(protocol.userTextItem('记住我喝美式')), userText('记住我喝美式'))
  assert.equal(create(protocol.userTextItem('   ')), null)
  const history = create({ type: 'message', role: 'assistant', content: [{ type: 'text', text: '好的' }] })
  assert.deepEqual(history.item.content, [{ type: 'output_text', text: '好的' }], 'assistant history goes in as output_text')
})

test('GPT-Live 1 protocol encodes the documented client events and resends only a changed delegation', () => {
  const protocol = createGptLive1Protocol()
  const [start] = protocol.connectionMessages({ session: { model: 'gpt-live-1' } })
  assert.equal(start.type, 'session.start')
  assert.match(start.event_id, /^event_[0-9a-f]{32}$/)
  assert.deepEqual(start.session, { model: 'gpt-live-1' })
  const encoded = protocol.encodeOutgoing({ type: 'session.input_audio.append', audio: 'AAAA' })
  assert.match(encoded.event_id, /^event_[0-9a-f]{32}$/)
  assert.equal(encoded.type, 'session.input_audio.append')
  assert.equal(protocol.encodeOutgoing(null), null)
  assert.deepEqual(protocol.audioAppend('AAAA'), { type: 'session.input_audio.append', audio: 'AAAA' })
  assert.equal(protocol.sessionUpdate({ instructions: 'x' }), null, 'start-time fields are never resent')
  assert.deepEqual([protocol.inputMute(), protocol.inputUnmute(), protocol.sessionClose('client_closed')],
    [{ type: 'session.input_audio.mute' }, { type: 'session.input_audio.unmute' }, { type: 'session.close' }])
  assert.equal(protocol.responseCancel(), null)
  assert.equal(protocol.imageAppend('img'), null)
  // Only the delegation block may change after startup: sent whole, on change.
  const delegation = { type: 'responses', responses: { model: 'gpt-6-luna', tools: [{ type: 'function', name: 'a' }] } }
  protocol.connectionMessages({ session: { model: 'gpt-live-1', delegation } })
  assert.equal(protocol.sessionUpdate({ model: 'gpt-live-1', delegation }), null, 'unchanged after start')
  const changed = { ...delegation, responses: { ...delegation.responses, tools: [{ type: 'function', name: 'b' }] } }
  assert.deepEqual(protocol.sessionUpdate({ model: 'gpt-live-1', instructions: 'ignored', delegation: changed }), {
    type: 'session.update', session: { delegation: changed },
  })
  assert.equal(protocol.sessionUpdate({ delegation: changed }), null, 'deduplicated')
})

test('GPT-Live 1 protocol brackets spoken output into responses', () => {
  const live = liveAdapter()
  assert.deepEqual(live.feed(STARTED), { type: 'session.created', session: { id: 'sess_1' } })
  const first = live.feed(MODEL_SPEECH)
  const id = openedId(first)
  assert.deepEqual(first, [
    { type: 'response.created', response: { id, status: 'in_progress' }, response_id: id, __voicePlayback: true, __voiceAutomatic: true },
    { type: 'response.output_audio.delta', response_id: id, delta: SPEECH },
  ])
  assert.deepEqual(live.feed(MODEL_SPEECH), [{ type: 'response.output_audio.delta', response_id: id, delta: SPEECH }])
  assert.deepEqual(live.feed(modelSays('你好', 0, 200)), [caption(id, '你好')])
  // Output going quiet closes the response with its transcript; the next speech opens another.
  assert.deepEqual(live.feed(OUTPUT_IDLE), [{ type: ANSWER_ENDS[0], response_id: id, transcript: '你好' }, voiceDone(id)])
  const later = live.feed(MODEL_SPEECH)
  assert.deepEqual(types(later), ANSWER_OPENS)
  assert.notEqual(later[0].response.id, id)
  assert.equal(later[1].response_id, later[0].response.id)
})

test('GPT-Live 1 protocol synthesises the user turn from timed transcript fragments', () => {
  const live = liveAdapter()
  live.feed(MODEL_SPEECH)
  // Fresh user speech is a barge-in; the answer plays on, a pause included, and closes once the model yields.
  const started = live.feed(userSays('明天', 600, 800))
  const itemId = started[0].item_id
  assert.deepEqual(types(started), TURN_OPENS)
  assert.deepEqual([started[1].item_id, started[1].text], [itemId, '明天'])
  assert.deepEqual(types(live.feed(MODEL_SILENCE)), ['response.output_audio.delta'])
  assert.deepEqual(live.feed(OUTPUT_IDLE).map(event => [event.type, event.response.status]), [['response.done', 'completed']])
  // The delegation commits the turn; later fragments flow into the committed item.
  const delegation = { id: 'item_d1', type: 'delegation', target: 'responses' }
  assert.deepEqual(live.feed({ type: 'session.delegation.created', delegation }), turnEnd(itemId))
  assert.deepEqual(live.feed(userSays('天气', 800, 1200)), [{ type: USER_DELTA, item_id: itemId, delta: '天气', text: '明天天气' }],
    'text carries the caption so far, not the bare fragment')
  // Only the answer opens: the turn is already committed.
  const answer = live.feed(MODEL_SPEECH)
  assert.deepEqual(types(answer), ANSWER_OPENS)
  // The transcript dates the answer; a late fragment of the question joins it without cutting the answer.
  live.feed(modelSays('明天', 2000, 2200))
  assert.deepEqual(live.feed(userSays('怎么样', 1200, 1500)).map(event => [event.type, event.item_id]), [[USER_DELTA, itemId]])
  // Idle while the answer plays: already committed, so only the transcript completes.
  assert.deepEqual(live.feed(INPUT_IDLE), [{ type: USER_DONE, item_id: itemId, transcript: '明天天气怎么样' }])
  // Speech from before the answer began is no barge-in, and the question is final: no turn starts.
  assert.deepEqual(live.feed(userSays('还有', 1700, 1900)), [], 'speech from before the answer started must not cancel it')
  assert.deepEqual(live.feed(INPUT_IDLE), [], 'not completed twice')
  // Speech after the answer began is a barge-in; the answer plays out and closes once the model yields.
  const next = live.feed(userSays('谢谢', 4000, 4200))
  assert.deepEqual(types(next), TURN_OPENS)
  assert.notEqual(next[0].item_id, itemId)
  assert.deepEqual(types(live.feed(MODEL_SILENCE)), ['response.output_audio.delta'])
  assert.deepEqual(live.feed(OUTPUT_IDLE).at(-1).response, { id: openedId(answer), status: 'completed' },
    'an interruption cuts nothing from the playback record')
})

test('GPT-Live 1 applies configured timing and keeps its defaults when none is set', async t => {
  const names = ['OUTPUT_IDLE', 'WORD_GAP', 'INPUT_SEGMENT_GAP', 'INPUT_IDLE']
  const every = resolveGptLive1Timing(Object.fromEntries(names.map(name => [`GPT_LIVE_1_${name}_MS`, '700'])))
  assert.deepEqual(Object.keys(every).sort(), Object.keys(GPT_LIVE_1_TIMING_DEFAULTS).sort(), 'each setting names a protocol option')
  const saved = config.gptLive1Timing
  t.after(() => { config.gptLive1Timing = saved })
  const utterance = timing => {
    config.gptLive1Timing = timing
    const emitted = []
    const live = gptLive1Provider.createProtocol({ emit: event => emitted.push(event), now: () => 0 })
    live.normalizeIncoming(userSays('你好', 100, 300))
    live.normalizeIncoming(MODEL_SPEECH)
    const next = live.normalizeIncoming(userSays('等等', 1000, 1200))
    return { emitted, splits: next.some(event => event.type === TURN_OPENS[0]) }
  }
  const defaults = utterance({})
  const tuned = utterance({ inputSegmentGapMs: 500, inputIdleMs: 20 })
  await sleep(60)
  assert.equal(defaults.splits, false, 'speech 0.7 s after the question is not a barge-in by default')
  assert.deepEqual(defaults.emitted, [], 'the default 2 s idle has not passed')
  assert.equal(tuned.splits, true)
  assert.deepEqual(tuned.emitted, [INPUT_IDLE])
})

test('GPT-Live 1 protocol completes an utterance and closes a spoken segment once each goes idle, not on streamed silence', async () => {
  const inputEvents = []
  const input = liveAdapter({ emit: event => inputEvents.push(event), inputIdleMs: 20, outputIdleMs: 0 })
  const itemId = input.feed(userSays('你好', 100, 300)).find(event => event.type === TURN_OPENS[0]).item_id
  await sleep(60)
  assert.equal(inputEvents.length, 1)
  assert.deepEqual(input.feed(inputEvents[0]), [...turnEnd(itemId), { type: USER_DONE, item_id: itemId, transcript: '你好' }])
  // Once the answer begins, a late fragment from before it starts no turn; speech after it does.
  assert.equal(input.feed(MODEL_SPEECH)[0].type, 'response.created')
  assert.deepEqual(input.feed(userSays('啊', 300, 400)), [])
  const fresh = input.feed(userSays('等等', 2500, 2700))
  assert.deepEqual(types(fresh), TURN_OPENS)
  assert.notEqual(fresh[0].item_id, itemId)
  // Silence between or inside answers neither opens nor extends a spoken segment.
  const outputEvents = []
  const output = liveAdapter({ emit: event => outputEvents.push(event), outputIdleMs: 20 })
  assert.deepEqual(output.feed(MODEL_SILENCE), [], 'silence between answers is no output')
  const id = output.play(MODEL_SPEECH)[0].response.id
  // A pause inside the answer plays through without extending the segment.
  assert.deepEqual(output.feed(MODEL_SILENCE), [{ type: 'response.output_audio.delta', response_id: id, delta: SILENCE }])
  const stream = setInterval(() => output.feed(MODEL_SILENCE), 5)
  await sleep(60)
  clearInterval(stream)
  assert.deepEqual(outputEvents, [OUTPUT_IDLE])
  assert.deepEqual(output.feed(outputEvents[0]), [voiceDone(id)])
  assert.deepEqual(output.play(OUTPUT_IDLE, MODEL_SILENCE), [], 'idle or silence after the segment closed is a no-op')
  // Words alone, their audio still to come, open a segment; each restarts the window, which fires once.
  output.play(modelSays('好', 0, 100), modelSays('的', 100, 200))
  await sleep(60)
  assert.deepEqual(outputEvents, [OUTPUT_IDLE, OUTPUT_IDLE])
})

test('GPT-Live 1 protocol unwraps the delegated Responses lifecycle and its function-call loop', () => {
  const live = liveAdapter()
  const feed = (event, delegationId = 'item_d1') => live.feed(backend(delegationId, event))
  const opened = id => [{ type: 'response.created', response: { id, status: 'in_progress' }, response_id: id }]
  assert.deepEqual(feed(created('resp_1')), opened('resp_1'))
  assert.deepEqual(feed({ type: 'response.output_text.delta', delta: 'The forecast is' }), [])
  assert.deepEqual(feed({ type: 'response.output_item.done', item: { type: 'message', role: 'assistant', content: [] } }), [], 'a text item is no call')
  const item = { type: 'function_call', call_id: 'call_1', name: 'spawn_thinking', arguments: '{"task":"查天气"}' }
  assert.deepEqual(feed({ type: 'response.output_item.done', response: { id: 'resp_1' }, item }), [{
    type: 'response.function_call_arguments.done', response_id: 'resp_1', call_id: 'call_1', name: 'spawn_thinking', arguments: '{"task":"查天气"}',
  }])
  // Nested events without a response object take their delegation's response, else the last one opened.
  assert.equal(feed(toolCall('call_2'))[0].response_id, 'resp_1')
  assert.equal(feed(toolCall('call_3'), null)[0].response_id, 'resp_1')
  // Arguments-done alone identifies no call; its call_id-less twin is dropped, not raised as a bad call.
  assert.deepEqual(feed({ type: 'response.function_call_arguments.done', call_id: 'call_2', name: 'get_current_time', arguments: '{}' }), [])
  assert.deepEqual(feed({ type: 'response.function_call_arguments.done', arguments: '{"q":"x"}' }), [])
  assert.deepEqual(feed(completed('resp_1')), [{ type: 'response.done', response: { id: 'resp_1', status: 'completed' }, response_id: 'resp_1' }])
  const failed = feed({ type: 'response.failed', response: { id: 'resp_2', error: { message: 'quota' } } })
  assert.deepEqual([failed[0].type, failed[0].error.message], ['error', 'quota'])
  // A delegation that names its response carries that id until it completes.
  const delegation = { id: 'item_d9', type: 'delegation', target: 'responses', response_id: 'resp_9' }
  assert.deepEqual(live.feed({ type: 'session.delegation.created', delegation }), [])
  assert.equal(feed(toolCall('call_9', 'fetch_url'), 'item_d9')[0].response_id, 'resp_9', 'a call carries the bound id, not the delegation id')
  assert.equal(feed(completed('resp_9'), 'item_d9')[0].response_id, 'resp_9')
  assert.equal(feed(toolCall('call_x', 'f'), 'item_d9')[0].response_id, 'item_d9', 'a stray event falls back to the delegation id')
  // A response continued after tool results resumes with in_progress alone.
  const inProgress = { type: 'response.in_progress', response: { id: 'resp_c' } }
  assert.equal(feed(created('resp_c'), 'item_d')[0].type, 'response.created')
  assert.deepEqual(feed(inProgress, 'item_d'), [], 'in_progress after created adds nothing')
  feed(completed('resp_c'), 'item_d')
  assert.deepEqual(feed(inProgress, 'item_d'), opened('resp_c'))
  feed(created('resp_x'), 'item_x')
  assert.deepEqual(feed({ type: 'response.incomplete', response: { id: 'resp_x', status: 'incomplete' } }, 'item_x'), [
    { type: 'response.done', response: { id: 'resp_x', status: 'incomplete' }, response_id: 'resp_x' },
  ])
})

test('GPT-Live 1 protocol passes errors through, isolates command errors and closes cleanly or for content', () => {
  const live = liveAdapter()
  const error = () => ({ type: 'invalid_request_error', code: 'invalid_audio', message: 'odd bytes' })
  assert.deepEqual(live.feed({ type: 'error', error: error() }), { type: 'error', error: error() }, 'before startup, as it is')
  for (const type of ['session.updated', 'session.usage.updated', 'session.commentary.appended', 'session.thinking.appended',
    'session.instructions.appended', 'session.input_audio.muted', 'session.input_audio.unmuted']) {
    assert.deepEqual(live.feed({ type }), [], type)
  }
  // Unknown events pass through without the runtime's private keys.
  const foreign = { type: 'session.foreign', __voicePlayback: true, __voiceOrigin: 'announcement', detail: 1 }
  assert.deepEqual(live.feed(foreign), { type: 'session.foreign', detail: 1 })
  // After startup a rejected mute is a command error with its own id, not the active backend response's.
  live.feed(STARTED)
  const rejected = (message, client_event_id) => live.feed({ type: 'error', error: { code: 'invalid_request_error', message, client_event_id } })
  const mute = live.encodeOutgoing({ type: 'session.input_audio.mute' })
  assert.equal(rejected('not now', mute.event_id).response_id, `gpt-live-1:command:${mute.event_id}`)
  // A rejected response.create does concern the pending backend response.
  assert.equal(rejected('pending results', live.encodeOutgoing({ type: 'response.create' }).event_id).response_id, undefined)
  // A session error that names no command settles no Gateway request either.
  assert.match(live.feed({ type: 'error', event_id: 'event_s', error: { message: 'x' } }).response_id, /^gpt-live-1:command:event_s$/)
  live.feed(userSays('嗨', 0, 100))
  assert.deepEqual(types(live.feed(MODEL_SPEECH)).slice(0, 2), TURN_ENDS)
  assert.deepEqual(types(live.feed({ type: 'session.closed', reason: 'close_requested', usage: { seconds: 3 } })), [USER_DONE, 'response.done'])
  // A close for content ends the answer it cut off unrecorded.
  const moderated = liveAdapter()
  moderated.feed(modelSays('好的', 0, 200))
  const content = moderated.feed({ type: 'session.closed', reason: 'content', usage: { seconds: 10 } })
  assert.equal(content.find(event => event.type === 'response.done').response.status, 'incomplete')
  assert.equal(content.at(-1).type, 'error')
  assert.equal(gptLive1Provider.classifyError(realtimeEventErrorMessage(content.at(-1))), 'content_safety')
  assert.deepEqual(moderated.feed({ type: 'session.closed', reason: 'expired' }), [])
})

test('GPT-Live 1 answers a call whose result the service rejected with a failure and re-requests the response', async () => {
  const sent = []
  const live = liveAdapter({ send: (payload, options) => sent.push({ payload: live.encodeOutgoing(payload), options }) })
  const wire = () => sent.map(({ payload }) => payload.type)
  const rejected = (code, client_event_id, message = 'item rejected') => live.feed({ type: 'error', error: { code, message, client_event_id } })
  const outputsRequired = id => rejected('function_call_outputs_required', id, 'Submit the pending function call outputs before response.create.')
  live.feed(STARTED)
  const message = live.encodeOutgoing(live.conversationItemCreate(live.userTextItem('晚安')))
  assert.equal(rejected('invalid_value', message.event_id).type, 'error', 'a refused message is surfaced, not answered as a call')
  const item = live.encodeOutgoing(live.conversationItemCreate(live.functionOutputItem('call_1', { content: 'result' })))
  const create = live.encodeOutgoing({ type: 'response.create' })
  assert.deepEqual(live.feed({ type: 'error', error: {
    type: 'invalid_request_error', code: 'invalid_value', message: 'item rejected', client_event_id: item.event_id,
  } }), [], 'the rejection is handled, not surfaced')
  await tick()
  // Every call needs a result before the backend continues: a failure stands in, worded so the action is not run again.
  assert.deepEqual(wire(), ['response.item.create'])
  assert.equal(sent[0].payload.item.call_id, 'call_1')
  assert.equal(JSON.parse(sent[0].payload.item.output).retryable, false)
  // The response.create it held up is refused as expected and sent again.
  assert.deepEqual(outputsRequired(create.event_id), [])
  await tick()
  assert.deepEqual(wire(), ['response.item.create', 'response.create'])
  assert.deepEqual(sent[1].options, { correlate: false }, 'the re-request is not correlated to a Gateway request')
  assert.equal(outputsRequired('event_other').type, 'error')
  // A refused failure closes the session for a fresh one; its error settles no Gateway request.
  const failureId = sent[0].payload.event_id
  assert.equal(rejected('invalid_value', failureId).response_id, `gpt-live-1:command:${failureId}`)
  await tick()
  assert.deepEqual(wire(), ['response.item.create', 'response.create', 'session.close'])
})

test('connects to a GPT-Live 1 mock service with session.start and no session.update', { timeout: 10000 }, async t => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await once(server, 'listening')
  const url = `ws://127.0.0.1:${server.address().port}/v1/live/sessions`
  withConfig(t, { audioProvider: 'gpt-live-1', realtimeCredential: 'live-test', realtimeModel: 'gpt-live-1', realtimeVoice: 'marin', realtimeEndpoint: url })
  const received = []
  const events = []
  let authorization = ''
  server.once('connection', (socket, request) => {
    authorization = request.headers.authorization
    // The service acknowledges the start and each commentary, then speaks.
    socket.on('message', raw => {
      const message = JSON.parse(raw.toString())
      received.push(message)
      const ack = message.type === 'session.start' ? { type: 'session.started', session: { id: 'sess_1', model: message.session.model } }
        : message.type === 'session.commentary.append' ? { type: 'session.commentary.appended', client_event_id: message.event_id }
          : null
      if (ack) for (const frame of [ack, MODEL_SPEECH]) socket.send(JSON.stringify(frame))
    })
  })
  const { frontend } = liveFrontend(t, { onEvent: event => events.push(event), responseStartTimeoutMs: 2000 })
  t.after(() => new Promise(resolve => server.close(resolve)))
  await frontend.connect()
  assert.equal(frontend.ready, true)
  assert.equal(authorization, 'Bearer live-test')
  const [start] = received
  assert.equal(start.type, 'session.start')
  assert.match(start.event_id, /^event_/)
  assert.equal(start.session.model, 'gpt-live-1')
  assert.equal(start.session.delegation.type, 'responses')
  assert.deepEqual(start.session.audio, { output: { voice: 'marin' } })
  // Startup configuration is immutable: nothing else is sent before speech.
  assert.equal(received.filter(message => message.type === 'session.update').length, 0)
  while (!has(events, 'response.output_audio.delta')) await sleep(5)
  // Spoken output never holds up a speak request.
  const outcome = await frontend.speak('晚饭好了', 'announcement')
  const commentary = received.find(message => message.type === 'session.commentary.append')
  assert.equal(commentary?.content, '晚饭好了')
  assert.equal(commentary?.delegation_id, null)
  assert.equal(outcome.completed, true)
  // The announcement settles on the acknowledgement as a playback response of its own.
  const announcement = events.find(event => event.type === 'response.created' && event.__voiceOrigin === 'announcement')
  assert.ok(announcement, 'the speak request bound to the acknowledged commentary')
  assert.equal(announcement.__voicePlayback, true)
  assert.ok(events.some(event => event.type === 'response.done' && event.response.id === announcement.response.id))
})

test('GPT-Live 1 protocol plays an interrupted answer out and closes it once the model yields', async () => {
  const emitted = []
  const live = liveAdapter({ emit: event => emitted.push(event), outputIdleMs: 20 })
  const voiceId = openedId(live.play(MODEL_SPEECH))
  // Neither a passed-through foreign response nor a delegated backend response is playback a cancel closes.
  live.play(created('response_passthrough'), backend('item_bg', created('resp_bg')))
  assert.equal(live.interruptPlayback()?.type, 'session.instructions.append', 'the model is told to stop speaking')
  await new Promise(resolve => queueMicrotask(resolve))
  assert.deepEqual(emitted, [], 'nothing closes yet')
  assert.deepEqual(live.feed({ type: 'session.usage.updated', usage: { seconds: 3 } }), [], 'a usage update is not the model yielding')
  // What the model already said plays out, captioned, its pauses included.
  assert.deepEqual(live.feed(modelSays('了', 400, 600)), [caption(voiceId, '了')])
  assert.deepEqual(types(live.feed(MODEL_SILENCE)), ['response.output_audio.delta'])
  assert.equal(live.feed(backend('item_bg', completed('resp_bg')))[0].response_id, 'resp_bg')
  // Once the model has been quiet, the answer closes as played.
  await sleep(60)
  assert.deepEqual(live.feed(emitted.at(-1)), [{ type: ANSWER_ENDS[0], response_id: voiceId, transcript: '了' }, voiceDone(voiceId)])
  // An interrupted segment does not leak into the next one.
  const nextId = openedId(live.play(MODEL_SPEECH))
  assert.notEqual(nextId, voiceId)
  live.interruptPlayback()
  assert.deepEqual(live.feed(OUTPUT_IDLE), [voiceDone(nextId)])
  // An interruption with nothing playing is a no-op.
  assert.equal(live.interruptPlayback(), null)
  assert.deepEqual(live.feed(MODEL_SILENCE), [])
})

test('GPT-Live 1 gates Gateway work on open backend responses only, never on voice playback', async t => {
  assert.equal(gptLive1Provider.capabilities.concurrentVoicePlayback, true)
  // Synthesised voice responses are playback end to end.
  const marked = liveFrontend(t).frontend
  const opened = [MODEL_SPEECH].flatMap(raw => marked.protocol.normalizeIncoming(raw)).find(event => event.type === 'response.created')
  assert.equal(opened.__voicePlayback, true)
  marked.handleLifecycle(opened)
  assert.equal(marked.playbackResponses.has(opened.response.id), true)
  assert.equal(marked.gatingResponsesActive(), false)
  const { frontend } = liveFrontend(t)
  frontend.activeResponses.add('voice_1')
  frontend.playbackResponses.add('voice_1')
  assert.equal(frontend.gatingResponsesActive(), false)
  await frontend.whenIdle() // resolves immediately despite open playback
  // A backend delegation response does gate: whenIdle waits for it.
  frontend.activeResponses.add('resp_1')
  assert.equal(frontend.gatingResponsesActive(), true)
  let resolved = false
  const idle = frontend.whenIdle().then(() => { resolved = true })
  await sleep(15)
  assert.equal(resolved, false, 'a backend response still gates whenIdle')
  frontend.activeResponses.delete('resp_1')
  frontend.resolveIdle()
  await idle
  assert.equal(resolved, true)
  // A stale playback id that is no longer active must not hide a backend response.
  frontend.playbackResponses.add('voice_stale')
  frontend.activeResponses.add('resp_2')
  assert.equal(frontend.gatingResponsesActive(), true)
  // A failed backend response is released, or Gateway requests would be gated forever.
  const failing = liveFrontend(t)
  failing.feed(MODEL_SPEECH, backend('item_f', created('resp_f')))
  assert.equal(failing.frontend.gatingResponsesActive(), true, 'a voice segment and a backend response are open')
  const quota = { type: 'response.failed', response: { id: 'resp_f', error: { message: 'quota' } } }
  const failed = failing.frontend.protocol.normalizeIncoming(backend('item_f', quota))
  assert.equal(failed[0].type, 'error')
  assert.equal(failed[0].response_id, 'resp_f', 'the failure names the response it ends')
  for (const event of failed) failing.frontend.handleLifecycle(event)
  assert.equal(failing.frontend.activeResponses.has('resp_f'), false)
  assert.equal(failing.frontend.gatingResponsesActive(), false, 'only the playback response remains')
  await failing.frontend.whenIdle()
})

test('GPT-Live 1 leaves a Gateway request to its backend response, not to command errors, model speech or a re-request', t => {
  const errors = liveFrontend(t)
  errors.feed(STARTED, backend('item_c', created('resp_c')))
  const waiter = gatewayRequest()
  errors.frontend.responseWaiters.set('resp_c', waiter)
  // A rejected append is a command error with a synthetic id, not the backend's.
  errors.feed({ type: 'error', error: { code: 'invalid_request_error', message: 'append rejected', client_event_id: 'event_append_1' } })
  assert.equal(errors.frontend.responseWaiters.get('resp_c'), waiter, 'the sole waiting request is not settled by an unrelated error')
  assert.equal(waiter.settled, false)
  assert.equal(errors.frontend.activeResponses.has('resp_c'), true)
  // The model's own speech leaves a queued request for the backend response.
  const { frontend, feed } = liveFrontend(t)
  feed(STARTED)
  const pending = gatewayRequest({ origin: 'announcement', context: { taskIds: ['t1'] }, responseRequested: true, isCurrent: () => true })
  frontend.pendingResponses.push(pending)
  feed(MODEL_SPEECH)
  assert.equal(frontend.pendingResponses[0], pending, "the voice layer's own speech does not take the request")
  for (const id of frontend.playbackResponses) assert.equal(frontend.responseWaiters.has(id), false)
  feed(backend('item_a', created('resp_a')))
  assert.equal(frontend.pendingResponses.length, 0)
  assert.equal(frontend.responseWaiters.get('resp_a'), pending, 'the backend response answers it')
  // A protocol re-request goes out uncorrelated, leaving the pending request as it is.
  const { frontend: resent } = liveFrontend(t)
  const sent = openSocket(resent)
  resent.ready = true
  const responsePayload = { type: 'session.commentary.append', content: 'hi' }
  const queued = { requestId: 'req_1', origin: 'agent', context: {}, resolve() {}, reject() {}, responsePayload }
  resent.pendingResponses.push(queued)
  resent.send({ type: 'response.create' }, { correlate: false })
  assert.equal(queued.responsePayload.type, 'session.commentary.append')
  resent.send({ type: 'response.create' })
  assert.equal(queued.responsePayload.type, 'response.create')
  assert.equal(sent.filter(event => event.type === 'response.create').length, 2)
})

test('GPT-Live 1 keeps playback separate from failed requests and cancel recovery', async t => {
  const { frontend, feed } = liveFrontend(t, { responseCancelGraceMs: 1 })
  const playing = () => [...frontend.playbackResponses][0]
  feed(MODEL_SPEECH)
  const first = playing()
  // A request that fails without a response id is not charged to the playing answer.
  const waiter = gatewayRequest({ origin: 'tool', responseRequested: true, resolve: outcome => { waiter.outcome = outcome } })
  frontend.pendingResponses.push(waiter)
  frontend.handleLifecycle({ type: 'error', error: { message: 'rejected' } })
  assert.equal(waiter.outcome.failed, true)
  assert.equal(frontend.activeResponses.has(first), true)
  // Typed input: the model is told to stop, and the answer plays out, then closes once the model is quiet.
  frontend.cancel({ reason: 'user_interruption' })
  feed(MODEL_SPEECH, MODEL_SILENCE)
  assert.equal(playing(), first)
  feed(OUTPUT_IDLE)
  assert.equal(frontend.activeResponses.size, 0)
  // An explicit stop fully cancels; past its grace the answer playing out is still playback and gates nothing.
  feed(MODEL_SPEECH)
  const second = playing()
  frontend.cancel()
  await sleep(10)
  feed(MODEL_SPEECH)
  assert.equal(playing(), second)
  assert.equal(frontend.gatingResponsesActive(), false)
  feed(OUTPUT_IDLE)
  assert.equal(frontend.activeResponses.size, 0)
})

test('GPT-Live 1 stops nothing on user speech, tells the model to stop on typed input or a stop, and drops queued requests only on a stop', t => {
  const stopSpeaking = { type: 'session.instructions.append', delegation_id: null, content: 'Stop speaking now and drop the reply you were giving. This applies to that reply only: if the user asks for it again, give it.' }
  // The model heard the user cut in: nothing is sent, and the answer plays on.
  const protocol = createGptLive1Protocol()
  protocol.normalizeIncoming(MODEL_SPEECH)
  protocol.normalizeIncoming(userSays('等等', 1000, 1200))
  assert.equal(protocol.interruptPlayback({ speech: true }), null)
  assert.deepEqual(types([].concat(protocol.normalizeIncoming(MODEL_SPEECH))), ['response.output_audio.delta'], 'the answer plays on')
  assert.deepEqual(protocol.interruptPlayback({ stop: true }), stopSpeaking)
  // Typed input cuts the answer unheard: the model is told to stop, as on a stop; with nothing playing, nothing is sent.
  const typed = createGptLive1Protocol()
  typed.normalizeIncoming(MODEL_SPEECH)
  assert.deepEqual(typed.interruptPlayback(), stopSpeaking)
  assert.equal(createGptLive1Protocol().interruptPlayback(), null)
  for (const [options, stop] of [[undefined, true], [{ reason: 'user_interruption' }, false]]) {
    const { frontend: idle } = liveFrontend(t)
    const sent = openSocket(idle)
    idle.cancel(options)
    assert.deepEqual(types(sent), stop ? ['session.instructions.append'] : [])
    // Either way the answer plays out; once it has closed, only a stop keeps the model's next words off playback.
    const { frontend, feed } = liveFrontend(t)
    feed(MODEL_SPEECH)
    frontend.cancel(options)
    feed(MODEL_SILENCE, MODEL_SPEECH)
    assert.equal(frontend.playbackResponses.size, 1, 'the answer plays out')
    feed(OUTPUT_IDLE, MODEL_SPEECH)
    assert.equal(frontend.playbackResponses.size, stop ? 0 : 1)
  }
  // The runtime marks a spoken interruption: nothing is sent, and the answer plays on.
  const { frontend: heard, feed: hear } = liveFrontend(t)
  const heardSent = openSocket(heard)
  hear(MODEL_SPEECH, userSays('等等', 1000, 1200))
  heard.cancel({ reason: 'user_interruption', speech: true })
  assert.deepEqual(types(heardSent), [])
  assert.deepEqual(types([].concat(heard.protocol.normalizeIncoming(MODEL_SPEECH))), ['response.output_audio.delta'], 'the answer plays on')
  // User speech leaves backend work and queued requests running; an explicit stop cancels as on other providers.
  const { frontend, feed } = liveFrontend(t)
  feed(MODEL_SPEECH, backend('item_c', created('resp_c')))
  const waiter = gatewayRequest()
  frontend.responseWaiters.set('resp_c', waiter)
  const generation = frontend.responseQueueGeneration
  frontend.cancel({ reason: 'user_interruption' })
  assert.equal(frontend.activeResponses.has('resp_c'), true, 'the backend response keeps running')
  assert.equal(waiter.settled, false, 'the request waiting on it is not settled')
  assert.equal(frontend.responseQueueGeneration, generation, 'queued Gateway work is not dropped')
  frontend.cancel()
  assert.equal(waiter.settled, true)
  assert.equal(frontend.responseQueueGeneration, generation + 1)
})

// An open frontend past session.started; `delegation` feeds one backend response, `wire` lists what was sent.
function strictToolFrontend(t) {
  const { frontend, feed } = liveFrontend(t)
  const sent = openSocket(frontend)
  frontend.ready = true
  frontend.protocol.normalizeIncoming(STARTED)
  const delegation = (...events) => feed(...events.map(event => backend('item_d', event)))
  return { frontend, delegation, wire: () => sent.map(payload => payload.item?.type || payload.type) }
}

const delegatedCall = toolCall('call_d', 'get_agent_task_status')

test('GPT-Live 1 returns a delegated call result before a Gateway request queued behind it', async t => {
  assert.equal(gptLive1Provider.capabilities.toolOutputsBeforeResponse, true)
  const { frontend, delegation, wire } = strictToolFrontend(t)
  delegation(created('resp_d'))
  // A permission prompt queues while the delegation calls a tool; the result is ready before the delegation ends.
  frontend.ensureResponse({}, { response: { instructions: 'Ask for the permission.' } })
  delegation(delegatedCall)
  const output = frontend.sendFunctionOutput('call_d', { status: 'running' }, {}, { createResponse: false })
  delegation(completed('resp_d'))
  await output
  await tick()
  assert.deepEqual(wire(), ['function_call_output', 'message', 'response.create'])
})

test('GPT-Live 1 continues a delegated response the Gateway does not voice, once', async t => {
  const { frontend, delegation, wire } = strictToolFrontend(t)
  delegation(created('resp_d'), delegatedCall, completed('resp_d'))
  await frontend.sendFunctionOutput('call_d', { status: 'superseded' }, {}, { createResponse: false })
  assert.deepEqual(wire(), ['function_call_output'], 'appending the result alone does not resume the backend')
  const continued = frontend.continueToolResults({})
  await tick()
  assert.deepEqual(wire(), ['function_call_output', 'response.create'])
  delegation({ type: 'response.in_progress', response: { id: 'resp_d' } }, completed('resp_d'))
  assert.equal((await continued).completed, true)
  // Continued once: neither a second continuation nor a follow-up resumes it again.
  assert.equal((await frontend.continueToolResults({})).skipped, true)
  assert.equal((await frontend.ensureResponse({}, { afterToolResults: true, response: { instructions: 'Summarize.' } })).skipped, true)
  assert.deepEqual(wire(), ['function_call_output', 'response.create'])
})

test('GPT-Live 1 holds a Gateway request for a slow call but not a spoken update, and sends nothing for it after a stop', async t => {
  const { frontend, delegation, wire } = strictToolFrontend(t)
  delegation(created('resp_d'), delegatedCall, completed('resp_d'))
  // The voice layer speaks the update; it never reaches the backend.
  frontend.speak('Still checking.')
  await tick()
  assert.deepEqual(wire(), ['session.commentary.append'])
  frontend.handleLifecycle({ type: 'response.created', response: { id: 'say_1' }, __voicePlayback: true })
  frontend.handleLifecycle({ type: 'response.done', response: { id: 'say_1', status: 'completed' }, __voicePlayback: true })
  frontend.ensureResponse({})
  await tick()
  assert.deepEqual(wire(), ['session.commentary.append'], 'the request waits for the call result')
  await frontend.sendFunctionOutput('call_d', { status: 'done' }, {}, { createResponse: false })
  await tick()
  assert.deepEqual(wire(), ['session.commentary.append', 'function_call_output', 'response.create'])
  // A request stopped while it waited for the call sends no instructions.
  const stopped = strictToolFrontend(t)
  stopped.delegation(created('resp_d'), delegatedCall, completed('resp_d'))
  const request = stopped.frontend.ensureResponse({}, { response: { instructions: 'Ask for the permission.' } })
  await tick()
  stopped.frontend.cancel()
  assert.equal((await request).cancelled, true)
  assert.deepEqual(stopped.wire(), ['session.instructions.append'], 'only the stop goes out')
})

test('GPT-Live 1 plays out an answer the user cut into, and closes it on the model\'s next words', () => {
  const live = liveAdapter()
  live.play(STARTED, userSays('天气', 1000, 1400))
  const answerId = openedId(live.feed(MODEL_SPEECH))
  live.feed(modelSays('晴没有', 3000, 3600))
  // A barge-in: the answer plays on with its last words, none of which end the new turn.
  assert.deepEqual(types(live.feed(userSays('哦你', 3600, 3800))), [USER_DONE, ...TURN_OPENS])
  assert.deepEqual(live.feed(MODEL_SPEECH), [{ type: 'response.output_audio.delta', response_id: answerId, delta: SPEECH }])
  assert.deepEqual(live.feed(modelSays('下雨', 3800, 4200)), [caption(answerId, '下雨')])
  live.feed(userSays('能说日期吗', 3800, 5400))
  // Its pauses play through, and a trailing fragment stays on it.
  assert.deepEqual(types(live.play(MODEL_SILENCE, MODEL_SILENCE)), ['response.output_audio.delta', 'response.output_audio.delta'])
  assert.deepEqual(live.feed(modelSays('。', 4200, 4400)), [caption(answerId, '。')])
  // The model's next words, after a pause in its words, close it, open the reply and end the question.
  const answer = live.feed(modelSays('好', 6000, 6200))
  assert.deepEqual(types(answer), [...ANSWER_ENDS, ...TURN_ENDS, 'response.created', CAPTION])
  assert.deepEqual(answer.slice(0, 2), [{ type: ANSWER_ENDS[0], response_id: answerId, transcript: '晴没有下雨。' }, voiceDone(answerId)])
  const nextId = openedId(answer)
  assert.notEqual(nextId, answerId)
  assert.deepEqual(live.feed(MODEL_SPEECH).map(event => event.response_id), [nextId])
})

test('GPT-Live 1 leaves the playing answer alone on a Gateway request cancel', () => {
  const live = liveAdapter()
  const answerId = live.feed(MODEL_SPEECH)[0].response.id
  assert.equal(live.responseCancel(), null, 'e.g. a settled permission withdraws its queued request')
  // A pause still plays through, and the answer completes when output goes idle.
  assert.deepEqual(types(live.feed(MODEL_SILENCE)), ['response.output_audio.delta'])
  assert.deepEqual(live.feed(OUTPUT_IDLE), [voiceDone(answerId)])
})

// A barge-in recorded against the service, as [arrival ms, frame]: the user cuts into a story with a
// question. The story's speech streams on for 1.3 s after the barge-in is known, its words long sent;
// silence follows, then the reply, whose words arrive 2 s ahead of its audio.
const CUT_IN_STORY = [
  [12061, modelSays(' a young', 12200, 12400)], [12242, modelSays(' dragon', 12400, 12600)],
  [13362, MODEL_SPEECH], [13459, MODEL_SILENCE], [13560, MODEL_SILENCE],
]
const CUT_IN = [
  [13648, userSays(' Hold', 13800, 14000)], [13659, MODEL_SPEECH], [13758, MODEL_SPEECH], [13843, userSays(' on', 14000, 14200)],
  [13858, MODEL_SPEECH], [13959, MODEL_SPEECH], [14059, MODEL_SPEECH], [14159, MODEL_SPEECH], [14241, userSays('. Do', 14400, 14600)],
  [14262, MODEL_SPEECH], [14361, MODEL_SPEECH], [14442, userSays(' you', 14600, 14800)], [14458, MODEL_SPEECH], [14559, MODEL_SPEECH],
  [14641, userSays(' know', 14800, 15000)], [14659, MODEL_SPEECH], [14762, MODEL_SPEECH], [14839, userSays(' what', 15000, 15200)],
  [14859, MODEL_SPEECH], [14959, MODEL_SPEECH], [15053, userSays(' one', 15200, 15400)], [15059, MODEL_SILENCE], [15164, MODEL_SILENCE],
  [15258, userSays(' plus', 15400, 15600)], [15260, modelSays(' 2', 15400, 15600)], [15454, modelSays('.', 15600, 15800)],
  [15651, userSays(' one', 15800, 16000)], [15791, userSays(' is', 16000, 16200)], [16000, MODEL_SILENCE],
]
const CUT_IN_REPLY = [[17279, MODEL_SPEECH], [17360, MODEL_SPEECH]]

// Typed input recorded against the service, as [arrival ms, frame]: the user types during a pause in the
// story, which the stop instruction ends; the story's generated speech streams on for 2 s, a pause
// follows, then the reply, whose words arrived about a second ahead of its audio.
const every100 = (from, to, frame) => Array.from({ length: Math.round((to - from) / 100) + 1 }, (_, i) => [from + i * 100, frame])
const byArrival = steps => steps.sort((a, b) => a[0] - b[0])
const TYPED_CUT_STORY = [
  [13098, MODEL_SPEECH], [13191, modelSays('是', 13400, 13600)], [13198, MODEL_SPEECH], [13298, MODEL_SPEECH], [13391, modelSays('比', 13600, 13800)],
  [13398, MODEL_SILENCE], [13498, MODEL_SILENCE], [13596, modelSays('别', 13800, 14000)], [13598, MODEL_SILENCE], [13698, MODEL_SILENCE],
  [13776, modelSays('的小', 14000, 14200)], [13798, MODEL_SILENCE],
]
const TYPED_AT = 13798
const TYPED_CUT = byArrival([
  [13898, MODEL_SILENCE], [13998, MODEL_SILENCE], [14098, MODEL_SPEECH], [14143, modelSays('企鹅', 14400, 14600)], [14198, MODEL_SPEECH],
  [14298, MODEL_SPEECH], [14399, MODEL_SILENCE], ...every100(14498, 15998, MODEL_SPEECH),
  [15589, modelSays('等于', 15800, 16000)], [15779, modelSays('四', 16000, 16200)], [16186, modelSays('。', 16400, 16600)],
  ...every100(16098, 16798, MODEL_SILENCE),
])
const TYPED_CUT_REPLY = [[16898, MODEL_SPEECH], [16998, MODEL_SPEECH]]

test('GPT-Live 1 plays out the speech a story streams after a barge-in, then the reply as its own answer', () => {
  const live = liveAdapter()
  live.feed(userSays('Tell me a story', 1000, 2000))
  live.clock = 3000
  const storyId = openedId(live.feed(MODEL_SPEECH))
  live.feed(modelSays('Once upon a time', 3200, 4000))
  const play = steps => steps.flatMap(([at, raw]) => {
    live.clock = at
    return live.feed(raw)
  })
  assert.equal(types(play(CUT_IN_STORY)).filter(type => type === 'response.output_audio.delta').length, 3, 'the story plays')
  const cut = play(CUT_IN)
  assert.equal(cut.filter(event => event.type === 'response.output_audio.delta' && event.response_id === storyId).length, 16,
    "the story's speech after the barge-in plays out")
  assert.deepEqual(cut.find(event => event.type === 'response.done')?.response, { id: storyId, status: 'completed' })
  // The reply's words, after the model's pause, open it and end the question; its audio follows on it.
  const replyId = openedId(cut)
  assert.notEqual(replyId, storyId)
  assert.ok(types(cut).indexOf(TURN_ENDS[0]) > types(cut).indexOf('response.done'), "the story's speech leaves the question open")
  assert.equal(captionOf(cut), '2.')
  assert.deepEqual(play(CUT_IN_REPLY).map(event => [event.type, event.response_id]),
    [['response.output_audio.delta', replyId], ['response.output_audio.delta', replyId]])
})

test('GPT-Live 1 tells the model to stop on typed input, plays out what it already said, then the reply', () => {
  const live = liveAdapter()
  live.feed(userSays('讲个故事', 1000, 2000))
  live.clock = 3000
  const storyId = openedId(live.feed(MODEL_SPEECH))
  live.feed(modelSays('从前', 3200, 3600))
  const play = steps => steps.flatMap(([at, raw]) => {
    live.clock = at
    return live.feed(raw)
  })
  play(TYPED_CUT_STORY)
  // Typed while the story pauses: the model cannot hear it, so it is told to stop; the typed turn follows.
  live.clock = TYPED_AT
  assert.equal(live.interruptPlayback()?.type, 'session.instructions.append')
  live.encodeOutgoing({ type: 'response.create' })
  // Every frame after the cut plays, in order: the story's generated speech, then the reply's.
  const cut = play(TYPED_CUT)
  assert.equal(cut.filter(event => event.type === 'response.output_audio.delta').length, TYPED_CUT.filter(([, raw]) => raw.type === 'session.output_audio.delta').length)
  assert.deepEqual(cut.find(event => event.type === 'response.done')?.response, { id: storyId, status: 'completed' })
  // The reply's words, after a pause in the story's, close the story and open the reply.
  const replyId = openedId(cut)
  assert.notEqual(replyId, storyId)
  assert.equal(cut.filter(event => event.type === CAPTION && event.response_id === replyId).map(event => event.delta).join(''), '等于四。')
  assert.deepEqual(play(TYPED_CUT_REPLY).map(event => event.response_id), [replyId, replyId])
})

// A backchannel recorded against the service, as [arrival ms, frame]: the model carries on with its story
// through the user's "mm-hm", pausing at most 300 ms, its new words running on from the cut.
const BACKCHANNEL_STORY = [
  [14509, MODEL_SPEECH], [14525, modelSays('着一', 14600, 14800)], [14614, MODEL_SPEECH], [14710, MODEL_SPEECH],
  [14735, modelSays('只', 14800, 15000)], [14809, MODEL_SPEECH], [14909, MODEL_SPEECH],
]
const BACKCHANNEL_CUT = [
  [14933, userSays('嗯', 15000, 15200)], [14938, modelSays('名', 15000, 15200)], [15009, MODEL_SPEECH], [15109, MODEL_SPEECH],
  [15128, userSays('嗯', 15200, 15400)], [15129, modelSays('叫', 15200, 15400)], [15209, MODEL_SPEECH], [15309, MODEL_SPEECH],
]
const BACKCHANNEL_ON = [
  [15334, modelSays('阿', 15400, 15600)], [15409, MODEL_SPEECH], [15509, MODEL_SPEECH], [15524, modelSays('洛', 15600, 15800)],
  [15609, MODEL_SPEECH], [15709, MODEL_SILENCE], [15717, modelSays('的小', 15800, 16000)], [15809, MODEL_SILENCE],
  [15909, MODEL_SILENCE], [16009, MODEL_SPEECH], [16102, modelSays('企鹅', 16200, 16400)], [16109, MODEL_SPEECH],
]

test('GPT-Live 1 plays on through a backchannel as one answer, as the recorded model carries on', () => {
  const live = liveAdapter()
  live.feed(userSays('讲个故事', 1000, 2000))
  live.clock = 3000
  const storyId = openedId(live.feed(MODEL_SPEECH))
  live.feed(modelSays('从前', 2800, 3200))
  const play = steps => steps.flatMap(([at, raw]) => {
    live.clock = at
    return live.feed(raw)
  })
  play(BACKCHANNEL_STORY)
  const cut = play(BACKCHANNEL_CUT)
  assert.ok(has(cut, TURN_OPENS[0]), 'the backchannel opens a turn')
  // The story plays on, every frame, captioned as one answer, and leaves the user's turn open.
  const on = [...cut, ...play(BACKCHANNEL_ON)]
  assert.equal(on.filter(event => event.type === 'response.output_audio.delta' && event.response_id === storyId).length, 12)
  assert.ok(!has(on, 'response.done') && !has(on, 'response.created') && !has(on, TURN_ENDS[0]))
  assert.equal(captionOf(on), '名叫阿洛的小企鹅')
})

// An answer stopped explicitly: it plays out, then closes once the model has been quiet.
function stoppedAnswer() {
  const live = liveAdapter()
  const answerId = openedId(live.feed(MODEL_SPEECH))
  assert.equal(live.interruptPlayback({ stop: true })?.type, 'session.instructions.append')
  assert.deepEqual(live.feed(MODEL_SPEECH).map(event => event.response_id), [answerId], 'what the model already said plays out')
  assert.deepEqual(live.feed(OUTPUT_IDLE), [voiceDone(answerId)])
  return live
}

// A Gateway announcement: its item, then its response.create.
function gatewayAsks(live) {
  const injection = gptLive1Provider.buildResultInjection('任务完成：报告已生成')
  live.encodeOutgoing(live.conversationItemCreate(injection.item))
  live.encodeOutgoing(live.responseCreate(injection.response))
}

for (const [label, resume] of [
  ['the user speaks', live => live.feed({ type: 'session.input_transcript.delta', delta: '你好' })],
  ['the Gateway sends a request', gatewayAsks],
  ['the Gateway sends a commentary', live => live.encodeOutgoing(live.responseCreate({ __liveSay: '晚饭好了' }))],
]) {
  test(`GPT-Live 1 plays a stopped answer out, then stays silent until ${label}`, () => {
    const live = stoppedAnswer()
    // The model goes on after the stopped answer closed: none of it plays or is captioned.
    assert.deepEqual(live.play(MODEL_SPEECH, modelSays('接着说', 5000, 5200)), [])
    resume(live)
    // Then it plays: the speech under way as an interrupted answer, which ends no turn and
    // closes as the model's next words begin after a pause.
    const onward = live.feed(MODEL_SPEECH)
    assert.ok(has(onward, 'response.created') && !has(onward, TURN_ENDS[0]))
    const next = live.play(modelSays('还有', 5300, 5500), modelSays('好的', 6200, 6400))
    assert.deepEqual(types(next).filter(type => type.startsWith('response.')), [CAPTION, ...ANSWER_ENDS, 'response.created', CAPTION])
  })
}

test('GPT-Live 1 ends a stop when the user types, not on Gateway context, tool results or a request stopped again', () => {
  // Typed input interrupts as the user (no stop) and the reply plays; the model, talking on
  // unheard after a stop, is told to stop again.
  const typed = stoppedAnswer()
  typed.clock = 5000
  assert.equal(typed.interruptPlayback(), null)
  assert.ok(has(typed.feed(MODEL_SPEECH), 'response.created'))
  const unheard = stoppedAnswer()
  unheard.feed(MODEL_SPEECH)
  assert.equal(unheard.interruptPlayback()?.type, 'session.instructions.append')
  const live = stoppedAnswer()
  live.encodeOutgoing(live.conversationItemCreate(live.userTextItem('（权限请求已处理）')))
  live.encodeOutgoing(live.conversationItemCreate(live.functionOutputItem('call_1', { status: 'superseded' })))
  live.encodeOutgoing(live.responseCreate(undefined))
  live.clock = 5000
  assert.deepEqual(live.feed(MODEL_SPEECH), [])
  // Input before the stopped answer has played out ends the stop too: what follows plays.
  const early = liveAdapter()
  early.feed(MODEL_SPEECH)
  early.interruptPlayback({ stop: true })
  early.interruptPlayback()
  early.feed(OUTPUT_IDLE)
  assert.ok(has(early.feed(MODEL_SPEECH), 'response.created'))
  // A second stop after a Gateway request holds again once the answer has played out.
  const again = liveAdapter()
  again.feed(MODEL_SPEECH)
  again.interruptPlayback({ stop: true })
  gatewayAsks(again)
  again.interruptPlayback({ stop: true })
  again.feed(OUTPUT_IDLE)
  assert.deepEqual(again.feed(MODEL_SPEECH), [])
})

test("GPT-Live 1 ends a stop on the user's next words, yet keeps their turn open while a stopped answer carries on", () => {
  const live = liveAdapter()
  live.feed(userSays('你好', 0, 500))
  live.interruptPlayback({ stop: true })
  // The model answers anyway; that answer stays muted.
  live.clock = 2000
  assert.deepEqual(live.feed(MODEL_SPEECH), [])
  live.clock = 9000
  assert.ok(has(live.feed(userSays('在吗', 9000, 9500)), TURN_OPENS[0]))
  // The model had long been quiet: its answer shows from the first caption.
  assert.ok(has(live.feed(modelSays('在的', 11000, 11200)), 'response.created'))
  // Words close enough to join the same utterance, yet said after the stop, end it too.
  const joined = liveAdapter()
  joined.feed(userSays('帮我查', 0, 500))
  joined.interruptPlayback({ stop: true })
  assert.ok(!has(joined.feed(userSays('天气', 900, 1300)), TURN_OPENS[0]))
  assert.ok(has(joined.feed(MODEL_SPEECH), 'response.created'))
  // While stopped, the model's speech neither plays nor takes the turn: the user's words stay one turn.
  const talking = stoppedAnswer()
  assert.deepEqual(talking.feed(MODEL_SPEECH), [])
  assert.ok(has(talking.feed({ type: 'session.input_transcript.delta', delta: '等一下' }), TURN_OPENS[0]))
  assert.ok(!has(talking.feed({ type: 'session.input_transcript.delta', delta: '我想问' }), TURN_OPENS[0]))
})

test('GPT-Live 1 captions each answer from its own words, never with punctuation closing the last or words said after a stop', () => {
  // An answer's words open it ahead of its audio, and the next words continue it.
  const live = liveAdapter()
  const firstId = openedId(live.feed(modelSays('我来查一下', 1000, 1200)))
  assert.deepEqual(live.feed(MODEL_SPEECH).map(event => event.response_id), [firstId])
  assert.deepEqual(types(live.feed(OUTPUT_IDLE)), ANSWER_ENDS)
  // After it closed, punctuation alone opens nothing; the next words open the next answer at once.
  assert.deepEqual(live.feed(modelSays('。', 1200, 1400)), [])
  const next = live.feed(modelSays('。常见', 4800, 5000))
  assert.deepEqual(types(next), ['response.created', CAPTION])
  const nextId = openedId(next)
  assert.equal(captionOf(next), '常见')
  assert.deepEqual(live.feed(modelSays('，的说法', 5000, 5200)), [caption(nextId, '，的说法')], 'punctuation inside the answer stays')
  assert.equal(live.feed(OUTPUT_IDLE)[0].transcript, '常见，的说法')
  // A sound the service never transcribes closes without words; the words after it open a new answer.
  const wordless = liveAdapter()
  wordless.feed(MODEL_SPEECH)
  assert.deepEqual(types(wordless.feed(OUTPUT_IDLE)), ['response.done'])
  assert.deepEqual(types(wordless.feed(modelSays('二。', 1600, 1800))), ['response.created', CAPTION])
  // What a stopped answer says on after it closed shows nowhere, nor leads the next caption.
  const stopped = stoppedAnswer()
  assert.deepEqual(stopped.feed(modelSays('秦始皇', 1000, 1200)), [])
  gatewayAsks(stopped)
  assert.equal(captionOf(stopped.play(MODEL_SPEECH, modelSays('明天', 2000, 2200))), '明天')
})

test('GPT-Live 1 takes no late words of a final question for a turn, and shows a question that lands after its answer began', () => {
  const live = liveAdapter()
  const first = live.feed(userSays('查', 600, 800))
  assert.deepEqual(types(first), TURN_OPENS)
  // The answer begins as untimed audio, as on the primary WebSocket; its transcript dates it.
  assert.ok(has(live.feed(MODEL_SPEECH), 'response.created'))
  live.feed(modelSays('好', 1800, 2000))
  assert.deepEqual(types(live.feed(INPUT_IDLE)), [USER_DONE])
  // A late fragment of the question cuts nothing, and a final caption stays as it is.
  assert.deepEqual(live.feed(userSays('天气', 800, 1000)), [])
  assert.deepEqual(live.feed(INPUT_IDLE), [], 'not completed twice')
  // Speech that began after the answer is a barge-in: a new turn, and the answer closes once the model yields.
  // Later words captioned first do not move the answer's start.
  live.feed(modelSays('晴', 3800, 4000))
  const barge = live.feed(userSays('等', 3500, 3700))
  assert.deepEqual(types(barge), TURN_OPENS)
  assert.notEqual(barge[0].item_id, first[0].item_id)
  const yielded = live.play(MODEL_SILENCE, OUTPUT_IDLE)
  assert.deepEqual(types(yielded), ['response.output_audio.delta', ...ANSWER_ENDS])
  assert.equal(yielded.at(-1).response.status, 'completed')
  // Words after an answer began cut in even when the model spoke first: the answer plays on, its words on it.
  const early = liveAdapter()
  early.play(STARTED, userSays('天气', 1000, 1400), modelSays('晴。', 2000, 2400), OUTPUT_IDLE)
  const replyId = openedId(early.feed(modelSays('你好', 9600, 9800)))
  assert.ok(has(early.feed(userSays('你好', 10000, 10200)), TURN_OPENS[0]))
  assert.deepEqual(early.feed(modelSays('啊！', 9800, 10000)), [caption(replyId, '啊！')])
  // A question whose words all land after its answer began opens a turn the rest of that answer replies to: no barge-in.
  const opening = liveAdapter()
  opening.play(STARTED, MODEL_SPEECH, modelSays('好的', 2000, 2200))
  assert.deepEqual(types(opening.feed(userSays('几点了', 1000, 1400))), [...TURN_OPENS, ...TURN_ENDS, ...ANSWER_ENDS])
  assert.deepEqual(types(opening.feed(MODEL_SPEECH)), ANSWER_OPENS)
})

test('GPT-Live 1 plays an answer at once, even before its question\'s words arrive, and opens their turn after it', () => {
  const live = liveAdapter({ emit: () => {} })
  live.feed(STARTED)
  // The reply plays on arrival.
  const replyId = openedId(live.play(modelSays('不客气', 3600, 3800)))
  assert.deepEqual(live.feed(MODEL_SPEECH).map(event => event.response_id), [replyId])
  // Its question's words, spoken before it began, open a turn it answers: the answer so far closes, and
  // the runtime's cancel stops nothing.
  assert.deepEqual(types(live.feed(userSays('谢谢', 3000, 3400))), [...TURN_OPENS, ...TURN_ENDS, ...ANSWER_ENDS])
  assert.equal(live.interruptPlayback({ speech: true }), null)
  // The rest plays as that turn's reply, keeping its words across a pause in them.
  const rest = live.feed(modelSays('再见', 4600, 4800))
  assert.deepEqual(types(rest), ['response.created', CAPTION])
  assert.deepEqual(live.feed(modelSays('，明天见', 5600, 5800)), [caption(openedId(rest), '，明天见')])
  assert.deepEqual(types(live.play(MODEL_SPEECH, OUTPUT_IDLE)), ['response.output_audio.delta', ...ANSWER_ENDS])
  // An annotation alone opens no turn; the words after it do.
  const annotated = liveAdapter()
  annotated.feed(MODEL_SPEECH)
  assert.deepEqual(annotated.feed(userSays('[laugh', 100, 200)), [])
  assert.ok(has(annotated.feed(userSays('] 好', 200, 400)), TURN_OPENS[0]))
})

test('GPT-Live 1 tells its question from a barge-in over an answer whose words have not come, by their timing', () => {
  // Words begun before the answer's first words are its question: their turn ends there, and the reply follows it.
  const question = liveAdapter()
  question.play(STARTED, MODEL_SPEECH)
  assert.deepEqual(types(question.feed(userSays('几点了', 1000, 1400))), TURN_OPENS, 'undecided: the turn stays open')
  assert.deepEqual(types(question.feed(MODEL_SPEECH)), ['response.output_audio.delta'])
  const reply = question.feed(modelSays('好的', 2000, 2200))
  assert.deepEqual(types(reply), [...TURN_ENDS, 'response.done', 'response.created', CAPTION])
  assert.deepEqual(question.feed(modelSays('现在三点', 2900, 3300)), [caption(openedId(reply), '现在三点')])
  // Words the service did not time cannot tell: the answer replies to the utterance.
  const untimed = liveAdapter()
  untimed.play(STARTED, MODEL_SPEECH)
  untimed.feed(userSays('几点了', 1000, 1400))
  assert.deepEqual(types(untimed.feed({ type: 'session.output_transcript.delta', delta: '好的' })), [...TURN_ENDS, 'response.done', 'response.created', CAPTION])
  // A caption without words decides nothing: the words after it do.
  const symbol = liveAdapter()
  symbol.play(STARTED, MODEL_SPEECH)
  symbol.feed(userSays('几点了', 1000, 1400))
  symbol.feed(modelSays('- ', 1800, 1900))
  assert.ok(has(symbol.feed(modelSays('好的', 2000, 2200)), TURN_ENDS[0]))
  // A stop before they decide leaves the answer playing out whole: the question only ends its turn.
  const stopFirst = liveAdapter()
  stopFirst.play(STARTED)
  const stoppedId = openedId(stopFirst.feed(MODEL_SPEECH))
  stopFirst.feed(userSays('几点了', 1000, 1400))
  stopFirst.interruptPlayback({ stop: true })
  assert.deepEqual(types(stopFirst.feed(modelSays('好的', 2000, 2200))), [...TURN_ENDS, CAPTION])
  assert.deepEqual(stopFirst.feed(MODEL_SPEECH).map(event => event.response_id), [stoppedId])
  // Words begun after them cut in: the answer plays out, and none of it ends the new turn.
  const bargeIn = liveAdapter()
  bargeIn.play(STARTED, userSays('讲故事', 100, 500))
  const storyId = openedId(bargeIn.feed(MODEL_SPEECH))
  assert.deepEqual(types(bargeIn.feed(userSays('等等', 3000, 3200))), [USER_DONE, ...TURN_OPENS])
  assert.deepEqual(bargeIn.feed(modelSays('从前', 2000, 2400)), [caption(storyId, '从前')])
  assert.deepEqual(bargeIn.feed(MODEL_SPEECH).map(event => event.response_id), [storyId])
  assert.deepEqual(types(bargeIn.feed(modelSays('好', 4000, 4200))), [...ANSWER_ENDS, ...TURN_ENDS, 'response.created', CAPTION])
})

test('GPT-Live 1 plays a stopped answer out to the model\'s quiet, and keeps the stop through late words of a finished question', () => {
  // Words after a pause in a stopped answer still play with it, until the model is quiet.
  const out = liveAdapter()
  const outId = openedId(out.play(MODEL_SPEECH, modelSays('长城很长', 1000, 1200)))
  out.interruptPlayback({ stop: true })
  assert.deepEqual(out.feed(modelSays('好的', 2000, 2200)), [caption(outId, '好的')])
  assert.deepEqual(out.feed(MODEL_SPEECH).map(event => event.response_id), [outId])
  assert.deepEqual(types(out.feed(OUTPUT_IDLE)), ANSWER_ENDS)
  assert.deepEqual(out.feed(MODEL_SPEECH), [])
  // Speech under way may be audio alone: it still ends no turn once the stop is over.
  const humming = stoppedAnswer()
  humming.feed(MODEL_SPEECH)
  humming.feed(userSays('你好', 9000, 9300))
  assert.ok(!has(humming.feed(MODEL_SPEECH), TURN_ENDS[0]))
  // Once the model has been quiet, what it says after the stop ends is a new answer, which ends the turn.
  const quiet = stoppedAnswer()
  assert.deepEqual(quiet.feed(MODEL_SPEECH), [])
  quiet.feed(OUTPUT_IDLE)
  quiet.feed(userSays('你好', 9000, 9300))
  assert.ok(has(quiet.feed(MODEL_SPEECH), TURN_ENDS[0]))
  // After the user's words, the speech under way plays on without taking their turn; the reply after a pause ends it.
  const asked = stoppedAnswer()
  asked.feed(modelSays('接着说', 5000, 5200))
  assert.ok(has(asked.feed(userSays('嗯？', 5300, 5600)), TURN_OPENS[0]))
  assert.deepEqual(types(asked.feed(modelSays('的故事', 5250, 5450))), ['response.created', CAPTION])
  const reply = asked.play(modelSays('你想听什么', 6100, 6400), MODEL_SPEECH)
  assert.deepEqual(types(reply), [...ANSWER_ENDS, ...TURN_ENDS, 'response.created', CAPTION, 'response.output_audio.delta'])
  // Late words of a question already final do not end a stop.
  const late = liveAdapter()
  late.play(userSays('查天气', 0, 500), MODEL_SPEECH, modelSays('晴', 1000, 1200), INPUT_IDLE, OUTPUT_IDLE)
  late.interruptPlayback({ stop: true })
  assert.deepEqual(late.feed(userSays('吧', 400, 700)), [])
  assert.deepEqual(late.feed(MODEL_SPEECH), [])
})

test('GPT-Live 1 splits turns without transcript timing by arrival order and by timed answers', () => {
  const live = liveAdapter()
  live.feed(userSays('hi', 0, 200))
  // With no output timing, a pause before any answer continues the open utterance.
  const more = live.feed(userSays(' there', 2000, 2200))
  assert.deepEqual(types(more), [USER_DELTA])
  assert.equal(more[0].text, 'hi there')
  live.feed(INPUT_IDLE)
  // Once it is final, words after a pause are a turn of their own.
  const after = live.feed(userSays(' again', 4000, 4200))
  assert.deepEqual(types(after), TURN_OPENS)
  assert.equal(after[1].text, 'again')
  // Once an answer began, a later pause-separated fragment is a new turn.
  live.play(INPUT_IDLE, MODEL_SPEECH)
  assert.deepEqual(types(live.feed(userSays('wait', 7000, 7200))), TURN_OPENS)
  // Input without timestamps gets a fresh turn after each answer with a timestamp.
  const untimed = liveAdapter()
  const answer = startMs => untimed.play(MODEL_SPEECH, modelSays('好', startMs, startMs + 100), OUTPUT_IDLE)
  answer(1000)
  const first = untimed.feed({ type: 'session.input_transcript.delta', delta: '你好' })
  assert.equal(first[0].type, TURN_OPENS[0])
  untimed.feed(INPUT_IDLE)
  answer(5000)
  const second = untimed.feed({ type: 'session.input_transcript.delta', delta: '再见' })
  assert.equal(second[0].type, TURN_OPENS[0])
  assert.notEqual(second[0].item_id, first[0].item_id)
})

test('GPT-Live 1 gives a closing punctuation that arrives with the next utterance to the one it closes', () => {
  // An earlier answer closed, so later speech counts as fresh turns.
  const afterAnAnswer = () => {
    const live = liveAdapter()
    live.play(MODEL_SPEECH, modelSays('好', 0, 100), OUTPUT_IDLE)
    return live
  }
  const live = afterAnAnswer()
  const first = live.feed(userSays('帮我算一下', 2000, 2600))
  assert.deepEqual(types(first), TURN_OPENS)
  // The pause outlasts the idle window: the utterance completes without its period.
  assert.equal(live.feed(INPUT_IDLE).at(-1).transcript, '帮我算一下')
  // That period arrives with the next utterance, whose caption does not begin with it.
  const next = live.feed(userSays('。三乘七', 5000, 5200))
  assert.deepEqual(types(next), TURN_OPENS)
  assert.notEqual(next[0].item_id, first[0].item_id)
  assert.deepEqual([next[1].delta, next[1].text], ['三乘七', '三乘七'])
  assert.equal(live.feed(userSays('等于几', 5200, 5400))[0].text, '三乘七等于几')
  assert.equal(live.feed(INPUT_IDLE).at(-1).transcript, '三乘七等于几')
  // Any closing mark, in any width; opening marks start speech.
  assert.equal(live.feed(userSays('．」「对', 8000, 8200))[1].text, '「对')
  live.feed(INPUT_IDLE)
  // ASCII symbols that can begin speech are not closing marks.
  assert.equal(live.feed(userSays("'cause I said", 11000, 11400))[1].text, "'cause I said")
  // Speech resuming past a fragment gap but within the idle window closes the open utterance with its period.
  const open = afterAnAnswer()
  const itemId = open.feed(userSays('OK', 2000, 2400))[0].item_id
  const resumed = open.feed(userSays('。然后', 3800, 4000))
  assert.deepEqual(types(resumed), [...TURN_ENDS, USER_DONE, ...TURN_OPENS])
  assert.equal(resumed[2].item_id, itemId)
  assert.equal(resumed[2].transcript, 'OK。', 'the period closes the sentence it belongs to')
  assert.notEqual(resumed[3].item_id, itemId)
  assert.equal(resumed[4].text, '然后')
  // A long fragment's end, not its start, dates the pause before the next.
  assert.equal(open.play(userSays('我们去', 4000, 5600), userSays('吃饭', 5700, 5900)).at(-1).text, '然后我们去吃饭')
})

test('GPT-Live 1 starts no turn on non-speech annotations, nor interrupts the answer, but on words', () => {
  const live = liveAdapter()
  const answerId = openedId(live.feed(MODEL_SPEECH))
  live.feed(modelSays('好', 0, 100))
  // A throat clear is annotated with no words yet: no turn, no interruption.
  assert.deepEqual(live.feed(userSays('[clear throat', 600, 800)), [])
  assert.deepEqual(live.feed(MODEL_SPEECH), [{ type: 'response.output_audio.delta', response_id: answerId, delta: SPEECH }])
  assert.deepEqual(live.feed(MODEL_SILENCE).map(event => [event.type, event.response_id]), [['response.output_audio.delta', answerId]],
    'a pause inside the answer, not a yield')
  assert.deepEqual(live.feed(INPUT_IDLE), [], 'nothing to complete')
  // Words in the same run of speech open the turn; the caption keeps the fragments as received.
  const words = live.feed(userSays('] 你好', 1000, 1200))
  assert.deepEqual(types(words), TURN_OPENS)
  assert.deepEqual([words[1].delta, words[1].text], ['[clear throat] 你好', '[clear throat] 你好'])
  // Now the user cut in: the answer plays on until the model yields.
  const yielded = live.play(MODEL_SILENCE, OUTPUT_IDLE)
  assert.deepEqual(types(yielded), ['response.output_audio.delta', ...ANSWER_ENDS])
  assert.equal(yielded.at(-1).response.status, 'completed')
  assert.equal(live.feed(INPUT_IDLE).at(-1).transcript, '[clear throat] 你好')
  assert.deepEqual(live.play(userSays('[laughs]', 4000, 4200), INPUT_IDLE), [], 'an annotation alone is no utterance')
  // An unclosed bracket longer than an annotation is speech: the words open the turn.
  const unclosed = liveAdapter()
  assert.deepEqual(unclosed.feed(userSays('[clear throat', 600, 800)), [])
  const long = unclosed.feed(userSays(' 你好今天天气怎么样啊我想出门', 1000, 2000))
  assert.deepEqual(types(long), TURN_OPENS)
  assert.ok(long[1].text.endsWith('你好今天天气怎么样啊我想出门'))
})

// One exchange recorded against the service, sanitized, as [arrival ms, frame]: the user asks about
// the Great Wall, the answer starts as the question ends, and the user cuts in about the Forbidden City.
const RECORDED = {
  question: [[0, userSays('讲', 1400, 1600)], [180, userSays('讲', 1600, 1800)], [600, userSays('长', 2000, 2200)], [750, userSays('城', 2200, 2400)]],
  answer: [
    [750, modelSays('长城', 2200, 2400)], [810, MODEL_SILENCE], [910, MODEL_SPEECH],
    [960, modelSays('是', 2400, 2600)], [1130, modelSays('中国', 2600, 2800)],
  ],
  questionIdle: [[2250, INPUT_IDLE]],
  // Ten seconds into the answer.
  bargeIn: [[11380, userSays('讲', 14400, 14600)]],
  // The answer talks on for a moment, then falls silent.
  answerYields: [[11410, MODEL_SPEECH], [11510, MODEL_SILENCE]],
  // The next answer starts while the barge-in's words are still arriving.
  reply: [
    [11570, userSays('讲', 14600, 14800)], [11610, MODEL_SPEECH], [11780, userSays('故', 14800, 15000)],
    [11910, userSays('宫', 15000, 15200)], [12390, modelSays('故宫', 15400, 15600)],
  ],
  replyIdle: [[13410, INPUT_IDLE]],
}

// The Gateway's real input pipeline. Only the session collaborators are
// stand-ins, as in realtime-input-runtime.test.mjs.
function inputRuntime({ turns, announcementWindow = new AnnouncementWindow(), send = () => {}, getFrontend, expectResponseFor = () => {} }) {
  return new RealtimeInputRuntime({
    ownerId: 'owner-1', sessionId: 'session-1', turns, announcementWindow,
    transcripts: new TurnTranscripts(), inputAssets: new InputAssetRegistry(),
    conversationSync: { record() {} }, announcements: { dismissActive() {} },
    send, getFrontend, ensureFrontend: async () => {}, clearResponseCandidate() {}, expectResponseFor,
    shouldEnsurePermissionResponse: () => false, ensurePermissionResponseFor() {}, reportFrontendError() {},
  })
}

// The adapter in front of that pipeline.
function inputHarness() {
  const session = { clock: 0, sent: [], expected: [] }
  const protocol = createGptLive1Protocol({ now: () => session.clock })
  const turns = new RealtimeTurnState({ createVoiceTurnId: generation => `voice-${generation}` })
  const announcementWindow = new AnnouncementWindow()
  const runtime = inputRuntime({
    turns, announcementWindow, send: event => session.sent.push(event),
    getFrontend: () => ({ cancel() {}, capabilities: gptLive1Provider.capabilities }), expectResponseFor: context => session.expected.push(context.turnId),
  })
  return Object.assign(session, {
    turns,
    // Feeds [arrival ms, frame] steps through the adapter into the runtime and returns what the adapter emitted.
    play: (...steps) => steps.flatMap(([at, raw]) => {
      session.clock = at
      const events = [].concat(protocol.normalizeIncoming(raw) ?? [])
      for (const event of events) runtime.handleProviderEvent(event)
      return events
    }),
    // The speech half of the Gateway busy gate.
    speaking: () => [turns.userSpeaking, announcementWindow.userSpeaking],
    // What the Gateway sent since the last call, as [type, turnId, state | content | reason].
    drain: () => session.sent.splice(0).map(event => [
      event.type, event.turnId, event.state ?? event.content ?? event.reason,
    ].filter(value => value !== undefined)),
  })
}

const boundaries = events => events.filter(event => event.type.startsWith('input_audio_buffer.')).map(({ type, item_id }) => ({ type, item_id }))
const itemEvents = events => events.map(event => [event.type, event.item_id])
const deltas = (turnId, ...texts) => texts.map(text => ['transcript.delta', turnId, text])
const processing = turnId => ['voice.state', turnId, 'processing']

test('GPT-Live 1 ends a user turn as the answer starts and completes it on idle in the real input runtime', () => {
  const session = inputHarness()
  const [opened] = session.play(...RECORDED.question)
  assert.equal(opened.type, TURN_OPENS[0])
  assert.deepEqual(session.speaking(), [true, true])
  assert.deepEqual(session.drain(), [
    ['turn.started', 'voice-1'], ['voice.state', 'voice-1', 'listening'],
    ...deltas('voice-1', '讲', '讲讲', '讲讲长', '讲讲长城'),
  ])
  // The answer's first words, ahead of its audio, end the turn once, by the turn's own item.
  const [firstWords, ...restOfAnswer] = RECORDED.answer
  assert.deepEqual(boundaries(session.play(firstWords)), turnEnd(opened.item_id))
  assert.deepEqual(boundaries(session.play(...restOfAnswer)), [])
  assert.deepEqual(session.speaking(), [false, false], 'the speech gate is released')
  assert.deepEqual(session.expected, ['voice-1'])
  assert.deepEqual(session.drain(), [processing('voice-1'), processing('voice-1')])
  // Input going idle completes the turn with the caption as received.
  assert.deepEqual(itemEvents(session.play(...RECORDED.questionIdle)), [[USER_DONE, opened.item_id]])
  assert.deepEqual(session.drain(), [['transcript.final', 'voice-1', '讲讲长城']])
  assert.deepEqual(session.turns.committed(), { turnId: 'voice-1', turnGeneration: 1 })
  assert.deepEqual(session.speaking(), [false, false])
})

test('GPT-Live 1 late words of a final question in the real input runtime start no turn and end no newer one', () => {
  const session = inputHarness()
  const [opened] = session.play(...RECORDED.question, ...RECORDED.answer, ...RECORDED.questionIdle)
  session.drain()
  // Words continuing the question's timeline arrive after its final; the client keeps a final as it is.
  assert.deepEqual(session.play([2600, userSays('的历史', 2400, 2800)]), [])
  assert.deepEqual(session.drain(), [])
  assert.deepEqual(session.speaking(), [false, false], 'no turn starts')
  assert.equal(session.turns.turnId, 'voice-1')
  // Only the new turn's own boundary ends the new turn.
  const next = session.play([3700, userSays('换一个', 5000, 5400)])
  const item = next[0].item_id
  assert.notEqual(item, opened.item_id)
  assert.deepEqual(itemEvents(next), TURN_OPENS.map(type => [type, item]))
  session.play([3900, userSays('吧', 5400, 5600)])
  assert.deepEqual(session.speaking(), [true, true])
  assert.deepEqual(boundaries(session.play([5400, INPUT_IDLE])), turnEnd(item))
  assert.deepEqual(session.speaking(), [false, false])
  assert.deepEqual(session.drain().filter(([type]) => type === 'transcript.final'), [['transcript.final', 'voice-2', '换一个吧']])
})

test('GPT-Live 1 keeps a barge-in turn open in the real input runtime while the answer plays out', () => {
  const session = inputHarness()
  const setup = session.play(...RECORDED.question, ...RECORDED.answer, ...RECORDED.questionIdle)
  const answerId = openedId(setup)
  session.drain()
  // Words over the playing answer open a new turn on a new item; playback is not cleared.
  const [opened] = session.play(...RECORDED.bargeIn)
  assert.equal(opened.type, TURN_OPENS[0])
  assert.notEqual(opened.item_id, setup[0].item_id)
  assert.deepEqual(session.drain(), [
    ['turn.started', 'voice-2'], ['voice.state', 'voice-2', 'listening'], ...deltas('voice-2', '讲'),
  ])
  // Neither the answer's speech nor its pause ends the turn.
  const yielded = session.play(...RECORDED.answerYields)
  assert.deepEqual(boundaries(yielded), [])
  assert.deepEqual(yielded.map(event => [event.type, event.response_id]), [['response.output_audio.delta', answerId], ['response.output_audio.delta', answerId]])
  assert.deepEqual(session.drain(), [])
  assert.deepEqual(session.speaking(), [true, true])
  // Speech after its pause is still its own; the reply's words close it and end the turn by its item.
  const replied = session.play(...RECORDED.reply)
  assert.deepEqual(boundaries(replied), turnEnd(opened.item_id))
  assert.deepEqual(replied.find(event => event.type === 'response.done').response, { id: answerId, status: 'completed' })
  session.play(...RECORDED.replyIdle)
  assert.deepEqual(session.speaking(), [false, false])
  assert.deepEqual(session.expected, ['voice-1', 'voice-2'])
  assert.deepEqual(session.drain(), [
    ...deltas('voice-2', '讲讲', '讲讲故', '讲讲故宫'), processing('voice-2'), processing('voice-2'),
    ['transcript.final', 'voice-2', '讲讲故宫'],
  ])
  assert.deepEqual(session.turns.committed(), { turnId: 'voice-2', turnGeneration: 2 })
})

test('GPT-Live 1 plays an answer that comes before its question\'s words on through the real input runtime', t => {
  // The frontend's own adapter, whose events reach the input runtime as in a session.
  let frontend = null
  const runtime = inputRuntime({ turns: new RealtimeTurnState({ createVoiceTurnId: generation => `voice-${generation}` }), getFrontend: () => frontend })
  frontend = new RealtimeFrontend({ provider: gptLive1Provider, agentContext: {}, onEvent: event => runtime.handleProviderEvent(event) })
  t.after(() => frontend.close())
  const play = (...frames) => frames.flatMap(raw => frontend.handleProviderEvent(raw))
  assert.ok(has(play(modelSays('不客气', 3600, 3800), MODEL_SPEECH), 'response.created'))
  // Its question's late words open their turn; the runtime's cancel for it stops nothing, and the rest replies to it.
  assert.ok(has(play(userSays('谢谢', 3000, 3400)), TURN_OPENS[0]))
  assert.deepEqual(types(play(MODEL_SPEECH)), ANSWER_OPENS)
})

test('GPT-Live 1 tells the voice layer what was typed, so it waits for the backend answer and speaks it once', () => {
  const frontend = new RealtimeFrontend({ provider: gptLive1Provider, agentContext: {}, onEvent: () => {} })
  const typed = frontend.projectUserInput([{ type: 'text', text: 'What is two plus two?' }], { contextOnly: false })
  assert.deepEqual(typed.beforeEvents, [{ type: 'session.thinking.append', delegation_id: null, content: "The user typed this message. The backend is answering it: wait for that answer, then speak it in the message's language. Message: What is two plus two?" }])
  assert.deepEqual(typed.conversationItem, { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'What is two plus two?' }] })
  // A Gateway context note goes to the backend only.
  assert.equal(frontend.projectUserInput([{ type: 'text', text: '（权限请求已处理）' }]).beforeEvents, undefined)
  frontend.close()
})
