import { randomUUID } from 'node:crypto'

function id(prefix) {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`
}

function eventId() {
  return `event_${randomUUID().replaceAll('-', '')}`
}

function textFromItem(item) {
  return (Array.isArray(item?.content) ? item.content : [])
    .map(part => String(part?.text || '').trim())
    .filter(Boolean)
    .join('\n')
    .trim()
}

// A transport that timestamps output audio segments a new spoken response when
// the start jumps past the previous end by more than this. The OpenAI Live wire
// sends untimed audio, so there segmentation comes from speech energy and the
// idle timer alone.
const OUTPUT_SEGMENT_GAP_MS = 1500
// After a barge-in the model keeps speaking for a moment before it yields. The
// runtime has already muted that answer, so its remaining words stay on it and
// it closes as cancelled at the first silence frame. Speech that carries on past
// this window was never interrupted (the user only talked over it): that answer
// completes and the speech continues, audibly, as a new one.
const BARGE_IN_YIELD_MS = 1000
// Transcript fragments trail the audio they describe (measured 200–400 ms). A
// fragment arriving this soon after an answer closed, with no answer open,
// describes the closed one and is dropped rather than opening a phantom answer.
const TRANSCRIPT_LAG_MS = 600
// Output audio streams continuously, including digital silence between answers
// (measured RMS 0–20 against the service; speech runs in the thousands). Frames
// below this RMS neither open a spoken segment nor keep one alive.
const OUTPUT_SPEECH_RMS = 100
// Input transcript fragments follow audio cadence and may lag the speech they
// describe, so utterance boundaries come from the session timeline: a fragment
// starting this long after the previous one ended is a new user utterance
// (synthesises speech_started / barge-in). A fragment that merely arrives late
// but continues the timeline belongs to the current utterance.
const INPUT_SEGMENT_GAP_MS = 1200
// With no input fragment for this long the user utterance is complete. The Live
// API emits no turn-complete event; session.delegation.created carries no turn
// boundary either (fragments keep arriving after it).
const DEFAULT_INPUT_IDLE_MS = 1500
const INPUT_IDLE_EVENT = 'gpt-live-1.input_idle'
// Both transcripts deliver a sentence's closing punctuation with the fragment
// after the pause, at the head of the next utterance or answer. Closing marks only.
const LEADING_PUNCTUATION_RE = /^[[\s\p{Pe}\p{Pf}\p{Po}]--[¡¿'"#%&*\/@\\]]+/v
// Speech arrives as words, so a bracketed span is an annotation such as
// "[clear throat]"; an unclosed one of that length waits for its close.
const NON_SPEECH_TAG_RE = /\[[^[\]]*\]/g
const OPEN_TAG_RE = /\[[^[\]]{0,24}$/

function leadingPunctuation(text) {
  return (String(text || '').match(LEADING_PUNCTUATION_RE)?.[0] || '').trim()
}

// The spoken words of a user utterance: annotations and the punctuation that
// belongs to the sentence before are not what the user said.
function spokenInputText(raw) {
  return String(raw || '')
    .replace(NON_SPEECH_TAG_RE, '')
    .replace(OPEN_TAG_RE, '')
    .replace(LEADING_PUNCTUATION_RE, '')
}
// With no speech frame or transcript fragment for this long the spoken segment
// is over (silence frames keep streaming and do not count). The Live API emits
// no turn-complete event, so this idle timer is what closes the segment.
export const DEFAULT_OUTPUT_IDLE_MS = 800
const OUTPUT_IDLE_EVENT = 'gpt-live-1.output_idle'
// The three append events accept at most 500 tokens. Estimate tokens
// conservatively (a CJK character is about one token, other text about four
// characters per token) and clamp below the limit rather than have the
// service reject the whole command.
const COMMENTARY_MAX_TOKENS = 480
const CJK = /[\u3000-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef\uac00-\ud7af]/

export function estimateTokens(text) {
  let tokens = 0
  let latin = 0
  for (const char of String(text || '')) {
    if (CJK.test(char)) tokens += 1
    else latin += 1
  }
  return tokens + Math.ceil(latin / 4)
}

export function clampCommentary(text) {
  const value = String(text || '').trim()
  if (estimateTokens(value) <= COMMENTARY_MAX_TOKENS) return value
  let end = 0
  let tokens = 0
  for (const char of value) {
    tokens += CJK.test(char) ? 1 : 0.25
    if (tokens > COMMENTARY_MAX_TOKENS - 1) break
    end += char.length
  }
  return `${value.slice(0, end)}…`
}

// The service caps the backend input history (every item appended with
// response.item.create) per session and reports the cap only by rejecting an
// item: "limited to 128 items and 32768 UTF-8 bytes per session". Measured
// against the service: the whole item JSON counts in raw UTF-8, a backend
// response does not release what it consumed, and session.input is separate.
const DEFAULT_BACKEND_INPUT_MAX_BYTES = 32768
const DEFAULT_BACKEND_INPUT_MAX_ITEMS = 128
// One item may take at most this share of what is left, so later results in
// the session still get a useful slice, but never less than the floor while
// that much remains.
const BACKEND_INPUT_ITEM_SHARE = 0.5
const BACKEND_INPUT_ITEM_FLOOR_BYTES = 2048
// Held back so every pending function call can still be answered, if only
// with a stub: a call left without output blocks response.create for good.
const BACKEND_INPUT_RESERVE_BYTES = 1024
const BACKEND_INPUT_MAX_HEALS = 3
const BACKEND_INPUT_FULL_HINT = 'GPT-Live 1 后端输入历史已达本会话上限，请重新连接开始新会话。'
const BACKEND_INPUT_LIMIT_PATTERN = /(\d+)\s+items?\s+and\s+(\d+)\s+UTF-8\s+bytes/i

export function utf8Bytes(value) {
  return Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8')
}

const truncationMark = totalBytes => `…[truncated; ${totalBytes} bytes in full]`

// Longest prefix of text within maxBytes of UTF-8 at a code-point boundary.
function utf8Prefix(text, maxBytes) {
  if (maxBytes <= 0) return ''
  if (utf8Bytes(text) <= maxBytes) return text
  let bytes = 0
  let end = 0
  for (const char of text) {
    const size = utf8Bytes(char)
    if (bytes + size > maxBytes) break
    bytes += size
    end += char.length
  }
  return text.slice(0, end)
}

// Longest string leaf of a JSON value. The item's own identity fields are
// never content; anything below them is.
const ITEM_IDENTITY_KEYS = new Set(['type', 'call_id', 'role', 'name', 'id'])

function longestStringLeaf(value, depth = 0, parent = null, key = null) {
  if (typeof value === 'string') return { parent, key, text: value, bytes: utf8Bytes(value) }
  if (!value || typeof value !== 'object') return null
  let best = null
  for (const [childKey, child] of Object.entries(value)) {
    if (depth === 0 && ITEM_IDENTITY_KEYS.has(childKey)) continue
    const leaf = longestStringLeaf(child, depth + 1, value, childKey)
    if (leaf && (!best || leaf.bytes > best.bytes)) best = leaf
  }
  return best
}

// Fits a Responses input item into maxBytes of item JSON. The item stays valid
// JSON, and so does a JSON-encoded tool output: its longest string leaves are
// cut first, so status fields survive and bulk content loses its tail. Returns
// null when nothing short of dropping the content would fit.
export function fitBackendItem(item, maxBytes) {
  if (utf8Bytes(item) <= maxBytes) return item
  const working = structuredClone(item)
  let decodedOutput = false
  if (typeof working.output === 'string') {
    try {
      const parsed = JSON.parse(working.output)
      if (parsed && typeof parsed === 'object') {
        working.output = parsed
        decodedOutput = true
      }
    } catch {
      // Plain-text output is cut as one string.
    }
  }
  const encode = value => (decodedOutput ? { ...value, output: JSON.stringify(value.output) } : value)
  // holder -> key -> full size, so a leaf carries one mark however often it is cut.
  const marks = new Map()
  for (let round = 0; round < 64; round++) {
    const encoded = encode(working)
    const excess = utf8Bytes(encoded) - maxBytes
    if (excess <= 0) return encoded
    const leaf = longestStringLeaf(working)
    if (!leaf?.parent) return null
    const totals = marks.get(leaf.parent) || new Map()
    const marked = totals.has(leaf.key)
    const total = marked ? totals.get(leaf.key) : leaf.bytes
    const mark = truncationMark(total)
    const body = marked ? leaf.text.slice(0, leaf.text.length - mark.length) : leaf.text
    if (!body) return null
    // Escaping and nesting only make a removed byte worth more, so cutting
    // `excess` raw bytes (plus the mark) removes at least `excess` from the item.
    const keep = utf8Bytes(body) - excess - (marked ? 0 : utf8Bytes(mark))
    leaf.parent[leaf.key] = `${utf8Prefix(body, keep)}${mark}`
    totals.set(leaf.key, total)
    marks.set(leaf.parent, totals)
  }
  return null
}

// A tool result that cannot fit even truncated still answers its call.
function stubOutputItem(item) {
  return {
    type: 'function_call_output',
    call_id: item.call_id,
    output: JSON.stringify({
      error: true,
      error_code: 'tool_result_too_large',
      message: 'Tool result dropped: it exceeds what is left of the GPT-Live 1 backend input budget for this session.',
      bytes: utf8Bytes(item),
    }),
  }
}

// Session ledger of backend input items. Charged on send, refunded when the
// service rejects an item, and re-capped from the service's own error text.
function createBackendInputLedger({ maxBytes, maxItems, itemMaxBytes }) {
  let usedBytes = 0
  let usedItems = 0
  return {
    learn(message) {
      const match = BACKEND_INPUT_LIMIT_PATTERN.exec(String(message || ''))
      if (!match) return false
      maxItems = Number(match[1])
      maxBytes = Number(match[2])
      return true
    },
    // Bytes the next item may take now.
    allowance() {
      if (usedItems >= maxItems) return 0
      const soft = maxBytes - usedBytes - BACKEND_INPUT_RESERVE_BYTES
      let bytes = Math.min(soft, Math.max(BACKEND_INPUT_ITEM_FLOOR_BYTES, Math.floor(soft * BACKEND_INPUT_ITEM_SHARE)))
      if (itemMaxBytes) bytes = Math.min(bytes, itemMaxBytes)
      return Math.max(0, bytes)
    },
    charge(bytes) {
      usedBytes += bytes
      usedItems += 1
    },
    refund(bytes) {
      usedBytes = Math.max(0, usedBytes - bytes)
      usedItems = Math.max(0, usedItems - 1)
    },
  }
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
  const role = item.role === 'assistant' ? 'assistant' : 'user'
  return {
    type: 'message',
    role,
    content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }],
  }
}

// Wire trace for integration debugging: event shapes, ids, codes and sizes.
// Conversation content (prompts, transcripts, tool output, audio) is replaced
// by its length so a trace never carries what was said or returned.
const TRACE_TEXT_KEYS = new Set([
  'audio', 'delta', 'text', 'transcript', 'instructions', 'output', 'content', 'arguments', 'description',
])
const TRACE_KEEP_KEYS = new Set([
  'type', 'event_id', 'client_event_id', 'id', 'call_id', 'name', 'model', 'code', 'param', 'status', 'role',
])
// Service messages may quote the offending input, so they are capped.
const TRACE_CAPPED_KEYS = new Set(['message', 'reason'])
const TRACE_MESSAGE_MAX_CHARS = 200

function traceValue(value, key = '') {
  if (typeof value === 'string') {
    if (TRACE_CAPPED_KEYS.has(key)) {
      return value.length > TRACE_MESSAGE_MAX_CHARS
        ? `${value.slice(0, TRACE_MESSAGE_MAX_CHARS)}…<${value.length} chars>`
        : value
    }
    if (TRACE_KEEP_KEYS.has(key)) return value
    return TRACE_TEXT_KEYS.has(key) || value.length > 80 ? `<${value.length} chars>` : value
  }
  if (Array.isArray(value)) return value.map(entry => traceValue(entry, key))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, traceValue(child, childKey)]))
  }
  return value
}

function traceLine(direction, event) {
  return `gpt-live-1 ${direction} ${JSON.stringify(traceValue(event))}\n`
}

/**
 * Stateful adapter between the Gateway's turn-based realtime lifecycle and
 * OpenAI's full-duplex GPT-Live 1 Live API.
 *
 * The Live API has no response.created / response.done boundaries: the voice
 * layer streams session.output_audio.delta continuously, and reasoning runs in
 * a separate Responses stream delivered inside response.event envelopes. This
 * adapter reconstructs two independent response lifecycles the Gateway can
 * consume:
 *   - a synthesised "voice" response bracketing a contiguous run of speech
 *     (the audio stream carries digital silence between answers), closed
 *     once output goes idle; a barge-in marks it interrupted;
 *   - the delegated "backend" response taken verbatim from the Responses events
 *     inside response.event, which carries the function-call loop.
 *
 * Turn segmentation and input speech events are heuristic (the Live API emits
 * no VAD or turn-complete events); the deterministic mappings — session start,
 * audio append, output audio, transcripts, the function-call loop and close —
 * are exercised by the provider tests.
 */
export function createGptLive1Protocol({
  emit,
  send = null,
  trace = null,
  outputIdleMs = DEFAULT_OUTPUT_IDLE_MS,
  inputIdleMs = DEFAULT_INPUT_IDLE_MS,
  bargeInYieldMs = BARGE_IN_YIELD_MS,
  now = () => performance.now(),
  itemMaxBytes,
  backendInputMaxBytes = DEFAULT_BACKEND_INPUT_MAX_BYTES,
  backendInputMaxItems = DEFAULT_BACKEND_INPUT_MAX_ITEMS,
  onStartupError = null,
  standingInstructions = [],
} = {}) {
  let voiceResponseId = ''
  // When the current or last spoken answer began on the session timeline. The
  // OpenAI primary WebSocket sends audio without timing, so this also comes
  // from output transcript deltas; NaN until either arrives.
  let answerStartMs = NaN
  // Whether an answer began since the current user item opened: the turn
  // test for transports that never send output timing.
  let answeredSinceInput = false
  // When the user started speaking over the current answer (or the Gateway
  // cancelled it); NaN until then. The runtime has already muted that answer.
  // An explicit Gateway cancel keeps it muted until the model pauses.
  let interruptedAt = NaN
  let explicitCancel = false
  // The current answer's transcript so far, and when the last answer closed.
  let voiceTranscript = ''
  let lastFinishAt = -Infinity
  let lastOutputEndMs = -Infinity
  let outputIdleTimer = null
  let inputItemId = ''
  let lastInputEndMs = -Infinity
  // The current utterance's fragments as delivered, and its spoken words.
  let inputRaw = ''
  let inputTranscript = ''
  // Fragments of fresh speech that hold no spoken word yet (an annotation or a
  // stray closing punctuation); they open a turn only once a word arrives.
  let pendingInputRaw = ''
  let inputIdleTimer = null
  // The user turn is committed (speech_stopped + committed) once the assistant
  // starts answering or input goes idle; the transcript may still be completing.
  let inputCommitted = false
  // The most recent completed user item. A late fragment that continues its
  // timeline reopens it silently, growing the caption without a new turn.
  let lastInput = null
  let inputCompletedOnce = false
  // Speak requests in flight: commentary event_id -> synthetic response id.
  const commentaryRequests = new Map()
  const standing = new Set(standingInstructions.map(text => String(text || '').trim()).filter(Boolean))
  // Set once session.started arrives; command errors before that fail startup.
  let started = false
  // The delegation block last sent, so session.update only goes out on change.
  let lastDelegationJson = ''
  // The session sent with session.start, handed to onStartupError so the
  // provider knows which seeded history the service refused.
  let lastStartSession = null
  // event_ids of response.create / response.item.create we sent: an error
  // correlated to one of them concerns the backend response; any other
  // command error (an append, a mute) must not be charged to it.
  const responseCommandIds = new Set()
  // Response ids the runtime has seen opened and not yet closed.
  const openResponses = new Set()
  // delegation_id -> the backend response id currently running under it. Most
  // nested Responses events carry no response object, so the lifecycle would
  // otherwise split between the delegation id and the response id, and a tool
  // batch keyed by one would never see the other's response.done.
  const delegationResponses = new Map()
  const ledger = createBackendInputLedger({
    maxBytes: backendInputMaxBytes,
    maxItems: backendInputMaxItems,
    itemMaxBytes,
  })
  // event_id -> what response.item.create sent, and the response.create that
  // followed it, so a rejection can be answered and that request re-issued.
  const sentItems = new Map()
  let pendingBatch = []
  // call_id -> the unfitted tool result, refit smaller if the service rejects.
  const originals = new Map()
  const healAttempts = new Map()
  // event_ids of response.create requests a heal superseded: their
  // "outputs required" error is expected and must not fail the turn.
  const swallowedErrors = new Set()

  const remember = (map, key, value, limit = 64) => {
    map.set(key, value)
    if (map.size > limit) map.delete(map.keys().next().value)
  }
  const rememberIn = (set, value, limit = 64) => {
    set.add(value)
    if (set.size > limit) set.delete(set.values().next().value)
  }

  // Fits an outgoing backend item into the session budget. A tool result that
  // cannot fit even truncated becomes a stub so its call is answered; other
  // items are dropped once the budget is gone.
  const fitToBudget = (item, allowance = ledger.allowance()) => {
    const fitted = fitBackendItem(item, allowance)
    if (fitted) return fitted
    return item.type === 'function_call_output' ? stubOutputItem(item) : null
  }

  // The service rejected an item for the session budget: take back its ledger
  // charge, learn the cap the message states, and answer a pending tool call
  // again with a smaller result, since an unanswered call blocks response.create.
  const healRejectedItem = (clientEventId, error) => {
    ledger.learn(error.message)
    const sent = sentItems.get(clientEventId)
    if (!sent) return false
    sentItems.delete(clientEventId)
    ledger.refund(sent.bytes)
    const { item } = sent
    if (item?.type !== 'function_call_output' || typeof send !== 'function') return false
    const attempts = (healAttempts.get(item.call_id) || 0) + 1
    if (attempts > BACKEND_INPUT_MAX_HEALS) return false
    remember(healAttempts, item.call_id, attempts)
    // The service may hold more than the ledger knows, so back off from what
    // the rejected attempt used rather than trusting the allowance alone.
    const allowance = Math.min(ledger.allowance(), Math.floor(sent.bytes / 2))
    const retry = fitToBudget(originals.get(item.call_id) || item, allowance)
    if (sent.responseCreateId) rememberIn(swallowedErrors, sent.responseCreateId)
    queueMicrotask(() => {
      send({ type: 'response.item.create', item: retry })
      // The re-request continues the tool result, not the newest Gateway request.
      if (sent.responseCreateId) send({ type: 'response.create' }, { correlate: false })
    })
    return true
  }

  const trackResponses = normalized => {
    for (const event of [].concat(normalized ?? [])) {
      const responseId = event?.response?.id || event?.response_id
      if (!responseId) continue
      if (event.type === 'response.created') {
        openResponses.add(responseId)
      } else if (['response.done', 'response.cancelled', 'response.canceled', 'error'].includes(event.type)) {
        openResponses.delete(responseId)
      }
    }
    return normalized
  }

  const clearOutputIdle = () => {
    clearTimeout(outputIdleTimer)
    outputIdleTimer = null
  }

  // Re-armed on every output fragment; fires once the service has been quiet.
  // Without an emit hook (bare protocol tests) segmentation falls back to the
  // timeline gap and barge-in triggers alone.
  const armOutputIdle = () => {
    if (typeof emit !== 'function' || !(outputIdleMs > 0)) return
    clearOutputIdle()
    outputIdleTimer = setTimeout(() => {
      outputIdleTimer = null
      emit({ type: OUTPUT_IDLE_EVENT })
    }, outputIdleMs)
    outputIdleTimer.unref?.()
  }

  const clearInputIdle = () => {
    clearTimeout(inputIdleTimer)
    inputIdleTimer = null
  }

  const armInputIdle = () => {
    if (typeof emit !== 'function' || !(inputIdleMs > 0)) return
    clearInputIdle()
    inputIdleTimer = setTimeout(() => {
      inputIdleTimer = null
      emit({ type: INPUT_IDLE_EVENT })
    }, inputIdleMs)
    inputIdleTimer.unref?.()
  }

  const openVoiceResponse = (events, startMs = NaN) => {
    if (voiceResponseId) {
      if (!Number.isFinite(answerStartMs) && Number.isFinite(startMs)) answerStartMs = startMs
      return voiceResponseId
    }
    voiceResponseId = id('voice')
    voiceTranscript = ''
    answerStartMs = Number.isFinite(startMs) ? startMs : NaN
    answeredSinceInput = true
    // __voiceAutomatic: the model's own speech, never the answer to a queued
    // Gateway request (that arrives as the backend response).
    events.push({
      type: 'response.created',
      response: { id: voiceResponseId, status: 'in_progress' },
      response_id: voiceResponseId,
      __voicePlayback: true,
      __voiceAutomatic: true,
    })
    return voiceResponseId
  }

  // The transcript completes first, as on GA: the runtime records the assistant
  // turn from it. An interrupted answer closes as cancelled.
  const finishVoiceResponse = (events, status = '') => {
    clearOutputIdle()
    if (!voiceResponseId) return
    const transcript = voiceTranscript.trim()
    if (transcript) {
      events.push({
        type: 'response.output_audio_transcript.done',
        response_id: voiceResponseId,
        transcript,
      })
    }
    events.push({
      type: 'response.done',
      response: {
        id: voiceResponseId,
        status: status || (Number.isFinite(interruptedAt) ? 'cancelled' : 'completed'),
      },
      response_id: voiceResponseId,
      __voicePlayback: true,
    })
    // A late fragment can trail only an answer that spoke words or was muted;
    // one that closed without a transcript is not what the fragment belongs to.
    lastFinishAt = transcript || Number.isFinite(interruptedAt) ? now() : -Infinity
    voiceResponseId = ''
    voiceTranscript = ''
    lastOutputEndMs = -Infinity
    interruptedAt = NaN
    explicitCancel = false
  }

  // The user started speaking over the answer, or the Gateway cancelled it.
  // The runtime mutes that answer itself; here it stays open for the words the
  // model still says and closes when the model yields.
  const markInterrupted = () => {
    if (voiceResponseId && !Number.isFinite(interruptedAt)) interruptedAt = now()
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

  // Ends the user's turn in the runtime's model (GA order: speech_stopped,
  // committed, then the response). The transcript keeps streaming into the
  // committed item until it completes, exactly as GA transcription arrives late.
  const commitInput = events => {
    if (!inputItemId || inputCommitted) return
    inputCommitted = true
    events.push({ type: 'input_audio_buffer.speech_stopped', item_id: inputItemId })
    events.push({ type: 'input_audio_buffer.committed', item_id: inputItemId })
  }

  const completeInput = events => {
    clearInputIdle()
    if (!inputItemId) return
    commitInput(events)
    inputTranscript = spokenInputText(inputRaw)
    if (!inputCompletedOnce) {
      events.push({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: inputItemId,
        transcript: inputTranscript.trim(),
      })
    }
    lastInput = { id: inputItemId, raw: inputRaw }
    inputItemId = ''
    inputRaw = ''
    inputTranscript = ''
    inputCommitted = false
    inputCompletedOnce = false
  }

  // A nested Responses event (unwrapped from a response.event envelope) mapped
  // onto the Gateway's response lifecycle. The backend response id comes from
  // the Responses stream itself, so it never collides with the voice response.
  const normalizeBackendEvent = (nested, delegationId) => {
    const nestedId = nested?.response?.id || ''
    if (nestedId && delegationId) delegationResponses.set(delegationId, nestedId)
    const responseId = nestedId || delegationResponses.get(delegationId) || delegationId || ''
    switch (nested?.type) {
      case 'response.created':
      case 'response.in_progress':
        // A response continued after tool results may resume with in_progress
        // and no created event; open it then, once.
        if (nested.type === 'response.in_progress' && openResponses.has(responseId)) return []
        return [{
          type: 'response.created',
          response: { id: responseId, status: 'in_progress' },
          response_id: responseId,
        }]
      case 'response.function_call_arguments.done':
        // The authoritative function call is response.output_item.done, which
        // carries call_id/name. The arguments-done twin has no call_id in the
        // Responses stream, so a bare one here is that duplicate: drop it.
        if (!nested.call_id) return []
        return [{
          type: 'response.function_call_arguments.done',
          response_id: responseId,
          call_id: nested.call_id,
          name: nested.name || '',
          arguments: nested.arguments || '{}',
        }]
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
      case 'response.done':
      case 'response.incomplete':
        delegationResponses.delete(delegationId)
        return [{
          type: 'response.done',
          response: {
            id: responseId,
            status: nested.type === 'response.incomplete' ? 'incomplete' : (nested.response?.status || 'completed'),
          },
          response_id: responseId,
        }]
      case 'response.failed':
      case 'error':
        delegationResponses.delete(delegationId)
        // With the id the runtime releases this response; without it the
        // failure would be charged to the sole waiter, or to nothing, and the
        // backend id would gate every later Gateway request for good.
        return [{
          type: 'error',
          error: nested.error || nested.response?.error || { message: 'GPT-Live 1 backend response failed' },
          response_id: responseId,
        }]
      // Backend text/reasoning deltas are not spoken directly; the voice layer
      // speaks. They carry no user-facing audio, so drop them.
      default:
        return []
    }
  }

  // A rejected append/mute/update is not the failure of the backend response
  // that happens to be running; give it its own id so the runtime does not
  // settle the sole active response with it.
  const commandError = (error, clientEventId) => {
    const unrelated = started && clientEventId && !responseCommandIds.has(clientEventId)
    return unrelated
      ? { type: 'error', error, response_id: `gpt-live-1:command:${clientEventId}` }
      : { type: 'error', error }
  }

  const normalizeEvent = event => {
    switch (event?.type) {
      case 'session.started':
        started = true
        return { type: 'session.created', session: { id: event.session?.id || null } }

      // session.update acks carry nothing the runtime needs; usage and the
      // other appends are acknowledgements only.
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
        // Silence between answers is not output. Inside an answer it is a
        // pause that plays through; after a barge-in it is the model yielding.
        if (!speech && !voiceResponseId) return events
        if (!speech && Number.isFinite(interruptedAt)) {
          finishVoiceResponse(events, 'cancelled')
          return events
        }
        // The model talked straight through the user: not an interruption, and
        // the runtime muted that answer, so the speech carries on as a new one.
        // Not after an explicit Gateway cancel: the wire cannot stop the model,
        // and resuming it audibly would undo the user's stop.
        if (
          speech
          && Number.isFinite(interruptedAt)
          && !explicitCancel
          && now() - interruptedAt > bargeInYieldMs
        ) {
          finishVoiceResponse(events, 'completed')
        }
        const startMs = Number(event.start_ms)
        if (
          speech
          && voiceResponseId
          && Number.isFinite(startMs)
          && Number.isFinite(lastOutputEndMs)
          && startMs - lastOutputEndMs > OUTPUT_SEGMENT_GAP_MS
        ) {
          finishVoiceResponse(events)
        }
        // The assistant answering ends the user's turn; without this the
        // runtime treats the answer as talking over the user and mutes it.
        // What the model still says after a barge-in is not that answer.
        if (speech && !Number.isFinite(interruptedAt)) commitInput(events)
        const responseId = openVoiceResponse(events, startMs)
        if (Number.isFinite(event.end_ms)) lastOutputEndMs = Number(event.end_ms)
        events.push({
          type: 'response.output_audio.delta',
          response_id: responseId,
          delta: event.delta || '',
        })
        if (speech) armOutputIdle()
        return events
      }

      // The voice layer speaks commentary inside its current or next segment;
      // the acknowledgement is the only completion signal the wire offers, so
      // it settles the Gateway's speak request as a finished playback response.
      case 'session.commentary.appended': {
        const clientEventId = String(event.client_event_id || '')
        const sayId = commentaryRequests.get(clientEventId)
        if (!sayId) return []
        commentaryRequests.delete(clientEventId)
        return [
          { type: 'response.created', response: { id: sayId, status: 'in_progress' }, response_id: sayId, __voicePlayback: true },
          { type: 'response.done', response: { id: sayId, status: 'completed' }, response_id: sayId, __voicePlayback: true },
        ]
      }

      case 'session.output_transcript.delta': {
        const events = []
        // With no answer open, a fragment this soon trails the answer that
        // just closed (and was muted or recorded already).
        if (!voiceResponseId && now() - lastFinishAt < TRANSCRIPT_LAG_MS) return events
        // The punctuation that closed the previous answer arrives with the
        // first fragment of the next; no answer begins with it, or on it alone.
        const delta = voiceTranscript.trim()
          ? String(event.delta || '')
          : String(event.delta || '').replace(LEADING_PUNCTUATION_RE, '')
        if (!delta) return events
        if (!Number.isFinite(interruptedAt)) commitInput(events)
        const responseId = openVoiceResponse(events, Number(event.start_ms))
        voiceTranscript += delta
        events.push({
          type: 'response.output_audio_transcript.delta',
          response_id: responseId,
          delta,
        })
        armOutputIdle()
        return events
      }

      case OUTPUT_IDLE_EVENT: {
        const events = []
        finishVoiceResponse(events)
        return events
      }

      case 'session.input_transcript.delta': {
        const events = []
        const startMs = Number(event.start_ms)
        const endMs = Number(event.end_ms)
        // A timeline jump is fresh speech; a late fragment continuing the
        // timeline is not, even if the previous utterance was already closed.
        const timelineGap = !Number.isFinite(lastInputEndMs)
          || !Number.isFinite(startMs)
          || startMs - lastInputEndMs > INPUT_SEGMENT_GAP_MS
        // Transcripts lag the audio. Speech that began after the answer began
        // is a new turn (a barge-in while the answer still plays); a fragment
        // from before it belongs to the question, however late it arrives, and
        // must not start a turn: the runtime clears playback on speech_started.
        const afterAnswer = Number.isFinite(answerStartMs) && Number.isFinite(startMs)
          ? startMs > answerStartMs
          : answeredSinceInput
        const freshTurn = timelineGap && afterAnswer
        let fragment = String(event.delta || '')
        if (inputItemId && freshTurn) {
          // The closing punctuation delivered with the fragment after the
          // pause closes this utterance, not the next one.
          inputRaw += leadingPunctuation(fragment)
          completeInput(events)
        }
        if (Number.isFinite(endMs)) lastInputEndMs = Math.max(lastInputEndMs, endMs)
        else if (Number.isFinite(startMs)) lastInputEndMs = Math.max(lastInputEndMs, startMs)
        const continuesPending = Boolean(pendingInputRaw) && !timelineGap
        if (!inputItemId && !continuesPending && !freshTurn && lastInput) {
          // Reopen the previous utterance: its caption grows, no turn starts.
          inputItemId = lastInput.id
          inputRaw = lastInput.raw
          inputCommitted = true
          inputCompletedOnce = true
          pendingInputRaw = ''
        }
        if (!inputItemId) {
          // Fresh speech opens a turn once it holds a word; an annotation or a
          // stray closing punctuation alone never does and interrupts nothing.
          pendingInputRaw = (continuesPending ? pendingInputRaw : '') + fragment
          if (!spokenInputText(pendingInputRaw)) return events
          markInterrupted()
          inputItemId = id('input')
          inputRaw = ''
          inputCommitted = false
          inputCompletedOnce = false
          answeredSinceInput = false
          fragment = pendingInputRaw
          pendingInputRaw = ''
          events.push({
            type: 'input_audio_buffer.speech_started',
            item_id: inputItemId,
          })
        }
        const shown = spokenInputText(inputRaw)
        inputRaw += fragment
        inputTranscript = spokenInputText(inputRaw)
        // `text` is the transcript so far: the runtime shows it as the live
        // user caption, so a bare fragment would flash and vanish.
        events.push({
          type: 'conversation.item.input_audio_transcription.delta',
          item_id: inputItemId,
          delta: inputTranscript.startsWith(shown) ? inputTranscript.slice(shown.length) : fragment,
          text: inputTranscript,
        })
        armInputIdle()
        return events
      }

      case INPUT_IDLE_EVENT: {
        const events = []
        completeInput(events)
        return events
      }

      // The Responses lifecycle arrives in response.event. The delegation record
      // means the service took the user's turn: commit it here, before the
      // backend response opens, so that response and its tool calls carry this
      // turn (transcript fragments keep flowing into the committed item). It
      // also binds the delegation to the response id that follows.
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
        pendingBatch = []
        completeInput(events)
        finishVoiceResponse(events)
        // A safety termination must reach the runtime as a content-safety
        // error, or the reconnect would reseed the same history and repeat it.
        if (String(event.reason || '') === 'content') {
          events.push({
            type: 'error',
            error: { type: 'session_closed', code: 'content', message: 'GPT-Live 1 session closed by the service: content policy' },
          })
        }
        return events
      }

      case 'error': {
        const error = event.error || { message: 'GPT-Live 1 error' }
        const clientEventId = String(error.client_event_id || '')
        if (!started && typeof onStartupError === 'function') onStartupError(error, { session: lastStartSession })
        if (swallowedErrors.delete(clientEventId)) return []
        const sayId = commentaryRequests.get(clientEventId)
        if (sayId) {
          // A rejected commentary fails the speak request it belongs to.
          commentaryRequests.delete(clientEventId)
          return [
            { type: 'response.created', response: { id: sayId, status: 'in_progress' }, response_id: sayId, __voicePlayback: true },
            { type: 'error', error, response_id: sayId },
          ]
        }
        if (error.code === 'response_input_buffer_full') {
          if (healRejectedItem(clientEventId, error)) return []
          // The user sees the hint; the service's own wording stays for logs.
          return commandError({
            ...error,
            message: BACKEND_INPUT_FULL_HINT,
            service_message: error.message || '',
          }, clientEventId)
        }
        return commandError(error, clientEventId)
      }

      default:
        return event
    }
  }

  return Object.freeze({
    encodeOutgoing: payload => {
      if (payload == null) return null
      const encoded = { event_id: eventId(), ...payload }
      if (payload.type === 'response.create' || payload.type === 'response.item.create') {
        responseCommandIds.add(encoded.event_id)
        if (responseCommandIds.size > 200) responseCommandIds.delete(responseCommandIds.values().next().value)
      }
      if (payload.type === 'session.commentary.append') remember(commentaryRequests, encoded.event_id, id('say'))
      if (payload.type === 'response.item.create') {
        const bytes = utf8Bytes(encoded.item)
        ledger.charge(bytes)
        remember(sentItems, encoded.event_id, { item: encoded.item, bytes, responseCreateId: '' })
        pendingBatch.push(encoded.event_id)
        if (pendingBatch.length > 64) pendingBatch.shift()
      } else if (payload.type === 'response.create') {
        for (const itemEventId of pendingBatch) {
          const sent = sentItems.get(itemEventId)
          if (sent) sent.responseCreateId = encoded.event_id
        }
        pendingBatch = []
      }
      if (trace && payload.type !== 'session.input_audio.append') trace(traceLine('>>', encoded))
      return encoded
    },

    normalizeIncoming: event => {
      if (trace && event?.type !== 'session.output_audio.delta') trace(traceLine('<<', event))
      // The runtime's private markers (__voicePlayback, ...) are set by this adapter only.
      for (const key of Object.keys(event ?? {})) if (key.startsWith('__')) delete event[key]
      return trackResponses(normalizeEvent(event))
    },

    // Sent on the raw socket before encodeOutgoing applies, so stamp the id here;
    // a startup error echoes it as error.client_event_id.
    connectionMessages: ({ session }) => {
      lastStartSession = session ?? null
      lastDelegationJson = JSON.stringify(session?.delegation ?? null)
      const start = { type: 'session.start', event_id: eventId(), session }
      if (trace) trace(traceLine('>>', start))
      return [start]
    },

    // Only delegation.responses may change after startup (tools, backend
    // prompt). Send the complete delegation block, and only when it differs
    // from what the service already has; start-time fields are never resent.
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
    clearImageBuffer: () => {},

    conversationItemId: () => id('item'),

    // Tool results, typed text, injected results and permission requests all go
    // to the delegated backend as Responses input items.
    conversationItemCreate: item => {
      const backend = backendItem(item)
      if (!backend) return null
      if (backend.type === 'function_call_output' && backend.call_id) remember(originals, backend.call_id, backend)
      const fitted = fitToBudget(backend)
      if (!fitted) {
        if (typeof emit === 'function') {
          queueMicrotask(() => emit({
            type: 'error',
            error: { type: 'invalid_request_error', code: 'backend_input_budget_exhausted', message: BACKEND_INPUT_FULL_HINT },
          }))
        }
        return null
      }
      return { type: 'response.item.create', item: fitted }
    },

    // response.create carries no instructions in the Live API; the Gateway
    // creates this item first and then requests the response.
    responseInstructionsItem: response => {
      const instructions = String(response?.instructions || '').trim()
      // Instructions the provider already placed in the backend prompt are not
      // repeated as items: each item counts against the session budget.
      if (!instructions || response?.__liveSay || standing.has(instructions)) return null
      return {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: instructions }],
      }
    },

    // A buildSpeakResponse payload is spoken by the voice layer through a
    // commentary append; anything else runs or continues the backend response.
    responseCreate: response => {
      const say = clampCommentary(response?.__liveSay)
      if (say) {
        return { type: 'session.commentary.append', delegation_id: null, content: say }
      }
      return { type: 'response.create' }
    },

    correlateResponseCreate: payload => payload,
    responseCorrelationId: () => '',

    // The Live model owns turn-taking and barge-in; there is no client cancel.
    // A Gateway cancel marks the playing answer interrupted: the runtime has
    // muted it, and the record closes as cancelled at the model's next pause.
    // Backend responses keep running as they do on the service.
    responseCancel: () => {
      if (voiceResponseId && !Number.isFinite(interruptedAt)) explicitCancel = true
      markInterrupted()
      return null
    },

    userTextItem: text => ({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text }],
    }),

    functionOutputItem: (callId, output) => ({
      type: 'function_call_output',
      call_id: callId,
      output: JSON.stringify(output),
    }),
  })
}
