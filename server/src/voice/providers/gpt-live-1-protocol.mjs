import { randomUUID } from 'node:crypto'

function id(prefix) {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`
}

const responseCreated = (id, extra) => ({ type: 'response.created', response: { id, status: 'in_progress' }, response_id: id, ...extra })
const responseDone = (id, status, extra) => ({ type: 'response.done', response: { id, status }, response_id: id, ...extra })
const PLAYBACK = { __voicePlayback: true }

export function messageItem(role, text) {
  return { type: 'message', role, content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }] }
}

function textFromItem(item) {
  return (Array.isArray(item?.content) ? item.content : [])
    .map(part => String(part?.text || '').trim())
    .filter(Boolean)
    .join('\n')
    .trim()
}

// The Live API marks no turn or answer boundaries; these provisional defaults
// (ms), from live sessions, place them. See GPT_LIVE_1_*_MS.
export const GPT_LIVE_1_TIMING_DEFAULTS = Object.freeze({
  // An answer ends after this long without its speech or words.
  outputIdleMs: 1500,
  // A gap this long in the model's words begins a new answer; pauses between words are shorter.
  wordGapMs: 600,
  // A gap this long in the user's speech begins a new utterance.
  inputSegmentGapMs: 1200,
  // An utterance completes after this much quiet.
  inputIdleMs: 2000,
})
// Output audio streams silence between answers; quieter frames are not speech.
const OUTPUT_SPEECH_RMS = 100
const INPUT_IDLE_EVENT = 'gpt-live-1.input_idle'
const OUTPUT_IDLE_EVENT = 'gpt-live-1.output_idle'
// A sentence's closing punctuation can arrive with the next fragment.
const LEADING_PUNCTUATION_RE = /^[[\s\p{Pe}\p{Pf}\p{Po}]--[¡¿'"#%&*\/@\\]]+/v
// "[clear throat]"-style annotations are not speech; a short unclosed one waits.
const NON_SPEECH_TAG_RE = /\[[^[\]]*\]/g
const OPEN_TAG_RE = /\[[^[\]]{0,24}$/
// An appended instruction is how the Live API stops speech in progress. It stays in
// the session, so it names the cut reply only: the user can still ask for it again.
const STOP_SPEAKING = Object.freeze({
  type: 'session.instructions.append',
  delegation_id: null,
  content: 'Stop speaking now and drop the reply you were giving. This applies to that reply only: if the user asks for it again, give it.',
})
// Replaces a tool result the service refused, so the backend can continue.
const REJECTED_RESULT = JSON.stringify({
  error: true,
  error_code: 'tool_result_rejected',
  retryable: false,
  message: 'The tool ran, but its result could not be returned. Do not call it again for this request; tell the user the result is unavailable.',
})

// Punctuation and spaces are not speech.
const hasWords = text => /[\p{L}\p{N}]/u.test(String(text || ''))

function leadingPunctuation(text) {
  return (String(text || '').match(LEADING_PUNCTUATION_RE)?.[0] || '').trim()
}

// What the user said, without annotations or the previous sentence's close.
function spokenInputText(raw) {
  return String(raw || '')
    .replace(NON_SPEECH_TAG_RE, '')
    .replace(OPEN_TAG_RE, '')
    .replace(LEADING_PUNCTUATION_RE, '')
}

// The caption keeps fragments as received, less the previous sentence's close.
function userCaption(raw) {
  return String(raw || '').replace(LEADING_PUNCTUATION_RE, '')
}

// Append events take at most 500 tokens: estimate conservatively (a non-ASCII
// character per token, four ASCII characters per token) and clamp below it.
const COMMENTARY_MAX_TOKENS = 480

const tokenWeight = char => (char.codePointAt(0) > 0x7f ? 1 : 0.25)

export function estimateTokens(text) {
  let tokens = 0
  for (const char of String(text || '')) tokens += tokenWeight(char)
  return Math.ceil(tokens)
}

export function clampCommentary(text) {
  const value = String(text || '').trim()
  if (estimateTokens(value) <= COMMENTARY_MAX_TOKENS) return value
  let end = 0
  let tokens = 0
  for (const char of value) {
    tokens += tokenWeight(char)
    if (tokens > COMMENTARY_MAX_TOKENS - 1) break
    end += char.length
  }
  return `${value.slice(0, end)}…`
}

function backendItem(item) {
  if (item?.type === 'function_call_output') {
    return {
      type: 'function_call_output',
      call_id: String(item.call_id || ''),
      output: typeof item.output === 'string'
        ? item.output
        : JSON.stringify(item.output ?? ''),
    }
  }
  const text = textFromItem(item)
  if (!text) return null
  return messageItem(item.role === 'assistant' ? 'assistant' : 'user', text)
}

// Maps the full-duplex Live API, which has no response or turn boundaries, onto
// Gateway responses: each run of speech is a voice response, delegation the backend one.
export function createGptLive1Protocol({
  emit,
  send = null,
  outputIdleMs = GPT_LIVE_1_TIMING_DEFAULTS.outputIdleMs,
  wordGapMs = GPT_LIVE_1_TIMING_DEFAULTS.wordGapMs,
  inputSegmentGapMs = GPT_LIVE_1_TIMING_DEFAULTS.inputSegmentGapMs,
  inputIdleMs = GPT_LIVE_1_TIMING_DEFAULTS.inputIdleMs,
  onStartupError = null,
  standingInstructions = [],
} = {}) {
  let voiceResponseId = ''
  // Session-timeline start of the current or last answer (output audio is untimed).
  let answerStartMs = NaN
  // Whether an answer began since the current user item opened.
  let answeredSinceInput = false
  // The user interrupted the playing answer, which plays out: the model yields,
  // and only speech it had already generated follows.
  let yielding = false
  // An utterance began over an answer whose words have not come: their timing tells its question from a barge-in.
  let undecided = false
  let utteranceStartMs = NaN
  // A stop waits for the playing answer to play out; then the voice stays silent until the user's next input.
  let stopAfter = false
  let stopped = false
  // The model spoke while stopped and has not been quiet since: once the stop ends, that speech
  // plays on as an interrupted answer.
  let spokeWhileStopped = false
  // Session-timeline end of the model's last words.
  let lastCaptionEndMs = NaN
  // The current answer's transcript so far.
  let voiceTranscript = ''
  let inputItemId = ''
  let lastInputEndMs = -Infinity
  // The current utterance's fragments as delivered.
  let inputRaw = ''
  // Fresh fragments with no spoken word yet; they open a turn once a word arrives.
  let pendingInputRaw = ''
  // The user turn commits when the answer starts or input goes idle.
  let inputCommitted = false
  // Speak requests in flight: commentary event_id -> synthetic response id.
  const commentaryRequests = new Map()
  const standing = new Set(standingInstructions.map(text => String(text || '').trim()).filter(Boolean))
  // Set once session.started arrives; command errors before that fail startup.
  let started = false
  // The delegation block last sent, so session.update only goes out on change.
  let lastDelegationJson = ''
  // The session.start payload, for onStartupError.
  let lastStartSession = null
  // event_ids of our response commands: only their errors concern a response.
  const responseCommandIds = new Set()
  // Response ids the runtime has seen opened and not yet closed.
  const openResponses = new Set()
  // delegation_id -> running backend response (most nested events carry none).
  const delegationResponses = new Map()
  let backendResponseId = ''
  // Sent tool results -> call and next response.create, to replace a refused result once.
  const sentOutputs = new Map()
  let unpairedOutputs = []
  const replacedCalls = new Set()
  const replacements = new Set()
  const supersededRequests = new Set()

  const remember = (map, key, value, limit = 64) => {
    map.set(key, value)
    if (map.size > limit) map.delete(map.keys().next().value)
  }
  const rememberIn = (set, value, limit = 64) => {
    set.add(value)
    if (set.size > limit) set.delete(set.values().next().value)
  }

  const replaceRejectedOutput = clientEventId => {
    const sent = sentOutputs.get(clientEventId)
    if (!sent || replacedCalls.has(sent.callId) || typeof send !== 'function') return false
    sentOutputs.delete(clientEventId)
    rememberIn(replacedCalls, sent.callId)
    if (sent.continuation) rememberIn(supersededRequests, sent.continuation)
    queueMicrotask(() => send({
      type: 'response.item.create',
      item: { type: 'function_call_output', call_id: sent.callId, output: REJECTED_RESULT },
    }))
    return true
  }

  const trackResponses = normalized => {
    for (const event of [].concat(normalized ?? [])) {
      const responseId = event?.response?.id || event?.response_id
      if (!responseId) continue
      if (event.type === 'response.created') openResponses.add(responseId)
      else if (event.type === 'response.done' || event.type === 'error') openResponses.delete(responseId)
    }
    return normalized
  }

  // Re-armed on every fragment; fires once the service has been quiet.
  const idleTimer = (type, ms) => {
    let timer = null
    return {
      clear: () => clearTimeout(timer),
      arm: () => {
        if (typeof emit !== 'function' || !(ms > 0)) return
        clearTimeout(timer)
        timer = setTimeout(() => emit({ type }), ms)
        timer.unref?.()
      },
    }
  }
  const outputIdle = idleTimer(OUTPUT_IDLE_EVENT, outputIdleMs)
  const inputIdle = idleTimer(INPUT_IDLE_EVENT, inputIdleMs)

  const openVoiceResponse = (events, startMs = NaN) => {
    if (voiceResponseId) {
      if (!Number.isFinite(answerStartMs) && Number.isFinite(startMs)) answerStartMs = startMs
      return voiceResponseId
    }
    voiceResponseId = id('voice')
    voiceTranscript = ''
    answerStartMs = Number.isFinite(startMs) ? startMs : NaN
    answeredSinceInput = true
    // The model's own speech, never the answer to a queued Gateway request.
    events.push(responseCreated(voiceResponseId, { ...PLAYBACK, __voiceAutomatic: true }))
    return voiceResponseId
  }

  // Transcript first, as on GA. A stop waiting on the answer takes effect as it closes.
  const finishVoiceResponse = (events, status = 'completed') => {
    outputIdle.clear()
    if (!voiceResponseId) return events
    const transcript = voiceTranscript.trim()
    if (transcript) {
      events.push({
        type: 'response.output_audio_transcript.done',
        response_id: voiceResponseId,
        transcript,
      })
    }
    events.push(responseDone(voiceResponseId, status, PLAYBACK))
    if (stopAfter) stopped = true
    voiceResponseId = ''
    voiceTranscript = ''
    yielding = stopAfter = undecided = false
    return events
  }

  // A question whose words came after its answer began: from here on the answer is its reply,
  // unless an interruption already has it playing out.
  const answerLateQuestion = events => {
    commitInput(events)
    if (!yielding && !stopAfter) finishVoiceResponse(events)
  }

  // The user's next input ends a stop, and one still waiting on the playing answer.
  const resume = () => {
    stopped = stopAfter = false
  }

  // Speech under way when a stop ended plays on as an interrupted answer: it leaves
  // the user's turn to the reply, and closes as the model's next words begin.
  const resumeSpeech = () => {
    if (!spokeWhileStopped || voiceResponseId) return
    spokeWhileStopped = false
    yielding = true
  }

  // Energy of one PCM16 frame (little-endian samples in the base64 delta).
  const isSpeechFrame = delta => {
    const bytes = Buffer.from(String(delta || ''), 'base64')
    const samples = bytes.length >> 1
    if (!samples) return false
    let energy = 0
    for (let i = 0; i < samples; i++) {
      const sample = bytes.readInt16LE(i * 2)
      energy += sample * sample
    }
    return Math.sqrt(energy / samples) >= OUTPUT_SPEECH_RMS
  }

  // Ends the user's turn (GA order: speech_stopped, committed); the transcript
  // keeps streaming into the committed item.
  const commitInput = events => {
    if (!inputItemId || inputCommitted) return
    inputCommitted = true
    events.push({ type: 'input_audio_buffer.speech_stopped', item_id: inputItemId })
    events.push({ type: 'input_audio_buffer.committed', item_id: inputItemId })
  }

  const completeInput = events => {
    inputIdle.clear()
    if (!inputItemId) return events
    commitInput(events)
    events.push({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: inputItemId,
      transcript: userCaption(inputRaw).trim(),
    })
    inputItemId = ''
    inputRaw = ''
    inputCommitted = false
    return events
  }

  // A nested Responses event mapped onto the Gateway's response lifecycle.
  const normalizeBackendEvent = (nested, delegationId) => {
    const nestedId = nested?.response?.id || ''
    if (nestedId && delegationId) delegationResponses.set(delegationId, nestedId)
    const responseId = nestedId || delegationResponses.get(delegationId) || delegationId || backendResponseId
    switch (nested?.type) {
      case 'response.created':
      case 'response.in_progress':
        backendResponseId = responseId
        // A response continued after tool results may resume with in_progress only.
        if (nested.type === 'response.in_progress' && openResponses.has(responseId)) return []
        return [responseCreated(responseId)]
      // Calls come from output_item.done; arguments-done alone identifies none.
      case 'response.output_item.done': {
        const item = nested.item || {}
        if (item.type !== 'function_call') return []
        return [{
          type: 'response.function_call_arguments.done',
          response_id: responseId,
          call_id: item.call_id || '',
          name: item.name || '',
          arguments: item.arguments || '{}',
        }]
      }
      case 'response.completed':
      case 'response.incomplete':
        delegationResponses.delete(delegationId)
        return [responseDone(responseId, nested.type === 'response.incomplete' ? 'incomplete' : (nested.response?.status || 'completed'))]
      case 'response.failed':
      case 'error':
        delegationResponses.delete(delegationId)
        // Named, so the runtime releases this response and no other.
        return [{
          type: 'error',
          error: nested.error || nested.response?.error || { message: 'GPT-Live 1 backend response failed' },
          response_id: responseId,
        }]
      // Backend text and reasoning are not spoken; the voice layer speaks.
      default:
        return []
    }
  }

  // Only a rejected response command concerns the request waiting on it; any
  // other error gets its own id and settles nothing else.
  const commandError = (error, clientEventId, eventId) => {
    if (!started || (clientEventId && responseCommandIds.has(clientEventId))) return { type: 'error', error }
    return { type: 'error', error, response_id: `gpt-live-1:command:${clientEventId || eventId || id('error')}` }
  }

  const normalizeEvent = event => {
    switch (event?.type) {
      case 'session.started':
        started = true
        return { type: 'session.created', session: { id: event.session?.id || null } }

      // Acknowledgements only.
      case 'session.updated':
      case 'session.usage.updated':
      case 'session.thinking.appended':
      case 'session.instructions.appended':
      case 'session.input_audio.muted':
      case 'session.input_audio.unmuted':
        return []

      case 'session.output_audio.delta': {
        const events = []
        const speech = isSpeechFrame(event.delta)
        // Silence between answers is not output; inside an answer it is a pause that plays through.
        if (!speech && !voiceResponseId) return events
        if (stopped) {
          if (speech) {
            spokeWhileStopped = true
            outputIdle.arm()
            // Silent, yet the model answered: the user's next words start a turn.
            if (!answeredSinceInput) {
              answeredSinceInput = true
              answerStartMs = NaN
            }
          }
          return events
        }
        resumeSpeech()
        // An answer starting ends the user's turn; one playing out after an
        // interruption, or not yet known to answer it, leaves it to the reply.
        if (speech && !yielding && !undecided) commitInput(events)
        const responseId = openVoiceResponse(events)
        events.push({
          type: 'response.output_audio.delta',
          response_id: responseId,
          delta: event.delta || '',
        })
        if (speech) outputIdle.arm()
        return events
      }

      // The ack is the last signal tied to a speak request: settle it here.
      case 'session.commentary.appended': {
        const clientEventId = String(event.client_event_id || '')
        const sayId = commentaryRequests.get(clientEventId)
        if (!sayId) return []
        commentaryRequests.delete(clientEventId)
        return [
          responseCreated(sayId, PLAYBACK),
          responseDone(sayId, 'completed', PLAYBACK),
        ]
      }

      case 'session.output_transcript.delta': {
        const events = []
        const fragment = String(event.delta || '')
        const startMs = Number(event.start_ms)
        const afterPause = Number.isFinite(startMs) && !(startMs - lastCaptionEndMs < wordGapMs)
        lastCaptionEndMs = Number.isFinite(Number(event.end_ms)) ? Number(event.end_ms) : startMs
        // The answer's first words date it: an utterance begun over it before them is its question.
        if (undecided && voiceResponseId && !hasWords(voiceTranscript) && hasWords(fragment)) {
          undecided = false
          // Words the service did not time cannot tell: the answer replies to the utterance.
          if (!(utteranceStartMs >= startMs)) answerLateQuestion(events)
          else yielding = true
        }
        // After a spoken or typed interruption, words after a pause in the playing
        // answer's words are the model's next answer, and that one closes; words
        // running on are its own. A stopped answer plays out until the model is quiet.
        if (yielding && !stopAfter && voiceTranscript.trim() && afterPause && hasWords(fragment)) finishVoiceResponse(events)
        // After a stop, nothing the model says shows until the stop ends.
        if (stopped) {
          if (hasWords(fragment)) spokeWhileStopped = true
          outputIdle.arm()
          return events
        }
        // No answer begins with the previous one's closing punctuation.
        const delta = voiceTranscript.trim() ? fragment : fragment.replace(LEADING_PUNCTUATION_RE, '')
        if (!delta) return events
        resumeSpeech()
        if (!yielding && !undecided) commitInput(events)
        const responseId = openVoiceResponse(events, startMs)
        voiceTranscript += delta
        events.push({
          type: 'response.output_audio_transcript.delta',
          response_id: responseId,
          delta,
        })
        outputIdle.arm()
        return events
      }

      case OUTPUT_IDLE_EVENT:
        spokeWhileStopped = false
        return finishVoiceResponse([])

      case 'session.input_transcript.delta': {
        const events = []
        const startMs = Number(event.start_ms)
        const endMs = Number(event.end_ms)
        // A timeline jump is fresh speech; a late fragment continuing it is not.
        const timelineGap = !Number.isFinite(lastInputEndMs)
          || !Number.isFinite(startMs)
          || startMs - lastInputEndMs > inputSegmentGapMs
        // Speech after the answer began is a barge-in; a late fragment from before it belongs to the question.
        const afterAnswer = Number.isFinite(answerStartMs) && Number.isFinite(startMs)
          ? startMs > answerStartMs
          : answeredSinceInput
        // Fresh speech begins an utterance after an answer began, or with none open.
        const freshTurn = timelineGap && (afterAnswer || !inputItemId)
        let fragment = String(event.delta || '')
        if (inputItemId && freshTurn) {
          // The punctuation after the pause closes this utterance.
          inputRaw += leadingPunctuation(fragment)
          completeInput(events)
        }
        if (Number.isFinite(endMs)) lastInputEndMs = Math.max(lastInputEndMs, endMs)
        else if (Number.isFinite(startMs)) lastInputEndMs = Math.max(lastInputEndMs, startMs)
        const continuesPending = Boolean(pendingInputRaw) && !timelineGap
        // Late words of a final utterance change nothing and start no turn.
        if (!inputItemId && !continuesPending && !freshTurn) return events
        // Any other words end a stop, even ones that continue the utterance.
        if (spokenInputText(fragment)) resume()
        // A question whose words all came after its answer began is already answered.
        let answered = false
        if (!inputItemId) {
          // Only fresh speech holding a word opens a turn.
          pendingInputRaw = (continuesPending ? pendingInputRaw : '') + fragment
          if (!spokenInputText(pendingInputRaw)) return events
          // Over an answer whose words have not come, they tell question from barge-in.
          undecided = Boolean(voiceResponseId) && !Number.isFinite(answerStartMs) && Number.isFinite(startMs)
          utteranceStartMs = startMs
          // A barge-in: the model hears it and yields, what it already said playing out.
          if (!undecided && afterAnswer && voiceResponseId) yielding = true
          answered = !undecided && !afterAnswer && answeredSinceInput
          inputItemId = id('input')
          inputRaw = ''
          inputCommitted = false
          answeredSinceInput = false
          fragment = pendingInputRaw
          pendingInputRaw = ''
          events.push({
            type: 'input_audio_buffer.speech_started',
            item_id: inputItemId,
          })
        }
        const shown = userCaption(inputRaw)
        inputRaw += fragment
        const caption = userCaption(inputRaw)
        // `text` is the whole caption so far, which the runtime shows live.
        events.push({
          type: 'conversation.item.input_audio_transcription.delta',
          item_id: inputItemId,
          delta: caption.startsWith(shown) ? caption.slice(shown.length) : fragment,
          text: caption,
        })
        inputIdle.arm()
        if (answered) answerLateQuestion(events)
        return events
      }

      case INPUT_IDLE_EVENT:
        return completeInput([])

      // The service took the user's turn: commit it before the backend response
      // opens, and bind the delegation to the response id that follows.
      case 'session.delegation.created': {
        const events = []
        commitInput(events)
        const delegation = event.delegation || {}
        if (delegation.id && delegation.response_id) {
          delegationResponses.set(delegation.id, delegation.response_id)
        }
        return events
      }

      case 'response.event':
        return normalizeBackendEvent(event.event, event.delegation_id)

      case 'session.closed': {
        const events = []
        pendingInputRaw = ''
        unpairedOutputs = []
        completeInput(events)
        // Closed for content (other moderation only cuts speech): the answer is
        // not kept, and the runtime recovers without reseeding that history.
        const content = String(event.reason || '') === 'content'
        finishVoiceResponse(events, content ? 'incomplete' : 'completed')
        if (content) {
          events.push({
            type: 'error',
            error: { type: 'session_closed', code: 'content', message: 'GPT-Live 1 session closed by the service for content' },
          })
        }
        return events
      }

      case 'error': {
        const error = event.error || { message: 'GPT-Live 1 error' }
        const clientEventId = String(error.client_event_id || '')
        if (!started) onStartupError?.(error, { session: lastStartSession })
        if (supersededRequests.delete(clientEventId)) {
          // The request a refused result held up: every call has a result now.
          queueMicrotask(() => send({ type: 'response.create' }, { correlate: false }))
          return []
        }
        if (replaceRejectedOutput(clientEventId)) return []
        if (replacements.delete(clientEventId)) {
          // Even the failure was refused: close for a fresh session.
          queueMicrotask(() => send({ type: 'session.close' }))
          return { type: 'error', error, response_id: `gpt-live-1:command:${clientEventId}` }
        }
        const sayId = commentaryRequests.get(clientEventId)
        if (sayId) {
          // A rejected commentary fails the speak request it belongs to.
          commentaryRequests.delete(clientEventId)
          return [
            responseCreated(sayId, PLAYBACK),
            { type: 'error', error, response_id: sayId },
          ]
        }
        return commandError(error, clientEventId, event.event_id)
      }

      default:
        return event
    }
  }

  return Object.freeze({
    encodeOutgoing: payload => {
      if (payload == null) return null
      const encoded = { event_id: id('event'), ...payload }
      const { type } = payload
      if (type === 'response.create' || type === 'response.item.create') rememberIn(responseCommandIds, encoded.event_id, 200)
      if (type === 'session.commentary.append') {
        remember(commentaryRequests, encoded.event_id, id('say'))
        resume()
      }
      if (type === 'response.item.create' && encoded.item?.type === 'function_call_output') {
        if (replacedCalls.has(encoded.item.call_id)) rememberIn(replacements, encoded.event_id)
        else {
          remember(sentOutputs, encoded.event_id, { callId: encoded.item.call_id, continuation: '' })
          unpairedOutputs = [...unpairedOutputs, encoded.event_id].slice(-64)
        }
      }
      if (type === 'response.create') {
        for (const itemEventId of unpairedOutputs) {
          const sent = sentOutputs.get(itemEventId)
          if (sent) sent.continuation = encoded.event_id
        }
        unpairedOutputs = []
      }
      return encoded
    },

    normalizeIncoming: event => {
      // The runtime's private markers (__voicePlayback, ...) are set by this adapter only.
      for (const key of Object.keys(event ?? {})) if (key.startsWith('__')) delete event[key]
      return trackResponses(normalizeEvent(event))
    },

    // Sent before encodeOutgoing applies, so the id is stamped here.
    connectionMessages: ({ session }) => {
      lastStartSession = session ?? null
      lastDelegationJson = JSON.stringify(session?.delegation ?? null)
      return [{ type: 'session.start', event_id: id('event'), session }]
    },

    // Only the delegation block may change after startup: sent whole, on change.
    sessionUpdate: session => {
      const delegation = session?.delegation
      if (!delegation || delegation.type !== 'responses') return null
      const json = JSON.stringify(delegation)
      if (json === lastDelegationJson) return null
      lastDelegationJson = json
      return { type: 'session.update', session: { delegation } }
    },

    sessionClose: () => ({ type: 'session.close' }),

    audioAppend: audio => ({ type: 'session.input_audio.append', audio }),

    inputMute: () => ({ type: 'session.input_audio.mute' }),
    inputUnmute: () => ({ type: 'session.input_audio.unmute' }),

    imageAppend: () => null,

    conversationItemId: () => id('item'),

    // Everything the Gateway adds goes to the backend as Responses input.
    conversationItemCreate: item => {
      const backend = backendItem(item)
      return backend ? { type: 'response.item.create', item: backend } : null
    },

    // response.create carries no instructions: they go first as an item.
    responseInstructionsItem: response => {
      // The Live API has no per-request tool_choice: state it instead.
      const instructions = [
        String(response?.instructions || '').trim(),
        response?.tool_choice === 'none' ? 'Do not call any tool in this response.' : '',
      ].filter(Boolean).join(' ')
      // Instructions already in the backend prompt are not repeated.
      if (!instructions || response?.__liveSay || standing.has(instructions)) return null
      return messageItem('user', instructions)
    },

    // A speak payload becomes a commentary append; anything else runs or
    // continues the backend response. An announcement ends a stop; tool results do not.
    responseCreate: response => {
      const say = clampCommentary(response?.__liveSay)
      if (say) {
        return { type: 'session.commentary.append', delegation_id: null, content: say }
      }
      if (response?.__liveAnnounce) resume()
      return { type: 'response.create' }
    },

    correlateResponseCreate: payload => payload,
    responseCorrelationId: () => '',

    // The Live API has no response cancel; backend responses keep running.
    responseCancel: () => null,

    // Every interruption lets the playing answer play out: the model yields, and
    // only speech it had already generated follows. The model hears a spoken
    // barge-in; typed input and a stop tell it to stop speaking. After a stop the
    // voice stays silent until user input, an announcement or a commentary.
    interruptPlayback: ({ stop = false, speech = false } = {}) => {
      // The adapter saw the barge-in itself and let the answer play out.
      if (speech && !stop) return null
      const playing = Boolean(voiceResponseId)
      if (playing) yielding = true
      if (stop) {
        if (playing) stopAfter = true
        else stopped = true
        return STOP_SPEAKING
      }
      // Typed input over speech, heard or kept silent by a stop, stops it too.
      const speaking = playing || spokeWhileStopped
      resume()
      return speaking ? STOP_SPEAKING : null
    },

    userTextItem: text => messageItem('user', text),

    functionOutputItem: (callId, output) => ({
      type: 'function_call_output',
      call_id: callId,
      output: JSON.stringify(output),
    }),
  })
}
