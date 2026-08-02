import { randomUUID } from 'node:crypto'

function eventId() {
  return `event_${randomUUID().replaceAll('-', '')}`
}

// The GA dialect names response payload modalities output_modalities. Shared
// frontend call sites still pass the beta modalities field, so the rewrite
// happens here once instead of leaking into every caller.
function gaResponse(response) {
  if (!response) return response
  const { modalities, ...rest } = response
  return modalities ? { ...rest, output_modalities: modalities } : rest
}

// The GA dialect derives a conversation item's id namespace from its type and
// rejects ids from the wrong namespace outright ("ID must start with 'fco_'").
// Items of an unlisted type keep the generic namespace.
const ID_PREFIXES = Object.freeze({
  message: 'msg',
  function_call: 'fc',
  function_call_output: 'fco',
})

const RESPONSE_CORRELATION_KEY = 'qwen_audio_request_id'

/**
 * Wire adapter for providers that speak the GA (2025+) dialect of the OpenAI
 * Realtime protocol, e.g. huggingface/speech-to-speech. Differences from the
 * beta dialect are confined to this file:
 *
 * - response payloads use output_modalities instead of modalities;
 * - text deltas arrive as response.output_text.* instead of response.text.*;
 * - conversation item ids are namespaced per item type.
 */
export const gaRealtimeProtocol = Object.freeze({
  encodeOutgoing: payload => ({
    event_id: eventId(),
    ...payload,
  }),

  normalizeIncoming: event => {
    switch (event?.type) {
      case 'response.output_text.delta':
        return { ...event, type: 'response.text.delta' }
      case 'response.output_text.done':
        return { ...event, type: 'response.text.done' }
      default:
        return event
    }
  },

  sessionUpdate: session => ({
    type: 'session.update',
    session,
  }),

  audioAppend: audio => ({
    type: 'input_audio_buffer.append',
    audio,
  }),

  conversationItemId: item => {
    const prefix = ID_PREFIXES[item?.type] || 'item'
    return `${prefix}_${randomUUID().replaceAll('-', '')}`
  },

  conversationItemCreate: item => ({
    type: 'conversation.item.create',
    item,
  }),

  responseCreate: response => {
    const body = gaResponse(response)
    return {
      type: 'response.create',
      ...(body ? { response: body } : {}),
    }
  },

  // GA response metadata is echoed by speech-to-speech on response.created
  // and response.done. It lets the Gateway distinguish a response it requested
  // from an automatic server-VAD response sharing the same Session.
  correlateResponseCreate: (payload, requestId) => ({
    ...payload,
    response: {
      ...(payload.response || {}),
      metadata: {
        ...(payload.response?.metadata || {}),
        [RESPONSE_CORRELATION_KEY]: requestId,
      },
    },
  }),

  responseCorrelationId: event => String(
    event?.response?.metadata?.[RESPONSE_CORRELATION_KEY] || '',
  ),

  responseCancel: () => ({
    type: 'response.cancel',
  }),

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
