import assert from 'node:assert/strict'
import test from 'node:test'
import { WebSocketServer } from 'ws'
import { config } from '../src/core/config.mjs'
import { RealtimeFrontend } from '../src/voice/realtime-provider.mjs'
import { gptLive1Provider, sessionInputHistory } from '../src/voice/providers/gpt-live-1.mjs'
import { ToolCallHandler } from '../src/frontend/tools/tool-call-handler.mjs'
import {
  permissionResponseInstructions,
  progressResponseInstructions,
  resultResponseInstructions,
} from '../src/frontend/frontend-tools.mjs'
import {
  createGptLive1Protocol,
  clampCommentary,
  estimateTokens,
  fitBackendItem,
  utf8Bytes,
} from '../src/voice/providers/gpt-live-1-protocol.mjs'
import {
  defaultRealtimeProviderRegistry,
  describeActiveRealtime,
} from '../src/voice/providers/registry.mjs'
import { resolveRealtimeModelProfile } from '../../shared/realtime-model-catalog.mjs'
import { assertRealtimeFrontendModel } from '../../shared/realtime-provider-catalog.mjs'
import { gatewaySetupStatus } from '../../shared/gateway/setup.mjs'

// One 100 ms frame of 24 kHz PCM16 at a steady level well above the speech
// threshold, and the digital silence the Live API streams between answers.
const SPEECH = Buffer.alloc(4800, 0x20).toString('base64')
const SILENCE = Buffer.alloc(4800).toString('base64')

function withConfig(t, patch) {
  const previous = Object.fromEntries(
    Object.keys(patch).map(key => [key, config[key]]),
  )
  Object.assign(config, patch)
  t.after(() => Object.assign(config, previous))
}

function withEnv(t, patch) {
  const previous = Object.fromEntries(
    Object.keys(patch).map(key => [key, process.env[key]]),
  )
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
}

const SESSION_START_FIELDS = new Set(['model', 'instructions', 'input', 'audio', 'delegation'])

test('GPT-Live 1 registers under its key and aliases with function calling', () => {
  for (const name of ['gpt-live-1', 'gptlive1', 'openai-live', 'GPT-Live-1']) {
    // The Realtime provider keeps its own aliases; none may resolve here.
    assert.notEqual(defaultRealtimeProviderRegistry.resolve('gpt-realtime').key, 'gpt-live-1')
    assert.equal(defaultRealtimeProviderRegistry.resolve(name).key, 'gpt-live-1')
  }
  const active = describeActiveRealtime('gpt-live-1')
  assert.equal(active.model, config.gptLive1Model)
  assert.equal(active.modelCapabilities.functionCalling, true)
  assert.equal(active.modelCapabilities.audioInput, true)
  assert.equal(active.modelCapabilities.audioOutput, true)
  assert.equal(active.inputSampleRate, 24000)
  assert.deepEqual(active.modelCatalog.map(profile => profile.id), ['gpt-live-1'])
})

test('GPT-Live 1 defaults to the OpenAI Live API with a plain OpenAI key', t => {
  withConfig(t, {
    gptLive1ApiKey: 'openai-test',
    gptLive1RealtimeUrl: 'wss://api.openai.com/v1/live/sessions',
    gptLive1Model: 'gpt-live-1',
    gptLive1Voice: '',
  })
  assert.equal(gptLive1Provider.isConfigured(), true)
  // The model travels inside session.start, never as a URL query parameter.
  assert.equal(gptLive1Provider.url(), 'wss://api.openai.com/v1/live/sessions')
  assert.deepEqual(gptLive1Provider.headers(), { Authorization: 'Bearer openai-test' })
  assert.equal(gptLive1Provider.voice(), null)
})

test('an API gateway or Azure endpoint is only a different URL and key', t => {
  withConfig(t, {
    gptLive1ApiKey: 'gateway-service-key',
    gptLive1RealtimeUrl: 'wss://gateway.example/openai/v1/live/sessions',
    gptLive1Model: 'live-deployment-a',
  })
  assert.equal(
    gptLive1Provider.url(),
    'wss://gateway.example/openai/v1/live/sessions',
  )
  assert.deepEqual(gptLive1Provider.headers(), { Authorization: 'Bearer gateway-service-key' })
  const session = gptLive1Provider.buildSession({ agentContext: {}, sessionOptions: {} })
  // The Azure deployment name is the model the session starts with.
  assert.equal(session.model, 'live-deployment-a')
})

test('GPT-Live 1 builds a strict session.start payload with Responses delegation', t => {
  withConfig(t, { gptLive1ApiKey: 'k', gptLive1Model: 'gpt-live-1', gptLive1Voice: '' })
  withEnv(t, {
    GPT_LIVE_1_DELEGATION_MODEL: 'gpt-6-sol',
    GPT_LIVE_1_DELEGATION_INSTRUCTIONS: undefined,
  })
  const session = gptLive1Provider.buildSession({ agentContext: {}, sessionOptions: {} })
  // The Live API rejects unknown fields at startup.
  for (const key of Object.keys(session)) assert.ok(SESSION_START_FIELDS.has(key), key)
  assert.equal(session.model, 'gpt-live-1')
  assert.ok(session.instructions.length > 0)
  assert.equal(session.audio, undefined)
  assert.equal(session.delegation.type, 'responses')
  assert.equal(session.delegation.responses.model, 'gpt-6-sol')
  assert.equal(session.delegation.responses.tool_choice, 'auto')
  assert.ok(session.delegation.responses.tools.length > 0)
  assert.ok(session.delegation.responses.tools.every(tool => (
    tool.type === 'function' && tool.name && tool.parameters
  )))

  const voiced = gptLive1Provider.buildSession({ agentContext: {}, sessionOptions: { voice: 'marin' } })
  assert.deepEqual(voiced.audio, { output: { voice: 'marin' } })

  // The voice prompt follows the prompting guide's policy sections and lists
  // backend capabilities; the backend prompt carries the full frontend rules.
  for (const heading of ['Backchannel policy:', 'Interruption policy:', 'Delegation policy:', 'Backend tools:']) {
    assert.ok(session.instructions.includes(heading), heading)
  }
  assert.ok(session.instructions.includes('answers a question the backend asked'))
  assert.ok(session.delegation.responses.instructions.includes('## Task instructions'))
  assert.equal(session.input, undefined, 'no history means no input field')

  // Prior conversation seeds session.input in the documented message shape.
  const seeded = gptLive1Provider.buildSession({
    agentContext: { recentMessages: [
      { role: 'user', content: '帮我记一下明天开会' },
      { role: 'assistant', content: '好的，已记下。' },
      { role: 'system', content: 'ignored' },
    ] },
    sessionOptions: {},
  })
  assert.deepEqual(seeded.input, [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: '帮我记一下明天开会' }] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '好的，已记下。' }] },
  ])
  const many = sessionInputHistory(Array.from({ length: 200 }, (_, i) => ({ role: 'user', content: `m${i}` })))
  assert.equal(many.length, 64)
  assert.equal(many.at(-1).content[0].text, 'm199')
})

test('GPT-Live 1 speaks short announcements through commentary appends', () => {
  const protocol = createGptLive1Protocol()
  assert.deepEqual(gptLive1Provider.buildSpeakResponse('晚饭好了'), { __liveSay: '晚饭好了' })
  assert.deepEqual(protocol.responseCreate(gptLive1Provider.buildSpeakResponse('晚饭好了')), {
    type: 'session.commentary.append',
    delegation_id: null,
    content: '晚饭好了',
  })
  // Appends are capped at 500 tokens; a runaway announcement is clamped, not
  // rejected, and the estimate treats a CJK character as a whole token.
  const long = protocol.responseCreate({ __liveSay: 'x'.repeat(5000) })
  assert.ok(long.content.endsWith('…'))
  assert.ok(estimateTokens(long.content) <= 480, String(estimateTokens(long.content)))
  const cjk = clampCommentary('天'.repeat(1000))
  assert.ok(cjk.endsWith('…'))
  assert.ok([...cjk].length <= 481, String([...cjk].length))
  assert.equal(clampCommentary('晚饭好了'), '晚饭好了')
  // A spoken payload never turns into a backend instruction item.
  assert.equal(protocol.responseInstructionsItem({ __liveSay: '晚饭好了', instructions: 'ignored' }), null)
  // Without spoken content a response request continues the delegated backend.
  assert.deepEqual(protocol.responseCreate(undefined), { type: 'response.create' })
  assert.deepEqual(protocol.responseCreate({ modalities: ['audio'] }), { type: 'response.create' })
})

test('GPT-Live 1 routes task results and permissions through the delegated backend', () => {
  const protocol = createGptLive1Protocol()
  const injection = gptLive1Provider.buildResultInjection('任务完成：报告已生成')
  assert.deepEqual(protocol.conversationItemCreate(injection.item), {
    type: 'response.item.create',
    item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '任务完成：报告已生成' }] },
  })
  // The fixed guidance for injected items is part of the backend prompt, so
  // no instruction item accompanies the injection: one item per injection.
  assert.equal(protocol.responseInstructionsItem(injection.response), null)
  assert.deepEqual(protocol.responseCreate(injection.response), { type: 'response.create' })

  const permission = gptLive1Provider.buildPermissionInjection({
    id: 'perm_1', taskId: 'task_1', summary: '删除文件',
  })
  const permissionItem = protocol.conversationItemCreate(permission.item)
  assert.equal(permissionItem.type, 'response.item.create')
  assert.match(permissionItem.item.content[0].text, /permission_id=perm_1/)
  assert.equal(protocol.responseInstructionsItem(permission.response), null)
  assert.equal(protocol.responseInstructionsItem(undefined), null)
})

test('GPT-Live 1 protocol encodes the documented client events', () => {
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
  assert.deepEqual(protocol.inputMute(), { type: 'session.input_audio.mute' })
  assert.deepEqual(protocol.inputUnmute(), { type: 'session.input_audio.unmute' })
  assert.deepEqual(protocol.sessionClose('client_closed'), { type: 'session.close' })
  assert.equal(protocol.responseCancel(), null)
  assert.equal(protocol.imageAppend('img'), null)
})

test('GPT-Live 1 protocol returns tool results to the delegated backend', () => {
  const protocol = createGptLive1Protocol()
  assert.deepEqual(protocol.conversationItemCreate(
    protocol.functionOutputItem('call_1', { ok: true }),
  ), {
    type: 'response.item.create',
    item: { type: 'function_call_output', call_id: 'call_1', output: '{"ok":true}' },
  })
  assert.deepEqual(protocol.conversationItemCreate(protocol.userTextItem('记住我喝美式')), {
    type: 'response.item.create',
    item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '记住我喝美式' }] },
  })
  assert.equal(protocol.conversationItemCreate(protocol.userTextItem('   ')), null)
})

test('GPT-Live 1 protocol brackets spoken output into responses by timeline gaps', () => {
  const protocol = createGptLive1Protocol()
  assert.deepEqual(
    protocol.normalizeIncoming({ type: 'session.started', session: { id: 'sess_1' } }),
    { type: 'session.created', session: { id: 'sess_1' } },
  )
  const first = protocol.normalizeIncoming({
    type: 'session.output_audio.delta', delta: SPEECH, start_ms: 0, end_ms: 100,
  })
  assert.deepEqual(first.map(event => event.type), ['response.created', 'response.output_audio.delta'])
  const responseId = first[0].response.id
  assert.equal(first[1].response_id, responseId)
  assert.equal(first[1].delta, SPEECH)

  const contiguous = protocol.normalizeIncoming({
    type: 'session.output_audio.delta', delta: SPEECH, start_ms: 100, end_ms: 200,
  })
  assert.deepEqual(contiguous.map(event => event.type), ['response.output_audio.delta'])
  assert.equal(contiguous[0].response_id, responseId)

  const transcript = protocol.normalizeIncoming({
    type: 'session.output_transcript.delta', delta: '你好', start_ms: 0, end_ms: 200,
  })
  assert.deepEqual(transcript, [{
    type: 'response.output_audio_transcript.delta', response_id: responseId, delta: '你好',
  }])

  // Omitted silence longer than the segment gap starts a new spoken response.
  const later = protocol.normalizeIncoming({
    type: 'session.output_audio.delta', delta: SPEECH, start_ms: 5000, end_ms: 5100,
  })
  assert.deepEqual(later.map(event => event.type), [
    'response.output_audio_transcript.done', 'response.done', 'response.created', 'response.output_audio.delta',
  ])
  assert.deepEqual(later[0], { type: 'response.output_audio_transcript.done', response_id: responseId, transcript: '你好' },
    'the runtime records the assistant turn from the completed transcript')
  assert.equal(later[1].response.id, responseId)
  assert.equal(later[1].response.status, 'completed')
  assert.notEqual(later[2].response.id, responseId)
  assert.equal(later[3].response_id, later[2].response.id)
})

test('GPT-Live 1 protocol synthesises the user turn from timed transcript fragments', () => {
  const protocol = createGptLive1Protocol()
  protocol.normalizeIncoming({
    type: 'session.output_audio.delta', delta: SPEECH, start_ms: 0, end_ms: 100,
  })
  // Fresh user speech is a barge-in. The runtime mutes the answer; it closes
  // here once the model yields (its first silence frame below).
  const started = protocol.normalizeIncoming({
    type: 'session.input_transcript.delta', delta: '明天', start_ms: 600, end_ms: 800,
  })
  assert.deepEqual(started.map(event => event.type), [
    'input_audio_buffer.speech_started',
    'conversation.item.input_audio_transcription.delta',
  ])
  const itemId = started[0].item_id
  assert.equal(started[1].item_id, itemId)
  assert.equal(started[1].text, '明天')
  const yielded = protocol.normalizeIncoming({ type: 'session.output_audio.delta', delta: SILENCE })
  assert.deepEqual(yielded.map(event => [event.type, event.response.status]), [['response.done', 'cancelled']])

  // The delegation means the service took the turn: it commits here, so the
  // backend response that follows carries this turn. Fragments keep flowing
  // into the committed item.
  const delegated = protocol.normalizeIncoming({
    type: 'session.delegation.created',
    delegation: { id: 'item_d1', type: 'delegation', target: 'responses' },
  })
  assert.deepEqual(delegated.map(event => event.type), ['input_audio_buffer.speech_stopped', 'input_audio_buffer.committed'])
  assert.equal(delegated[0].item_id, itemId)
  const more = protocol.normalizeIncoming({
    type: 'session.input_transcript.delta', delta: '天气', start_ms: 800, end_ms: 1200,
  })
  assert.deepEqual(more.map(event => event.type), ['conversation.item.input_audio_transcription.delta'])
  assert.equal(more[0].item_id, itemId)
  assert.equal(more[0].delta, '天气')
  assert.equal(more[0].text, '明天天气', 'text carries the caption so far, not the bare fragment')

  // The assistant starts answering; a late fragment continuing the timeline
  // still belongs to the same utterance and must not cut the answer off.
  const answer = protocol.normalizeIncoming({
    type: 'session.output_audio.delta', delta: SPEECH, start_ms: 2000, end_ms: 2100,
  })
  // The turn was already committed by the delegation, so only the answer opens.
  assert.deepEqual(answer.map(event => event.type), [
    'response.created',
    'response.output_audio.delta',
  ])
  const answerId = answer.find(event => event.type === 'response.created').response.id
  const late = protocol.normalizeIncoming({
    type: 'session.input_transcript.delta', delta: '怎么样', start_ms: 1200, end_ms: 1500,
  })
  assert.deepEqual(late.map(event => event.type), ['conversation.item.input_audio_transcription.delta'])
  assert.equal(late[0].item_id, itemId)

  // The utterance ends (idle) while the answer plays on: already committed,
  // so only the transcript completes.
  const idle = protocol.normalizeIncoming({ type: 'gpt-live-1.input_idle' })
  assert.deepEqual(idle.map(event => event.type), [
    'conversation.item.input_audio_transcription.completed',
  ])
  assert.equal(idle[0].transcript, '明天天气怎么样')

  // A lagging fragment of speech that happened BEFORE the answer began (its
  // start precedes the answer's first output) is not an interruption: it
  // reopens the question so the caption grows, and starts no turn, because
  // the runtime clears playback on every speech_started.
  const lagging = protocol.normalizeIncoming({
    type: 'session.input_transcript.delta', delta: '还有', start_ms: 1700, end_ms: 1900,
  })
  assert.deepEqual(lagging.map(event => event.type), [
    'conversation.item.input_audio_transcription.delta',
  ], 'speech from before the answer started must not cancel it')
  assert.equal(lagging[0].item_id, itemId)
  assert.equal(lagging[0].text, '明天天气怎么样还有')
  assert.deepEqual(protocol.normalizeIncoming({ type: 'gpt-live-1.input_idle' }), [], 'not completed twice')

  // Speech that starts AFTER the answer began is a barge-in: the runtime mutes
  // the answer, and it closes as cancelled once the model yields.
  const next = protocol.normalizeIncoming({
    type: 'session.input_transcript.delta', delta: '谢谢', start_ms: 4000, end_ms: 4200,
  })
  assert.deepEqual(next.map(event => event.type), [
    'input_audio_buffer.speech_started',
    'conversation.item.input_audio_transcription.delta',
  ])
  assert.notEqual(next[0].item_id, itemId)
  const cut = protocol.normalizeIncoming({ type: 'session.output_audio.delta', delta: SILENCE })
  assert.equal(cut[0].response.id, answerId)
  assert.equal(cut[0].response.status, 'cancelled', 'a barge-in interrupts the playback record')
})

test('GPT-Live 1 protocol completes the user utterance once input goes idle', async () => {
  const emitted = []
  const protocol = createGptLive1Protocol({ emit: event => emitted.push(event), inputIdleMs: 20, outputIdleMs: 0 })
  const started = protocol.normalizeIncoming({
    type: 'session.input_transcript.delta', delta: '你好', start_ms: 100, end_ms: 300,
  })
  const itemId = started.find(event => event.type === 'input_audio_buffer.speech_started').item_id
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.equal(emitted.length, 1)
  const completed = protocol.normalizeIncoming(emitted[0])
  assert.deepEqual(completed.map(event => event.type), [
    'input_audio_buffer.speech_stopped',
    'input_audio_buffer.committed',
    'conversation.item.input_audio_transcription.completed',
  ])
  assert.equal(completed[2].item_id, itemId)
  assert.equal(completed[2].transcript, '你好')
  // The answer begins; a late fragment from before it continues the question.
  const speaking = protocol.normalizeIncoming({
    type: 'session.output_audio.delta', delta: SPEECH, start_ms: 500, end_ms: 600,
  })
  assert.equal(speaking[0].type, 'response.created')
  const tail = protocol.normalizeIncoming({
    type: 'session.input_transcript.delta', delta: '啊', start_ms: 300, end_ms: 400,
  })
  assert.deepEqual(tail.map(event => event.type), ['conversation.item.input_audio_transcription.delta'])
  assert.equal(tail[0].item_id, itemId)
  assert.equal(tail[0].text, '你好啊')
  // Speech after the answer began is a new turn.
  const fresh = protocol.normalizeIncoming({
    type: 'session.input_transcript.delta', delta: '等等', start_ms: 2500, end_ms: 2700,
  })
  assert.deepEqual(fresh.map(event => event.type), [
    'input_audio_buffer.speech_started',
    'conversation.item.input_audio_transcription.delta',
  ])
  assert.notEqual(fresh[0].item_id, itemId)
})

test('GPT-Live 1 protocol unwraps the delegated Responses function-call loop', () => {
  const protocol = createGptLive1Protocol()
  const created = protocol.normalizeIncoming({
    type: 'response.event', delegation_id: 'item_d1',
    event: { type: 'response.created', response: { id: 'resp_1' } },
  })
  assert.deepEqual(created, [{
    type: 'response.created', response: { id: 'resp_1', status: 'in_progress' }, response_id: 'resp_1',
  }])

  assert.deepEqual(protocol.normalizeIncoming({
    type: 'response.event', delegation_id: 'item_d1',
    event: { type: 'response.output_text.delta', delta: 'The forecast is' },
  }), [])

  const call = protocol.normalizeIncoming({
    type: 'response.event', delegation_id: 'item_d1',
    event: {
      type: 'response.output_item.done',
      response: { id: 'resp_1' },
      item: { type: 'function_call', call_id: 'call_1', name: 'spawn_thinking', arguments: '{"task":"查天气"}' },
    },
  })
  assert.deepEqual(call, [{
    type: 'response.function_call_arguments.done',
    response_id: 'resp_1',
    call_id: 'call_1',
    name: 'spawn_thinking',
    arguments: '{"task":"查天气"}',
  }])

  const direct = protocol.normalizeIncoming({
    type: 'response.event', delegation_id: 'item_d1',
    event: { type: 'response.function_call_arguments.done', call_id: 'call_2', name: 'get_current_time', arguments: '{}' },
  })
  assert.equal(direct[0].call_id, 'call_2')
  // Nested events without a response object inherit the response id that
  // response.created bound to this delegation, so the tool batch and the
  // later response.done share one id.
  assert.equal(direct[0].response_id, 'resp_1')

  // The Responses stream also emits an arguments-done twin with no call_id
  // alongside output_item.done; it must be dropped, not raised as a bad call.
  assert.deepEqual(protocol.normalizeIncoming({
    type: 'response.event', delegation_id: 'item_d1',
    event: { type: 'response.function_call_arguments.done', arguments: '{"q":"x"}' },
  }), [])

  const done = protocol.normalizeIncoming({
    type: 'response.event', delegation_id: 'item_d1',
    event: { type: 'response.completed', response: { id: 'resp_1', status: 'completed' } },
  })
  assert.deepEqual(done, [{
    type: 'response.done', response: { id: 'resp_1', status: 'completed' }, response_id: 'resp_1',
  }])

  const failed = protocol.normalizeIncoming({
    type: 'response.event', delegation_id: 'item_d1',
    event: { type: 'response.failed', response: { id: 'resp_2', error: { message: 'quota' } } },
  })
  assert.equal(failed[0].type, 'error')
  assert.equal(failed[0].error.message, 'quota')
})

test('GPT-Live 1 protocol passes errors through and closes cleanly', () => {
  const protocol = createGptLive1Protocol()
  assert.deepEqual(protocol.normalizeIncoming({
    type: 'error', error: { type: 'invalid_request_error', code: 'invalid_audio', message: 'odd bytes' },
  }), { type: 'error', error: { type: 'invalid_request_error', code: 'invalid_audio', message: 'odd bytes' } })
  for (const type of [
    'session.updated', 'session.usage.updated', 'session.commentary.appended',
    'session.thinking.appended', 'session.instructions.appended',
    'session.input_audio.muted', 'session.input_audio.unmuted',
  ]) {
    assert.deepEqual(protocol.normalizeIncoming({ type }), [], type)
  }
  protocol.normalizeIncoming({ type: 'session.input_transcript.delta', delta: '嗨', start_ms: 0, end_ms: 100 })
  const spoken = protocol.normalizeIncoming({ type: 'session.output_audio.delta', delta: SPEECH, start_ms: 300, end_ms: 400 })
  assert.deepEqual(spoken.map(event => event.type).slice(0, 2), ['input_audio_buffer.speech_stopped', 'input_audio_buffer.committed'])
  const closed = protocol.normalizeIncoming({ type: 'session.closed', reason: 'close_requested', usage: { seconds: 3 } })
  assert.deepEqual(closed.map(event => event.type), [
    'conversation.item.input_audio_transcription.completed',
    'response.done',
  ])
  assert.equal(gptLive1Provider.classifyError('Unexpected server response: 401'), 'fatal')
  assert.equal(gptLive1Provider.classifyError('immutable_field_update: instructions'), 'other')
  assert.equal(gptLive1Provider.classifyError('content_filter triggered'), 'content_safety')
})

test('GPT-Live 1 protocol closes a spoken segment once output goes idle', async () => {
  const emitted = []
  const protocol = createGptLive1Protocol({ emit: event => emitted.push(event), outputIdleMs: 20 })
  const opened = protocol.normalizeIncoming({
    type: 'session.output_audio.delta', delta: SPEECH, start_ms: 0, end_ms: 100,
  })
  const responseId = opened[0].response.id
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.deepEqual(emitted, [{ type: 'gpt-live-1.output_idle' }])
  assert.deepEqual(protocol.normalizeIncoming(emitted[0]), [{
    type: 'response.done', response: { id: responseId, status: 'completed' }, response_id: responseId,
    __voicePlayback: true,
  }])
  // Idle after the segment already closed is a no-op.
  assert.deepEqual(protocol.normalizeIncoming({ type: 'gpt-live-1.output_idle' }), [])
})

test('connects to a GPT-Live 1 mock service with session.start and no session.update', { timeout: 10000 }, async t => {
  withConfig(t, {
    gptLive1ApiKey: 'live-test',
    gptLive1Model: 'gpt-live-1',
    gptLive1Voice: 'marin',
  })
  withEnv(t, { GPT_LIVE_1_DELEGATION_MODEL: 'gpt-6-luna', GPT_LIVE_1_OUTPUT_IDLE_MS: '40' })
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise(resolve => server.once('listening', resolve))
  const received = []
  const events = []
  let authorization = ''

  server.once('connection', (socket, request) => {
    authorization = request.headers.authorization
    socket.on('message', raw => {
      const message = JSON.parse(raw.toString())
      received.push(message)
      if (message.type === 'session.start') {
        socket.send(JSON.stringify({
          type: 'session.started',
          session: { id: 'sess_1', model: message.session.model },
        }))
        socket.send(JSON.stringify({
          type: 'session.output_audio.delta', delta: SPEECH, start_ms: 0, end_ms: 100,
        }))
      } else if (message.type === 'session.commentary.append') {
        socket.send(JSON.stringify({
          type: 'session.commentary.appended', client_event_id: message.event_id,
        }))
        socket.send(JSON.stringify({
          type: 'session.output_audio.delta', delta: SPEECH, start_ms: 4000, end_ms: 4100,
        }))
      }
    })
  })
  const address = server.address()
  withConfig(t, {
    gptLive1RealtimeUrl: `ws://127.0.0.1:${address.port}/v1/live/sessions`,
  })
  const frontend = new RealtimeFrontend({
    provider: gptLive1Provider,
    agentContext: {},
    onEvent: event => events.push(event),
    responseStartTimeoutMs: 2000,
  })
  t.after(async () => {
    frontend.close()
    await new Promise(resolve => server.close(resolve))
  })

  await frontend.connect()
  assert.equal(frontend.ready, true)
  assert.equal(authorization, 'Bearer live-test')
  assert.equal(received[0].type, 'session.start')
  assert.match(received[0].event_id, /^event_/)
  assert.equal(received[0].session.model, 'gpt-live-1')
  assert.equal(received[0].session.delegation.type, 'responses')
  assert.deepEqual(received[0].session.audio, { output: { voice: 'marin' } })
  // Startup configuration is immutable: nothing else is sent before speech.
  assert.equal(received.filter(message => message.type === 'session.update').length, 0)
  assert.ok(events.some(event => event.type === 'response.output_audio.delta'))

  // The first spoken segment must close by itself (idle timer) or this speak
  // request would wait behind it forever: the Live API sends no turn end.
  const outcome = await frontend.speak('晚饭好了', 'announcement')
  const commentary = received.find(message => message.type === 'session.commentary.append')
  assert.equal(commentary?.content, '晚饭好了')
  assert.equal(commentary?.delegation_id, null)
  assert.equal(outcome.completed, true)
  const created = events.filter(event => event.type === 'response.created')
  const done = events.filter(event => event.type === 'response.done')
  // The announcement settles on the commentary acknowledgement as a playback
  // response of its own; the voice segment that speaks it is the model's.
  const announcement = created.find(event => event.__voiceOrigin === 'announcement')
  assert.ok(announcement, 'the speak request bound to the acknowledged commentary')
  assert.equal(announcement.__voicePlayback, true)
  assert.ok(done.some(event => event.response.id === announcement.response.id))
})

test('GPT-Live 1 lists the active deployment name in its model catalog', t => {
  withConfig(t, { gptLive1Model: 'live-deployment-a' })
  const ids = gptLive1Provider.modelCatalog().map(profile => profile.id)
  assert.deepEqual(ids, ['gpt-live-1', 'live-deployment-a'])
  assert.equal(gptLive1Provider.modelCatalog().at(-1).family, 'gpt-live-1')
  withConfig(t, { gptLive1Model: 'gpt-live-1' })
  assert.deepEqual(gptLive1Provider.modelCatalog().map(profile => profile.id), ['gpt-live-1'])
})

test('GPT-Live 1 accepts an Azure deployment name with the default profile', () => {
  const profile = resolveRealtimeModelProfile('live-deployment-a', 'gpt-live-1')
  assert.equal(profile.id, 'live-deployment-a')
  assert.equal(profile.family, 'gpt-live-1')
  assert.equal(profile.modelCapabilities.functionCalling, true)
  assert.doesNotThrow(() => assertRealtimeFrontendModel({ provider: 'gpt-live-1', model: 'live-deployment-a' }))
  // Providers without the flag keep the strict catalog check.
  assert.equal(resolveRealtimeModelProfile('realtime-deployment-a', 'gpt-live').family, 'unknown')
  assert.throws(
    () => assertRealtimeFrontendModel({ provider: 'gpt-live', model: 'realtime-deployment-a' }),
    /不属于 gpt-live/,
  )
})

test('GPT-Live 1 protocol keeps the playing answer open on cancel until the model yields', async () => {
  const emitted = []
  const protocol = createGptLive1Protocol({ emit: event => emitted.push(event), outputIdleMs: 20 })
  const opened = protocol.normalizeIncoming({ type: 'session.output_audio.delta', delta: SPEECH })
  const voiceId = opened.find(event => event.type === 'response.created').response.id
  // A response the adapter did not open (a foreign dialect passed through) is
  // not a playback record, so a cancel leaves it alone as well.
  protocol.normalizeIncoming({ type: 'response.created', response: { id: 'response_passthrough' } })
  // A delegated backend response keeps running on the service when speech is
  // interrupted, so a gateway cancel must leave it open for its tool loop.
  protocol.normalizeIncoming({
    type: 'response.event', delegation_id: 'item_bg',
    event: { type: 'response.created', response: { id: 'resp_bg' } },
  })
  assert.equal(protocol.responseCancel(), null)
  await new Promise(resolve => queueMicrotask(resolve))
  assert.deepEqual(emitted, [], 'the runtime already muted the answer; nothing closes yet')
  // The model's remaining words still belong to the muted answer.
  assert.deepEqual(protocol.normalizeIncoming({ type: 'session.output_transcript.delta', delta: '了', start_ms: 400, end_ms: 600 }),
    [{ type: 'response.output_audio_transcript.delta', response_id: voiceId, delta: '了' }])
  // Its first silence frame is the model yielding: the answer closes as cancelled.
  assert.deepEqual(protocol.normalizeIncoming({ type: 'session.output_audio.delta', delta: SILENCE }), [
    { type: 'response.output_audio_transcript.done', response_id: voiceId, transcript: '了' },
    { type: 'response.done', response: { id: voiceId, status: 'cancelled' }, response_id: voiceId, __voicePlayback: true },
  ])
  const backendDone = protocol.normalizeIncoming({
    type: 'response.event', delegation_id: 'item_bg',
    event: { type: 'response.completed', response: { id: 'resp_bg', status: 'completed' } },
  })
  assert.equal(backendDone[0].response_id, 'resp_bg')
  // A cancelled voice segment does not leak into the next one.
  const next = protocol.normalizeIncoming({ type: 'session.output_audio.delta', delta: SPEECH })
  const nextId = next.find(event => event.type === 'response.created').response.id
  assert.notEqual(nextId, voiceId)
  assert.equal(protocol.responseCancel(), null)
  assert.equal(protocol.normalizeIncoming({ type: 'session.output_audio.delta', delta: SILENCE })[0].response.id, nextId)
  // A cancel with nothing playing is a no-op.
  assert.equal(protocol.responseCancel(), null)
  assert.deepEqual(protocol.normalizeIncoming({ type: 'session.output_audio.delta', delta: SILENCE }), [])
  assert.deepEqual(emitted, [])
})

test('GPT-Live 1 setup gate accepts either the dedicated key or OPENAI_API_KEY', () => {
  const base = { QWEN_AUDIO_REALTIME_PROVIDER: 'gpt-live-1', GPT_LIVE_1_REALTIME_MODEL: 'live-deployment-a' }
  assert.equal(gatewaySetupStatus({ ...base, GPT_LIVE_1_API_KEY: 'service-key', OPENAI_API_KEY: '' }).ready, true)
  assert.equal(gatewaySetupStatus({ ...base, OPENAI_API_KEY: 'sk-plain' }).ready, true)
  const missing = gatewaySetupStatus({ ...base, OPENAI_API_KEY: '' })
  assert.equal(missing.ready, false)
  assert.deepEqual(missing.missing.map(item => item.key), ['GPT_LIVE_1_API_KEY'])
  assert.match(missing.missing[0].message, /也支持 OPENAI_API_KEY/)
})

test('GPT-Live 1 keeps gateway responses off the voice playback gate', async () => {
  assert.equal(gptLive1Provider.capabilities.concurrentVoicePlayback, true)
  const frontend = new RealtimeFrontend({ provider: gptLive1Provider, agentContext: {} })
  // A voice playback response is active but must not gate gateway work.
  frontend.activeResponses.add('voice_1')
  frontend.playbackResponses.add('voice_1')
  assert.equal(frontend.gatingResponsesActive(), false)
  await frontend.whenIdle() // resolves immediately despite open playback

  // A backend delegation response does gate: whenIdle waits for it.
  frontend.activeResponses.add('resp_1')
  assert.equal(frontend.gatingResponsesActive(), true)
  let resolved = false
  const idle = frontend.whenIdle().then(() => { resolved = true })
  await new Promise(resolve => setTimeout(resolve, 15))
  assert.equal(resolved, false, 'a backend response still gates whenIdle')
  frontend.activeResponses.delete('resp_1')
  frontend.resolveIdle()
  await idle
  assert.equal(resolved, true)
  // A stale playback id that is no longer active must not hide a backend response.
  frontend.playbackResponses.add('voice_stale')
  frontend.activeResponses.add('resp_2')
  assert.equal(frontend.gatingResponsesActive(), true)
  frontend.close()
})

test('GPT-Live 1 keeps a protocol re-request off the pending Gateway request', () => {
  const frontend = new RealtimeFrontend({ provider: gptLive1Provider, agentContext: {} })
  frontend.ready = true
  const sent = []
  frontend.ws = { readyState: 1, send: raw => sent.push(JSON.parse(raw)) }
  const pending = { requestId: 'req_1', origin: 'agent', context: {}, resolve() {}, reject() {}, responsePayload: { type: 'session.commentary.append', content: 'hi' } }
  frontend.pendingResponses.push(pending)
  frontend.send({ type: 'response.create' }, { correlate: false })
  assert.equal(pending.responsePayload.type, 'session.commentary.append')
  frontend.send({ type: 'response.create' })
  assert.equal(pending.responsePayload.type, 'response.create')
  assert.equal(sent.filter(event => event.type === 'response.create').length, 2)
  frontend.resetResponses()
})

test('GPT-Live 1 marks synthesised voice responses as playback end to end', () => {
  const frontend = new RealtimeFrontend({ provider: gptLive1Provider, agentContext: {} })
  for (const event of frontend.protocol.normalizeIncoming({
    type: 'session.output_audio.delta', delta: SPEECH, start_ms: 0, end_ms: 100,
  })) {
    if (event.type === 'response.created') {
      assert.equal(event.__voicePlayback, true)
      frontend.handleLifecycle(event)
      assert.equal(frontend.playbackResponses.has(event.response.id), true)
      assert.equal(frontend.gatingResponsesActive(), false)
    }
  }
  frontend.close()
})

test('GPT-Live 1 binds a delegation to its backend response id', () => {
  const protocol = createGptLive1Protocol()
  assert.deepEqual(protocol.normalizeIncoming({
    type: 'session.delegation.created',
    delegation: { id: 'item_d9', type: 'delegation', target: 'responses', response_id: 'resp_9' },
  }), [])
  const call = protocol.normalizeIncoming({
    type: 'response.event', delegation_id: 'item_d9',
    event: { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'call_9', name: 'fetch_url', arguments: '{}' } },
  })
  assert.equal(call[0].response_id, 'resp_9', 'tool call carries the bound response id, not the delegation id')
  const done = protocol.normalizeIncoming({
    type: 'response.event', delegation_id: 'item_d9',
    event: { type: 'response.completed', response: { id: 'resp_9', status: 'completed' } },
  })
  assert.equal(done[0].response_id, 'resp_9')
  // After completion the binding is gone; a stray event falls back to the delegation id.
  const stray = protocol.normalizeIncoming({
    type: 'response.event', delegation_id: 'item_d9',
    event: { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'call_x', name: 'f', arguments: '{}' } },
  })
  assert.equal(stray[0].response_id, 'item_d9')
})

test('GPT-Live 1 sends session.update only when the delegation block changes', () => {
  const protocol = createGptLive1Protocol()
  const delegation = { type: 'responses', responses: { model: 'gpt-6-luna', tools: [{ type: 'function', name: 'a' }] } }
  protocol.connectionMessages({ session: { model: 'gpt-live-1', delegation } })
  assert.equal(protocol.sessionUpdate({ model: 'gpt-live-1', delegation }), null, 'unchanged after start')
  const changed = { ...delegation, responses: { ...delegation.responses, tools: [{ type: 'function', name: 'b' }] } }
  assert.deepEqual(protocol.sessionUpdate({ model: 'gpt-live-1', instructions: 'ignored', delegation: changed }), {
    type: 'session.update',
    session: { delegation: changed },
  })
  assert.equal(protocol.sessionUpdate({ delegation: changed }), null, 'deduplicated')
})

test('GPT-Live 1 closes an incomplete backend response and isolates command errors', () => {
  const protocol = createGptLive1Protocol()
  protocol.normalizeIncoming({ type: 'session.started', session: { id: 's' } })
  protocol.normalizeIncoming({
    type: 'response.event', delegation_id: 'item_x',
    event: { type: 'response.created', response: { id: 'resp_x' } },
  })
  const incomplete = protocol.normalizeIncoming({
    type: 'response.event', delegation_id: 'item_x',
    event: { type: 'response.incomplete', response: { id: 'resp_x', status: 'incomplete' } },
  })
  assert.deepEqual(incomplete, [{
    type: 'response.done', response: { id: 'resp_x', status: 'incomplete' }, response_id: 'resp_x',
  }])

  // A rejected mute is a command error: it gets its own id instead of being
  // attributed to whichever backend response happens to be active.
  const mute = protocol.encodeOutgoing({ type: 'session.input_audio.mute' })
  const muteError = protocol.normalizeIncoming({
    type: 'error', error: { code: 'invalid_request_error', message: 'not now', client_event_id: mute.event_id },
  })
  assert.equal(muteError.response_id, `gpt-live-1:command:${mute.event_id}`)
  // A rejected response.create does concern the pending backend response.
  const create = protocol.encodeOutgoing({ type: 'response.create' })
  const createError = protocol.normalizeIncoming({
    type: 'error', error: { code: 'invalid_request_error', message: 'pending results', client_event_id: create.event_id },
  })
  assert.equal(createError.response_id, undefined)
  // Errors without a client event id pass through untouched.
  assert.equal(protocol.normalizeIncoming({ type: 'error', error: { message: 'x' } }).response_id, undefined)
})

test('GPT-Live 1 trace records both directions without audio payloads', () => {
  const lines = []
  const protocol = createGptLive1Protocol({ trace: line => lines.push(line) })
  protocol.connectionMessages({ session: { model: 'gpt-live-1' } })
  protocol.encodeOutgoing({ type: 'session.input_audio.append', audio: 'A'.repeat(4000) })
  protocol.encodeOutgoing({ type: 'response.create' })
  protocol.normalizeIncoming({ type: 'session.output_audio.delta', delta: 'B'.repeat(4000), start_ms: 0, end_ms: 100 })
  protocol.normalizeIncoming({ type: 'session.input_transcript.delta', delta: 'hi', start_ms: 0, end_ms: 100 })
  assert.deepEqual(lines.map(line => line.split(' ')[1] + ' ' + JSON.parse(line.slice(line.indexOf('{'))).type), [
    '>> session.start',
    '>> response.create',
    '<< session.input_transcript.delta',
  ], 'audio appends and audio deltas are not traced; other events are')
  assert.ok(lines.every(line => !line.includes('A'.repeat(50)) && !line.includes('B'.repeat(50))))
})

test('GPT-Live 1 trace replaces conversation content by its length and caps service messages', () => {
  const lines = []
  const protocol = createGptLive1Protocol({ trace: line => lines.push(line) })
  protocol.connectionMessages({
    session: {
      model: 'gpt-live-1',
      instructions: 'persona secret',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'earlier turn' }] }],
      delegation: { type: 'responses', responses: { model: 'backend', instructions: 'backend secret' } },
    },
  })
  protocol.normalizeIncoming({ type: 'session.started', session: { id: 'sess_1' } })
  protocol.normalizeIncoming({ type: 'session.input_transcript.delta', delta: 'hi', start_ms: 0, end_ms: 100 })
  protocol.normalizeIncoming({
    type: 'response.event',
    event: { type: 'response.output_item.done', item: { type: 'function_call', name: 'get_weather', call_id: 'call_1', arguments: '{"city":"Shanghai"}' } },
  })
  protocol.encodeOutgoing({ type: 'response.item.create', item: { type: 'function_call_output', call_id: 'call_1', output: 'sunny in Shanghai' } })
  protocol.normalizeIncoming({ type: 'error', error: { code: 'invalid_value', message: 'M'.repeat(300) } })
  const joined = lines.join('')
  for (const content of ['persona secret', 'earlier turn', 'backend secret', '"delta":"hi"', 'Shanghai', 'sunny']) {
    assert.ok(!joined.includes(content), `trace must not carry ${content}`)
  }
  assert.ok(joined.includes('get_weather') && joined.includes('call_1') && joined.includes('sess_1'), 'ids and names stay')
  assert.ok(joined.includes(`${'M'.repeat(200)}…<300 chars>`) && !joined.includes('M'.repeat(201)), 'messages are capped')
})

test('GPT-Live 1 fits a tool result into a byte budget by cutting its longest string first', () => {
  const item = {
    type: 'function_call_output',
    call_id: 'call_1',
    output: JSON.stringify({ status: 'ok', url: 'https://example.test/weather', content: '天气'.repeat(6000) }),
  }
  const fitted = fitBackendItem(item, 4096)
  assert.ok(utf8Bytes(fitted) <= 4096, `${utf8Bytes(fitted)} bytes`)
  assert.equal(fitted.call_id, 'call_1')
  const output = JSON.parse(fitted.output)
  assert.equal(output.status, 'ok', 'the envelope survives; only the bulk string is cut')
  assert.equal(output.url, 'https://example.test/weather')
  assert.match(output.content, /^[天气]+…\[truncated; \d+ bytes in full\]$/, 'cut at a code-point boundary, marked once')

  assert.equal(fitBackendItem(item, 1 << 20), item, 'an item that fits is passed through untouched')

  const text = fitBackendItem({ type: 'function_call_output', call_id: 'c', output: '汉'.repeat(1000) }, 300)
  assert.ok(utf8Bytes(text) <= 300)
  assert.match(text.output, /^汉+…\[truncated; 3000 bytes in full\]$/, 'plain text is cut at a code-point boundary')

  const message = fitBackendItem({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'x'.repeat(5000) }] }, 1000)
  assert.ok(utf8Bytes(message) <= 1000)
  assert.equal(message.content[0].type, 'input_text')

  assert.equal(fitBackendItem({ type: 'function_call_output', call_id: 'c', output: '{}' }, 10), null, 'nothing left to cut')
})

test('GPT-Live 1 shares the session backend input budget across tool results', () => {
  const emitted = []
  const protocol = createGptLive1Protocol({ emit: event => emitted.push(event), backendInputMaxBytes: 8192 })
  const big = () => protocol.functionOutputItem('call_x', { content: 'x'.repeat(20000) })
  const sizes = []
  for (let index = 0; index < 4; index++) {
    sizes.push(utf8Bytes(protocol.encodeOutgoing(protocol.conversationItemCreate(big())).item))
  }
  // Each result takes at most half of what is left, so they shrink and the
  // total stays under the cap with the reserve untouched.
  assert.ok(sizes[0] > sizes[1] && sizes[1] > sizes[2], sizes.join(','))
  assert.ok(sizes.reduce((sum, bytes) => sum + bytes, 0) <= 8192 - 1024 + 256, sizes.join(','))
  // With the budget spent a pending call still gets an answer: a stub.
  const stub = protocol.encodeOutgoing(protocol.conversationItemCreate(big())).item
  assert.equal(JSON.parse(stub.output).error_code, 'tool_result_too_large')
  assert.equal(stub.call_id, 'call_x')
  // Typed text is dropped instead, and the user is told the session is full.
  assert.equal(protocol.conversationItemCreate(protocol.userTextItem('记住我喝美式')), null)
  return new Promise(resolve => setImmediate(resolve)).then(() => {
    assert.equal(emitted.at(-1)?.error?.code, 'backend_input_budget_exhausted')
  })
})

test('GPT-Live 1 answers a rejected tool result again, smaller, and re-requests the response', async () => {
  const sent = []
  const protocol = createGptLive1Protocol({ send: (payload, options) => sent.push({ ...payload, options }) })
  protocol.normalizeIncoming({ type: 'session.started', session: { id: 's' } })
  const item = protocol.encodeOutgoing(protocol.conversationItemCreate(
    protocol.functionOutputItem('call_1', { content: 'y'.repeat(30000) }),
  ))
  const create = protocol.encodeOutgoing({ type: 'response.create' })
  const rejected = protocol.normalizeIncoming({
    type: 'error',
    error: {
      type: 'invalid_request_error', code: 'response_input_buffer_full', param: 'item',
      message: 'Backend response input history is limited to 128 items and 32768 UTF-8 bytes per session.',
      client_event_id: item.event_id,
    },
  })
  assert.deepEqual(rejected, [], 'the rejection is handled, not surfaced')
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(sent.map(payload => payload.type), ['response.item.create', 'response.create'])
  assert.equal(sent[0].item.call_id, 'call_1')
  assert.ok(utf8Bytes(sent[0].item) <= Math.floor(utf8Bytes(item.item) / 2), 'the retry backs off from the rejected size')
  assert.equal(JSON.parse(sent[0].item.output).content.slice(0, 3), 'yyy', 'the retry is the same result, cut shorter')
  assert.equal(sent[0].options, undefined)
  assert.deepEqual(sent[1].options, { correlate: false }, 'the re-request is not correlated to a Gateway request')
  // The superseded response.create fails on the service with "outputs
  // required"; that error is expected and swallowed. Any other passes through.
  assert.deepEqual(protocol.normalizeIncoming({
    type: 'error',
    error: { code: 'function_call_outputs_required', message: 'Submit the pending function call outputs before response.create.', client_event_id: create.event_id },
  }), [])
  const other = protocol.normalizeIncoming({
    type: 'error',
    error: { code: 'function_call_outputs_required', message: 'Submit the pending function call outputs before response.create.', client_event_id: 'event_other' },
  })
  assert.equal(other.type, 'error')
})

test('GPT-Live 1 learns the backend input limit from the service and reports exhaustion', () => {
  const protocol = createGptLive1Protocol()
  protocol.normalizeIncoming({ type: 'session.started', session: { id: 's' } })
  const item = protocol.encodeOutgoing(protocol.conversationItemCreate(
    protocol.functionOutputItem('call_1', { content: 'z'.repeat(9000) }),
  ))
  // Without a send hook nothing can be re-sent: the error reaches the user with guidance.
  const error = protocol.normalizeIncoming({
    type: 'error',
    error: {
      code: 'response_input_buffer_full', client_event_id: item.event_id,
      message: 'Backend response input history is limited to 4 items and 4000 UTF-8 bytes per session.',
    },
  })
  assert.equal(error.type, 'error')
  assert.match(error.error.message, /重新连接/)
  // The cap the service stated governs the next result.
  const next = protocol.encodeOutgoing(protocol.conversationItemCreate(
    protocol.functionOutputItem('call_2', { content: 'z'.repeat(9000) }),
  ))
  assert.ok(utf8Bytes(next.item) <= 4000 - 1024, `${utf8Bytes(next.item)} bytes`)
})

test('GPT-Live 1 opens a continued backend response that resumes with in_progress', () => {
  const protocol = createGptLive1Protocol()
  const envelope = event => ({ type: 'response.event', delegation_id: 'item_d', event })
  assert.equal(protocol.normalizeIncoming(envelope({ type: 'response.created', response: { id: 'resp_c' } }))[0].type, 'response.created')
  assert.deepEqual(protocol.normalizeIncoming(envelope({ type: 'response.in_progress', response: { id: 'resp_c' } })), [],
    'in_progress after created adds nothing')
  protocol.normalizeIncoming(envelope({ type: 'response.completed', response: { id: 'resp_c', status: 'completed' } }))
  // After tool results the same response resumes without a created event.
  assert.deepEqual(protocol.normalizeIncoming(envelope({ type: 'response.in_progress', response: { id: 'resp_c' } })), [{
    type: 'response.created', response: { id: 'resp_c', status: 'in_progress' }, response_id: 'resp_c',
  }])
})

test('GPT-Live 1 seeds session.input within the documented token budget', () => {
  const history = sessionInputHistory([
    { role: 'user', content: '早'.repeat(5000) },
    { role: 'assistant', content: '好'.repeat(5000) },
    { role: 'user', content: '再见' },
  ])
  // A CJK character is about one token; 5,000 + 5,000 would exceed the budget,
  // so only the most recent two messages are seeded.
  assert.deepEqual(history.map(message => message.content[0].text.length), [5000, 2])
})

test('GPT-Live 1 releases a failed backend response so Gateway requests are not gated forever', async () => {
  const frontend = new RealtimeFrontend({ provider: gptLive1Provider, agentContext: {} })
  const feed = raw => {
    for (const event of frontend.protocol.normalizeIncoming(raw)) frontend.handleLifecycle(event)
  }
  feed({ type: 'session.output_audio.delta', delta: SPEECH, start_ms: 0, end_ms: 100 })
  feed({ type: 'response.event', delegation_id: 'item_f', event: { type: 'response.created', response: { id: 'resp_f' } } })
  assert.equal(frontend.gatingResponsesActive(), true, 'a voice segment and a backend response are open')
  const failed = frontend.protocol.normalizeIncoming({
    type: 'response.event', delegation_id: 'item_f',
    event: { type: 'response.failed', response: { id: 'resp_f', error: { message: 'quota' } } },
  })
  assert.equal(failed[0].type, 'error')
  assert.equal(failed[0].response_id, 'resp_f', 'the failure names the response it ends')
  for (const event of failed) frontend.handleLifecycle(event)
  assert.equal(frontend.activeResponses.has('resp_f'), false)
  assert.equal(frontend.gatingResponsesActive(), false, 'only the playback response remains')
  await frontend.whenIdle()
  frontend.close()
})

test('GPT-Live 1 keeps the tail of an interrupted answer on that answer and closes it once the model yields', () => {
  const types = events => events.map(event => event.type)
  const protocol = createGptLive1Protocol()
  protocol.normalizeIncoming({ type: 'session.started', session: { id: 'sess_1' } })
  protocol.normalizeIncoming({ type: 'session.input_transcript.delta', delta: '天气', start_ms: 1000, end_ms: 1400 })
  const opened = protocol.normalizeIncoming({ type: 'session.output_audio.delta', delta: SPEECH })
  const answerId = opened.find(event => event.type === 'response.created').response.id
  protocol.normalizeIncoming({ type: 'session.output_transcript.delta', delta: '晴没有', start_ms: 3000, end_ms: 3600 })
  // The user barges in. The runtime mutes the answer on speech_started; here it
  // stays open for the words the model still says, which do not commit the
  // user's new question as answered.
  const barge = protocol.normalizeIncoming({ type: 'session.input_transcript.delta', delta: '哦你', start_ms: 3600, end_ms: 3800 })
  assert.deepEqual(types(barge), [
    'conversation.item.input_audio_transcription.completed',
    'input_audio_buffer.speech_started',
    'conversation.item.input_audio_transcription.delta',
  ])
  assert.deepEqual(protocol.normalizeIncoming({ type: 'session.output_audio.delta', delta: SPEECH }),
    [{ type: 'response.output_audio.delta', response_id: answerId, delta: SPEECH }])
  assert.deepEqual(protocol.normalizeIncoming({ type: 'session.output_transcript.delta', delta: '下雨', start_ms: 3800, end_ms: 4200 }),
    [{ type: 'response.output_audio_transcript.delta', response_id: answerId, delta: '下雨' }])
  protocol.normalizeIncoming({ type: 'session.input_transcript.delta', delta: '能说日期吗', start_ms: 3800, end_ms: 5400 })
  // The model yields: its first silence frame closes the interrupted answer.
  assert.deepEqual(protocol.normalizeIncoming({ type: 'session.output_audio.delta', delta: SILENCE }), [
    { type: 'response.output_audio_transcript.done', response_id: answerId, transcript: '晴没有下雨' },
    { type: 'response.done', response: { id: answerId, status: 'cancelled' }, response_id: answerId, __voicePlayback: true },
  ])
  assert.deepEqual(protocol.normalizeIncoming({ type: 'session.output_audio.delta', delta: SILENCE }), [])
  // A fragment trailing the closed answer is not a new one.
  assert.deepEqual(protocol.normalizeIncoming({ type: 'session.output_transcript.delta', delta: '。', start_ms: 4200, end_ms: 4400 }), [])
  // The real answer (audio first, as on the wire) opens a fresh response and
  // commits the user's question; its first word stays intact.
  const answer = protocol.normalizeIncoming({ type: 'session.output_audio.delta', delta: SPEECH })
  assert.deepEqual(types(answer), [
    'input_audio_buffer.speech_stopped',
    'input_audio_buffer.committed',
    'response.created',
    'response.output_audio.delta',
  ])
  const nextId = answer[2].response.id
  assert.notEqual(nextId, answerId)
  assert.deepEqual(protocol.normalizeIncoming({ type: 'session.output_transcript.delta', delta: '好', start_ms: 6000, end_ms: 6200 }),
    [{ type: 'response.output_audio_transcript.delta', response_id: nextId, delta: '好' }])
})

test('GPT-Live 1 completes an answer the user only talked over', async () => {
  const types = events => events.map(event => event.type)
  const emitted = []
  let clock = 0
  const protocol = createGptLive1Protocol({ emit: event => emitted.push(event), outputIdleMs: 20, now: () => clock })
  protocol.normalizeIncoming({ type: 'session.input_transcript.delta', delta: '讲个故事', start_ms: 0, end_ms: 800 })
  const opened = protocol.normalizeIncoming({ type: 'session.output_audio.delta', delta: SPEECH })
  const answerId = opened.find(event => event.type === 'response.created').response.id
  protocol.normalizeIncoming({ type: 'session.output_transcript.delta', delta: '从前', start_ms: 2000, end_ms: 2400 })
  // "mm-hm" over the story starts a user turn; the runtime mutes the story.
  const over = protocol.normalizeIncoming({ type: 'session.input_transcript.delta', delta: '嗯嗯', start_ms: 4000, end_ms: 4400 })
  assert.deepEqual(types(over), [
    'conversation.item.input_audio_transcription.completed',
    'input_audio_buffer.speech_started',
    'conversation.item.input_audio_transcription.delta',
  ])
  clock = 1500
  // The model talks straight through: the story completes (it was never
  // interrupted) and its speech carries on, audibly, as a new response.
  const carriesOn = protocol.normalizeIncoming({ type: 'session.output_audio.delta', delta: SPEECH })
  assert.deepEqual(types(carriesOn), [
    'response.output_audio_transcript.done',
    'response.done',
    'input_audio_buffer.speech_stopped',
    'input_audio_buffer.committed',
    'response.created',
    'response.output_audio.delta',
  ])
  assert.equal(carriesOn[0].transcript, '从前')
  assert.deepEqual(carriesOn[1].response, { id: answerId, status: 'completed' })
  const nextId = carriesOn[4].response.id
  assert.notEqual(nextId, answerId)
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.deepEqual(protocol.normalizeIncoming(emitted.at(-1)), [{
    type: 'response.done', response: { id: nextId, status: 'completed' }, response_id: nextId, __voicePlayback: true,
  }])
})

test('GPT-Live 1 treats the digital silence streamed between answers as no output', async () => {
  const emitted = []
  const protocol = createGptLive1Protocol({ emit: event => emitted.push(event), outputIdleMs: 20 })
  assert.deepEqual(protocol.normalizeIncoming({ type: 'session.output_audio.delta', delta: SILENCE }), [])
  const opened = protocol.normalizeIncoming({ type: 'session.output_audio.delta', delta: SPEECH })
  const id = opened[0].response.id
  // A pause inside the answer plays through without extending the segment.
  assert.deepEqual(protocol.normalizeIncoming({ type: 'session.output_audio.delta', delta: SILENCE }),
    [{ type: 'response.output_audio.delta', response_id: id, delta: SILENCE }])
  const stream = setInterval(() => protocol.normalizeIncoming({ type: 'session.output_audio.delta', delta: SILENCE }), 5)
  await new Promise(resolve => setTimeout(resolve, 60))
  clearInterval(stream)
  assert.deepEqual(protocol.normalizeIncoming(emitted[0]), [{
    type: 'response.done', response: { id, status: 'completed' }, response_id: id, __voicePlayback: true,
  }])
  assert.deepEqual(protocol.normalizeIncoming({ type: 'session.output_audio.delta', delta: SILENCE }), [])
})

test('GPT-Live 1 keeps an explicitly cancelled answer muted until the model pauses', () => {
  let clock = 0
  const protocol = createGptLive1Protocol({ now: () => clock })
  const opened = protocol.normalizeIncoming({ type: 'session.output_audio.delta', delta: SPEECH })
  const answerId = opened[0].response.id
  assert.equal(protocol.responseCancel(), null)
  // Long past the yield window the speech still belongs to the muted answer:
  // the wire cannot stop the model, and resuming it audibly would undo the stop.
  clock = 5000
  assert.deepEqual(protocol.normalizeIncoming({ type: 'session.output_audio.delta', delta: SPEECH }),
    [{ type: 'response.output_audio.delta', response_id: answerId, delta: SPEECH }])
  assert.deepEqual(
    protocol.normalizeIncoming({ type: 'session.output_audio.delta', delta: SILENCE }).map(event => [event.type, event.response.status]),
    [['response.done', 'cancelled']],
  )
})

test('GPT-Live 1 command errors carry their own id and settle no waiting Gateway request', () => {
  const frontend = new RealtimeFrontend({ provider: gptLive1Provider, agentContext: {} })
  const feed = raw => {
    for (const event of [].concat(frontend.protocol.normalizeIncoming(raw) ?? [])) frontend.handleLifecycle(event)
  }
  feed({ type: 'session.started', session: { id: 'sess_1' } })
  feed({ type: 'response.event', delegation_id: 'item_c', event: { type: 'response.created', response: { id: 'resp_c' } } })
  const waiter = { origin: 'agent', context: {}, settled: false, resolve: () => {}, timer: null }
  frontend.responseWaiters.set('resp_c', waiter)
  // A rejected append is a command error with a synthetic id, not the backend's.
  feed({ type: 'error', error: { code: 'invalid_request_error', message: 'append rejected', client_event_id: 'event_append_1' } })
  assert.equal(frontend.responseWaiters.get('resp_c'), waiter, 'the sole waiting request is not settled by an unrelated error')
  assert.equal(waiter.settled, false)
  assert.equal(frontend.activeResponses.has('resp_c'), true)
  frontend.close()
})

test('GPT-Live 1 model speech leaves a queued Gateway request for the backend response', () => {
  const frontend = new RealtimeFrontend({ provider: gptLive1Provider, agentContext: {} })
  const feed = raw => {
    for (const event of [].concat(frontend.protocol.normalizeIncoming(raw) ?? [])) frontend.handleLifecycle(event)
  }
  feed({ type: 'session.started', session: { id: 'sess_1' } })
  const pending = {
    origin: 'announcement', context: { taskIds: ['t1'] }, responseRequested: true,
    settled: false, resolve: () => {}, timer: null, isCurrent: () => true,
  }
  frontend.pendingResponses.push(pending)
  feed({ type: 'session.output_audio.delta', delta: SPEECH })
  assert.equal(frontend.pendingResponses[0], pending, "the voice layer's own speech does not take the request")
  for (const id of frontend.playbackResponses) assert.equal(frontend.responseWaiters.has(id), false)
  feed({ type: 'response.event', delegation_id: 'item_a', event: { type: 'response.created', response: { id: 'resp_a' } } })
  assert.equal(frontend.pendingResponses.length, 0)
  assert.equal(frontend.responseWaiters.get('resp_a'), pending, 'the backend response answers it')
  frontend.close()
})

test('GPT-Live 1 grows the question caption from late fragments without starting a turn', () => {
  const protocol = createGptLive1Protocol()
  const types = events => events.map(event => event.type)
  const first = protocol.normalizeIncoming({ type: 'session.input_transcript.delta', delta: '查', start_ms: 600, end_ms: 800 })
  assert.deepEqual(types(first), ['input_audio_buffer.speech_started', 'conversation.item.input_audio_transcription.delta'])
  const itemId = first[0].item_id
  // The answer begins as audio without timing, as on the OpenAI primary WebSocket.
  assert.ok(types(protocol.normalizeIncoming({ type: 'session.output_audio.delta', delta: SPEECH })).includes('response.created'))
  // The output transcript carries the time the answer began.
  protocol.normalizeIncoming({ type: 'session.output_transcript.delta', delta: '好', start_ms: 1800, end_ms: 2000 })
  assert.deepEqual(types(protocol.normalizeIncoming({ type: 'gpt-live-1.input_idle' })),
    ['conversation.item.input_audio_transcription.completed'])
  // A late fragment continuing the question's timeline reopens it: caption only.
  const late = protocol.normalizeIncoming({ type: 'session.input_transcript.delta', delta: '天气', start_ms: 800, end_ms: 1000 })
  assert.deepEqual(types(late), ['conversation.item.input_audio_transcription.delta'])
  assert.equal(late[0].item_id, itemId)
  assert.equal(late[0].text, '查天气')
  assert.deepEqual(protocol.normalizeIncoming({ type: 'gpt-live-1.input_idle' }), [], 'not completed twice')
  // Speech that began after the answer began is a barge-in: a new turn; the
  // runtime cancels playback, the answer closes once the model yields.
  const barge = protocol.normalizeIncoming({ type: 'session.input_transcript.delta', delta: '等', start_ms: 3500, end_ms: 3700 })
  assert.deepEqual(types(barge), ['input_audio_buffer.speech_started', 'conversation.item.input_audio_transcription.delta'])
  assert.notEqual(barge[0].item_id, itemId)
  const yielded = protocol.normalizeIncoming({ type: 'session.output_audio.delta', delta: SILENCE })
  assert.deepEqual(types(yielded), ['response.output_audio_transcript.done', 'response.done'])
  assert.equal(yielded[1].response.status, 'cancelled')
})

test('GPT-Live 1 falls back to arrival order for turns when the transport sends no output timing', () => {
  const protocol = createGptLive1Protocol()
  protocol.normalizeIncoming({ type: 'session.input_transcript.delta', delta: 'hi', start_ms: 0, end_ms: 200 })
  protocol.normalizeIncoming({ type: 'gpt-live-1.input_idle' })
  // A pause before any answer continues the same turn.
  const more = protocol.normalizeIncoming({ type: 'session.input_transcript.delta', delta: ' there', start_ms: 2000, end_ms: 2200 })
  assert.deepEqual(more.map(event => event.type), ['conversation.item.input_audio_transcription.delta'])
  assert.equal(more[0].text, 'hi there')
  protocol.normalizeIncoming({ type: 'session.output_audio.delta', delta: SPEECH })
  // Once an answer began, a later pause-separated fragment is a new turn.
  const next = protocol.normalizeIncoming({ type: 'session.input_transcript.delta', delta: 'wait', start_ms: 5000, end_ms: 5200 })
  assert.deepEqual(next.map(event => event.type), ['input_audio_buffer.speech_started', 'conversation.item.input_audio_transcription.delta'])
})

test('GPT-Live 1 settles a speak request on the commentary acknowledgement', () => {
  const protocol = createGptLive1Protocol()
  const append = protocol.encodeOutgoing(protocol.responseCreate({ __liveSay: '晚饭好了' }))
  assert.equal(append.type, 'session.commentary.append')
  const acked = protocol.normalizeIncoming({ type: 'session.commentary.appended', client_event_id: append.event_id })
  assert.deepEqual(acked.map(event => event.type), ['response.created', 'response.done'])
  assert.equal(acked[0].__voicePlayback, true, 'a playback response: it never gates Gateway work')
  assert.equal(acked[1].response.id, acked[0].response.id)
  assert.deepEqual(protocol.normalizeIncoming({ type: 'session.commentary.appended', client_event_id: 'event_unknown' }), [])
  // A rejected commentary fails its own request, not the running backend response.
  const second = protocol.encodeOutgoing(protocol.responseCreate({ __liveSay: 'x' }))
  const rejected = protocol.normalizeIncoming({
    type: 'error', error: { code: 'invalid_request_error', message: 'too long', client_event_id: second.event_id },
  })
  assert.deepEqual(rejected.map(event => event.type), ['response.created', 'error'])
  assert.equal(rejected[1].response_id, rejected[0].response.id)
})

test('GPT-Live 1 keeps the Gateway message rules in the backend prompt, not in per-injection items', t => {
  const session = gptLive1Provider.buildSession({ agentContext: {}, sessionOptions: {} })
  const instructions = session.delegation.responses.instructions
  assert.match(instructions, /## Gateway messages/)
  assert.ok(instructions.includes(permissionResponseInstructions))
  assert.ok(instructions.includes(resultResponseInstructions))
  assert.deepEqual(gptLive1Provider.buildResultInjection('done').response, {})
  assert.deepEqual(gptLive1Provider.buildPermissionInjection({ id: 'p1', taskId: 't1', summary: 'read a file' }).response, {})
  const protocol = gptLive1Provider.createProtocol({})
  assert.equal(protocol.responseInstructionsItem({ instructions: resultResponseInstructions }), null)
  assert.equal(protocol.responseInstructionsItem({ instructions: progressResponseInstructions }), null)
  assert.equal(protocol.responseInstructionsItem({ instructions: '只读第一条工具结果' })?.type, 'message',
    'other per-response instructions still travel as items')
  // A custom backend prompt replaces the frame only; the task instructions stay.
  withEnv(t, { GPT_LIVE_1_DELEGATION_INSTRUCTIONS: 'Custom frame.' })
  const custom = gptLive1Provider.buildSession({ agentContext: {}, sessionOptions: {} }).delegation.responses.instructions
  assert.ok(custom.startsWith('Custom frame.'))
  assert.match(custom, /## Task instructions/)
  assert.match(custom, /## Gateway messages/)
})

test('GPT-Live 1 omits the seeded history once after the service rejected it at startup', () => {
  const recentMessages = [{ role: 'user', content: '早' }, { role: 'assistant', content: '好' }]
  const build = messages => gptLive1Provider.buildSession({ agentContext: { recentMessages: messages }, sessionOptions: {} })
  const protocol = gptLive1Provider.createProtocol({})
  protocol.connectionMessages({ session: build(recentMessages) })
  assert.equal(build(recentMessages).input.length, 2)
  protocol.normalizeIncoming({
    type: 'error',
    error: { type: 'invalid_request_error', code: 'invalid_value', param: 'input', message: 'input exceeds 8192 tokens', client_event_id: 'event_start' },
  })
  // Another connection in the same process seeds its own history untouched.
  assert.equal(build([{ role: 'user', content: '午安' }]).input.length, 1)
  assert.equal(build(recentMessages).input, undefined, 'the retry connects without the history the service refused')
  assert.equal(build(recentMessages).input.length, 2, 'later connects seed it again')
})

test('GPT-Live 1 classifies capacity limits and safety closures', () => {
  assert.equal(gptLive1Provider.classifyError('Unexpected server response: 429'), 'capacity_busy')
  assert.equal(gptLive1Provider.classifyError('Too many concurrent sessions for this tier'), 'capacity_busy')
  // A model that does not exist is configuration, not weather: no reconnect loop.
  assert.equal(gptLive1Provider.classifyError("model_not_deployed: invalid_request_error: Model deployment 'x' was not found."), 'fatal')
  assert.equal(gptLive1Provider.classifyError('model_not_found: The model `x` does not exist'), 'fatal')
  const protocol = createGptLive1Protocol()
  const closed = protocol.normalizeIncoming({ type: 'session.closed', reason: 'content', usage: { seconds: 10 } })
  assert.equal(closed.at(-1).type, 'error')
  assert.equal(gptLive1Provider.classifyError(closed.at(-1).error.message), 'content_safety')
  assert.deepEqual(protocol.normalizeIncoming({ type: 'session.closed', reason: 'expired' }), [])
})

test('GPT-Live 1 user speech cancels playback only; backend work and its tool calls survive', () => {
  const frontend = new RealtimeFrontend({ provider: gptLive1Provider, agentContext: {} })
  const feed = raw => {
    for (const event of frontend.protocol.normalizeIncoming(raw)) frontend.handleLifecycle(event)
  }
  feed({ type: 'session.output_audio.delta', delta: SPEECH, start_ms: 0, end_ms: 100 })
  feed({ type: 'response.event', delegation_id: 'item_c', event: { type: 'response.created', response: { id: 'resp_c' } } })
  const waiter = { origin: 'agent', context: {}, settled: false, resolve: () => {}, timer: null }
  frontend.responseWaiters.set('resp_c', waiter)
  const generation = frontend.responseQueueGeneration
  frontend.cancel()
  assert.equal(frontend.activeResponses.has('resp_c'), true, 'the backend response keeps running')
  assert.equal(frontend.responseWaiters.get('resp_c'), waiter, 'the request waiting on it is not settled')
  assert.equal(waiter.settled, false)
  assert.equal(frontend.responseQueueGeneration, generation, 'queued Gateway work is not dropped')
  frontend.close()

  // Tool calls of a full-duplex frontend are never superseded by a new user turn.
  const fullDuplex = new ToolCallHandler({
    getFrontend: () => ({ capabilities: { concurrentVoicePlayback: true } }),
    getTurnId: () => 'turn_2', getTurnGeneration: () => 2,
  })
  assert.equal(fullDuplex.isStale('turn_1', 1), false)
  const halfDuplex = new ToolCallHandler({
    getFrontend: () => ({ capabilities: {} }),
    getTurnId: () => 'turn_2', getTurnGeneration: () => 2,
  })
  assert.equal(halfDuplex.isStale('turn_1', 1), true, 'other providers keep the turn gate')
})

test('GPT-Live 1 encodes assistant history for the backend as output_text', () => {
  const protocol = createGptLive1Protocol()
  const item = protocol.conversationItemCreate({ type: 'message', role: 'assistant', content: [{ type: 'text', text: '好的' }] })
  assert.deepEqual(item.item.content, [{ type: 'output_text', text: '好的' }])
})

test('GPT-Live 1 keeps a closing punctuation off the head of the next utterance', () => {
  const types = events => events.map(event => event.type)
  const protocol = createGptLive1Protocol()
  // An earlier answer, closed, so later speech counts as fresh turns.
  protocol.normalizeIncoming({ type: 'session.output_audio.delta', delta: SPEECH, start_ms: 0, end_ms: 100 })
  protocol.normalizeIncoming({ type: 'gpt-live-1.output_idle' })
  const first = protocol.normalizeIncoming({ type: 'session.input_transcript.delta', delta: '帮我算一下', start_ms: 2000, end_ms: 2600 })
  assert.deepEqual(types(first), ['input_audio_buffer.speech_started', 'conversation.item.input_audio_transcription.delta'])
  // The pause outlasts the idle window: the utterance completes without its period.
  assert.equal(protocol.normalizeIncoming({ type: 'gpt-live-1.input_idle' }).at(-1).transcript, '帮我算一下')
  // The transcript delivers that period with the next utterance; the caption
  // does not begin with it.
  const next = protocol.normalizeIncoming({ type: 'session.input_transcript.delta', delta: '。三乘七', start_ms: 5000, end_ms: 5200 })
  assert.deepEqual(types(next), ['input_audio_buffer.speech_started', 'conversation.item.input_audio_transcription.delta'])
  assert.notEqual(next[0].item_id, first[0].item_id)
  assert.equal(next[1].delta, '三乘七')
  assert.equal(next[1].text, '三乘七')
  const more = protocol.normalizeIncoming({ type: 'session.input_transcript.delta', delta: '等于几', start_ms: 5200, end_ms: 5400 })
  assert.equal(more[0].text, '三乘七等于几')
  assert.equal(protocol.normalizeIncoming({ type: 'gpt-live-1.input_idle' }).at(-1).transcript, '三乘七等于几')
  // Any closing mark, in any width; opening marks start speech.
  const wide = protocol.normalizeIncoming({ type: 'session.input_transcript.delta', delta: '．」「对', start_ms: 8000, end_ms: 8200 })
  assert.equal(wide[1].text, '「对')
  protocol.normalizeIncoming({ type: 'gpt-live-1.input_idle' })
  // ASCII symbols that can begin speech are not closing marks.
  const quoted = protocol.normalizeIncoming({ type: 'session.input_transcript.delta', delta: "'cause I said", start_ms: 11000, end_ms: 11400 })
  assert.equal(quoted[1].text, "'cause I said")
})

test('GPT-Live 1 strips the runtime private keys from server events', () => {
  const protocol = createGptLive1Protocol()
  const passed = protocol.normalizeIncoming({ type: 'session.foreign', __voicePlayback: true, __voiceOrigin: 'announcement', detail: 1 })
  assert.deepEqual(passed, { type: 'session.foreign', detail: 1 })
})

test('GPT-Live 1 opens a new turn for untimed input once an answer has a timestamp', () => {
  const protocol = createGptLive1Protocol()
  const answer = startMs => {
    protocol.normalizeIncoming({ type: 'session.output_audio.delta', delta: SPEECH, start_ms: startMs, end_ms: startMs + 100 })
    protocol.normalizeIncoming({ type: 'gpt-live-1.output_idle' })
  }
  answer(1000)
  const first = protocol.normalizeIncoming({ type: 'session.input_transcript.delta', delta: '你好' })
  assert.equal(first[0].type, 'input_audio_buffer.speech_started')
  protocol.normalizeIncoming({ type: 'gpt-live-1.input_idle' })
  answer(5000)
  // A transport without input timestamps still gets a fresh turn after the answer.
  const second = protocol.normalizeIncoming({ type: 'session.input_transcript.delta', delta: '再见' })
  assert.equal(second[0].type, 'input_audio_buffer.speech_started')
  assert.notEqual(second[0].item_id, first[0].item_id)
})

test('GPT-Live 1 treats an unclosed bracket longer than an annotation as speech', () => {
  const types = events => events.map(event => event.type)
  const protocol = createGptLive1Protocol()
  assert.deepEqual(protocol.normalizeIncoming({ type: 'session.input_transcript.delta', delta: '[clear throat', start_ms: 600, end_ms: 800 }), [])
  // The close never comes and the user keeps talking: the words open the turn.
  const words = protocol.normalizeIncoming({ type: 'session.input_transcript.delta', delta: ' 你好今天天气怎么样啊我想出门', start_ms: 1000, end_ms: 2000 })
  assert.deepEqual(types(words), ['input_audio_buffer.speech_started', 'conversation.item.input_audio_transcription.delta'])
  assert.ok(words[1].text.endsWith('你好今天天气怎么样啊我想出门'))
})

test('GPT-Live 1 closes an open utterance with the punctuation that arrives with the next one', () => {
  const types = events => events.map(event => event.type)
  const protocol = createGptLive1Protocol()
  protocol.normalizeIncoming({ type: 'session.output_audio.delta', delta: SPEECH, start_ms: 0, end_ms: 100 })
  protocol.normalizeIncoming({ type: 'gpt-live-1.output_idle' })
  const first = protocol.normalizeIncoming({ type: 'session.input_transcript.delta', delta: 'OK', start_ms: 2000, end_ms: 2400 })
  const itemId = first[0].item_id
  // Speech resumes after a pause longer than a fragment gap but shorter than
  // the idle window, carrying the period of the sentence before it.
  const next = protocol.normalizeIncoming({ type: 'session.input_transcript.delta', delta: '。然后', start_ms: 3800, end_ms: 4000 })
  assert.deepEqual(types(next), [
    'input_audio_buffer.speech_stopped',
    'input_audio_buffer.committed',
    'conversation.item.input_audio_transcription.completed',
    'input_audio_buffer.speech_started',
    'conversation.item.input_audio_transcription.delta',
  ])
  assert.equal(next[2].item_id, itemId)
  assert.equal(next[2].transcript, 'OK。', 'the period closes the sentence it belongs to')
  assert.notEqual(next[3].item_id, itemId)
  assert.equal(next[4].text, '然后')
})

test('GPT-Live 1 non-speech annotations start no turn and leave the answer playing', () => {
  const types = events => events.map(event => event.type)
  const protocol = createGptLive1Protocol()
  const opened = protocol.normalizeIncoming({ type: 'session.output_audio.delta', delta: SPEECH, start_ms: 0, end_ms: 100 })
  const answerId = opened.find(event => event.type === 'response.created').response.id
  // The transcript annotates a throat clear; no words yet, so no turn and no
  // interruption of the answer.
  assert.deepEqual(protocol.normalizeIncoming({ type: 'session.input_transcript.delta', delta: '[clear throat', start_ms: 600, end_ms: 800 }), [])
  assert.deepEqual(protocol.normalizeIncoming({ type: 'session.output_audio.delta', delta: SPEECH, start_ms: 100, end_ms: 200 }),
    [{ type: 'response.output_audio.delta', response_id: answerId, delta: SPEECH }])
  const pause = protocol.normalizeIncoming({ type: 'session.output_audio.delta', delta: SILENCE, start_ms: 200, end_ms: 300 })
  assert.deepEqual(pause.map(event => [event.type, event.response_id]), [['response.output_audio.delta', answerId]], 'a pause inside the answer, not a yield')
  assert.deepEqual(protocol.normalizeIncoming({ type: 'gpt-live-1.input_idle' }), [], 'nothing to complete')
  // Words follow within the same run of speech: the turn opens on them alone.
  const words = protocol.normalizeIncoming({ type: 'session.input_transcript.delta', delta: '] 你好', start_ms: 1000, end_ms: 1200 })
  assert.deepEqual(types(words), ['input_audio_buffer.speech_started', 'conversation.item.input_audio_transcription.delta'])
  assert.equal(words[1].delta, '你好')
  assert.equal(words[1].text, '你好')
  // Now the answer is interrupted, and the model yields.
  const yielded = protocol.normalizeIncoming({ type: 'session.output_audio.delta', delta: SILENCE })
  assert.deepEqual(yielded.map(event => [event.type, event.response.status]), [['response.done', 'cancelled']])
  assert.equal(protocol.normalizeIncoming({ type: 'gpt-live-1.input_idle' }).at(-1).transcript, '你好')
  // An annotation on its own is not an utterance either.
  assert.deepEqual(protocol.normalizeIncoming({ type: 'session.input_transcript.delta', delta: '[laughs]', start_ms: 4000, end_ms: 4200 }), [])
  assert.deepEqual(protocol.normalizeIncoming({ type: 'gpt-live-1.input_idle' }), [])
})

test('GPT-Live 1 never begins an answer with the punctuation that closed the one before', () => {
  const types = events => events.map(event => event.type)
  let clock = 0
  const protocol = createGptLive1Protocol({ now: () => clock })
  const first = protocol.normalizeIncoming({ type: 'session.output_audio.delta', delta: SPEECH, start_ms: 0, end_ms: 100 })
  const firstId = first.find(event => event.type === 'response.created').response.id
  protocol.normalizeIncoming({ type: 'session.output_transcript.delta', delta: '好的', start_ms: 0, end_ms: 200 })
  clock = 1000
  assert.deepEqual(types(protocol.normalizeIncoming({ type: 'gpt-live-1.output_idle' })), ['response.output_audio_transcript.done', 'response.done'])
  // The period of that answer trails it beyond the lag window: punctuation
  // alone opens no answer.
  clock = 3000
  assert.deepEqual(protocol.normalizeIncoming({ type: 'session.output_transcript.delta', delta: '。', start_ms: 200, end_ms: 400 }), [])
  // The next answer's first fragment carries it as well.
  const next = protocol.normalizeIncoming({ type: 'session.output_audio.delta', delta: SPEECH, start_ms: 5000, end_ms: 5100 })
  const nextId = next.find(event => event.type === 'response.created').response.id
  assert.notEqual(nextId, firstId)
  assert.deepEqual(protocol.normalizeIncoming({ type: 'session.output_transcript.delta', delta: '。好啊', start_ms: 5000, end_ms: 5200 }),
    [{ type: 'response.output_audio_transcript.delta', response_id: nextId, delta: '好啊' }])
  assert.deepEqual(protocol.normalizeIncoming({ type: 'session.output_transcript.delta', delta: '，来了', start_ms: 5200, end_ms: 5400 }),
    [{ type: 'response.output_audio_transcript.delta', response_id: nextId, delta: '，来了' }], 'punctuation inside the answer stays')
  assert.equal(protocol.normalizeIncoming({ type: 'gpt-live-1.output_idle' })[0].transcript, '好啊，来了')
})
