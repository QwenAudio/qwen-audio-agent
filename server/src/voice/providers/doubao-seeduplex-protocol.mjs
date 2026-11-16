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

function parseJson(value, fallback) {
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

export function pcmFloat32Base64ToPcm16(value) {
  const input = Buffer.from(String(value || ''), 'base64')
  if (input.length % 4 !== 0) {
    throw new Error('Doubao Seeduplex 返回了无效的 Float32 PCM 音频')
  }
  const output = Buffer.allocUnsafe(input.length / 2)
  for (let source = 0, target = 0; source < input.length; source += 4, target += 2) {
    const sample = Math.max(-1, Math.min(1, input.readFloatLE(source)))
    const pcm = sample < 0
      ? Math.round(sample * 0x8000)
      : Math.round(sample * 0x7fff)
    output.writeInt16LE(pcm, target)
  }
  return output.toString('base64')
}

function doubaoTools(tools = []) {
  return tools
    .map(tool => tool?.function ? { type: tool.type, ...tool.function } : tool)
    .filter(tool => tool?.name)
    .map(tool => ({
      type: 'function',
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      ...(tool.parameters ? { parameters: tool.parameters } : {}),
    }))
}

function conversationItem(item) {
  if (item?.type === 'function_call_output') {
    const output = parseJson(item.output, item.output)
    return {
      call_id: String(item.call_id || ''),
      role: 'tool',
      content: [{
        type: 'input_text',
        text: typeof output === 'string' ? output : JSON.stringify(output),
      }],
    }
  }
  const text = textFromItem(item)
  if (!text) return null
  return {
    id: item.id,
    type: 'message',
    role: item.role || 'user',
    content: [{ type: 'input_text', text }],
  }
}

export function createDoubaoSeeduplexProtocol() {
  let activeResponseId = ''
  let pendingUserText = ''
  let activeAsrItemId = ''
  let endedAsrItemId = ''

  const responseId = event => (
    event.response_id
    || event.response?.id
    || activeResponseId
    || id('response')
  )

  const ensureCreated = (events, source) => {
    const shouldCreate = !activeResponseId
    if (shouldCreate) activeResponseId = responseId(source)
    if (shouldCreate) {
      events.push({
        type: 'response.created',
        response: { id: activeResponseId },
      })
    }
    return activeResponseId
  }

  const normalizeResponseEvent = event => {
    const events = []
    if (
      event.type === 'response.output_text.delta'
      || event.type === 'response.output_text.done'
      || event.type === 'response.output_audio.started'
      || event.type === 'response.output_audio.delta'
      || event.type === 'response.output_audio.done'
      || event.type === 'response.function_call_arguments.done'
      || event.type === 'response.done'
    ) {
      const current = ensureCreated(events, event)
      if (event.type === 'response.output_text.delta') {
        events.push({
          ...event,
          type: 'response.text.delta',
          response_id: current,
          delta: event.delta || event.text || '',
        })
        return events
      }
      if (event.type === 'response.output_text.done') {
        events.push({
          ...event,
          type: 'response.text.done',
          response_id: current,
          text: event.text || event.transcript || '',
        })
        return events
      }
      if (event.type === 'response.output_audio.delta') {
        events.push({
          ...event,
          response_id: current,
          delta: pcmFloat32Base64ToPcm16(event.delta || event.audio || ''),
          sampleRate: 24000,
        })
        return events
      }
      if (event.type === 'response.output_audio.done') {
        events.push({ ...event, response_id: current })
        return events
      }
      if (event.type === 'response.function_call_arguments.done') {
        const items = Array.isArray(event.items) ? event.items : [event]
        for (const item of items) {
          events.push({
            type: 'response.function_call_arguments.done',
            response_id: current,
            call_id: item.call_id || event.call_id || '',
            name: item.name || event.name || '',
            arguments: item.arguments || event.arguments || '{}',
          })
        }
        return events
      }
      if (event.type === 'response.done') {
        events.push({
          ...event,
          response_id: current,
          response: {
            ...(event.response || {}),
            id: current,
            status: event.response?.status || 'completed',
          },
        })
        activeResponseId = ''
        return events
      }
      events.push({ type: 'response.activity', response_id: current })
      return events
    }
    return event
  }

  return Object.freeze({
    encodeOutgoing: payload => ({
      event_id: eventId(),
      ...payload,
    }),

    normalizeIncoming(event) {
      if (event?.type === 'error') return event
      if (event?.type === 'response.canceled') {
        return normalizeResponseEvent({
          ...event,
          type: 'response.done',
          response: { ...event.response, status: 'cancelled' },
        })
      }
      // Doubao ASR events arrive with item_id but the Gateway input pipeline
      // expects realtime-protocol field names and a paired speech boundary. The
      // live endpoint never emits input_audio_buffer.speech_started,
      // speech_stopped or committed, so both ends of one utterance are
      // synthesized from the transcription events of a single item_id.
      if (event?.type === 'conversation.item.input_audio_transcription.started') {
        const itemId = event.item_id || id('item')
        activeAsrItemId = itemId
        endedAsrItemId = ''
        return [{
          type: 'input_audio_buffer.speech_started',
          item_id: itemId,
          event_id: event.event_id,
        }]
      }
      if (event?.type === 'conversation.item.input_audio_transcription.delta') {
        return [{
          ...event,
          item_id: event.item_id || activeAsrItemId,
          text: '',
          stash: String(event.delta || ''),
        }]
      }
      if (event?.type === 'conversation.item.input_audio_transcription.completed') {
        const itemId = event.item_id || activeAsrItemId
        const events = []
        // The close of an utterance is the only end boundary this provider
        // sends, so it is synthesized here from the final transcript of the
        // same item_id that opened the utterance above. Emitting it only for
        // the item that is still open keeps the pair 1:1: a final that belongs
        // to another (older) item stays transcript-only, so a late event can
        // never close the turn that is speaking now.
        // `input_audio_buffer.committed` rather than `speech_stopped` on
        // purpose: the input pipeline ends the turn for both, but only
        // `speech_stopped` arms the response-start watchdog, which would
        // report a missing reply and reconnect the session whenever a duplex
        // model answers late or stays silent.
        if (itemId && itemId === activeAsrItemId && itemId !== endedAsrItemId) {
          endedAsrItemId = itemId
          events.push({
            type: 'input_audio_buffer.committed',
            item_id: itemId,
            event_id: event.event_id,
          })
        }
        events.push({
          ...event,
          item_id: itemId,
          transcript: String(event.text || event.transcript || ''),
        })
        return events
      }
      return normalizeResponseEvent(event)
    },

    connectionMessages: ({ session }) => [{
      type: 'session.create',
      session,
    }],

    sessionUpdate: session => ({
      type: 'session.update',
      session,
    }),

    sessionClose: () => ({ type: 'session.close' }),

    audioAppend: audio => ({
      type: 'input_audio_buffer.append',
      audio,
    }),

    inputMute: () => ({
      type: 'input_audio_mute.commit',
    }),

    inputUnmute: () => ({
      type: 'input_audio_unmute.commit',
    }),

    imageAppend: () => null,

    clearImageBuffer: () => {},

    conversationItemId: () => id('item'),

    conversationItemCreate: (item, { contextOnly = true } = {}) => {
      const text = textFromItem(item)
      // Only interactive user input is deferred to speech_text_buffer.commit.
      // Context, restoration and permission identities must reach the service
      // immediately, even when no response is requested afterwards.
      if (!contextOnly && item?.role === 'user' && text) {
        pendingUserText = text
        return null
      }
      const normalized = conversationItem(item)
      return normalized ? { type: 'conversation.item.create', items: [normalized] } : null
    },

    responseCreate: response => {
      const text = String(response?.instructions || pendingUserText || '').trim()
      pendingUserText = ''
      return text ? { type: 'speech_text_buffer.commit', text } : null
    },

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

    doubaoTools,
  })
}
