import { randomUUID } from 'node:crypto'

function eventId() {
  return `event_${randomUUID().replaceAll('-', '')}`
}

/**
 * Wire adapter for Realtime providers that use the OpenAI-compatible event
 * envelope. Gateway code only consumes the normalized events returned by
 * normalizeIncoming(), so a provider with a different protocol can implement
 * the same adapter surface without leaking its wire format into the Gateway.
 */
export const openAiCompatibleProtocol = Object.freeze({
  encodeOutgoing: payload => ({
    event_id: eventId(),
    ...payload,
  }),

  normalizeIncoming: event => event,

  sessionUpdate: session => ({
    type: 'session.update',
    session,
  }),

  audioAppend: audio => ({
    type: 'input_audio_buffer.append',
    audio,
  }),

  // Client-assigned id for a conversation item. The beta dialect accepts one
  // opaque namespace for every item type.
  conversationItemId: () => `item_${randomUUID().replaceAll('-', '')}`,

  conversationItemCreate: item => ({
    type: 'conversation.item.create',
    item,
  }),

  responseCreate: response => ({
    type: 'response.create',
    ...(response ? { response } : {}),
  }),

  // The DashScope beta dialect does not provide a portable response metadata
  // correlation contract. RealtimeFrontend keeps its established FIFO
  // correlation for providers with this protocol.
  correlateResponseCreate: payload => payload,
  responseCorrelationId: () => '',

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
