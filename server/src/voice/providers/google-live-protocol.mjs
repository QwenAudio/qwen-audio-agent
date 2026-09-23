import { randomUUID } from 'node:crypto'

function id(prefix) {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`
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

function audioRate(mimeType, fallback = 24000) {
  const match = /rate=(\d+)/i.exec(String(mimeType || ''))
  const rate = match ? Number(match[1]) : fallback
  return Number.isFinite(rate) && rate > 0 ? rate : fallback
}

function googleTools(tools = []) {
  const declarations = tools
    .map(tool => tool.function || tool)
    .filter(tool => tool?.name)
    .map(tool => ({
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      ...(tool.parameters ? { parameters: tool.parameters } : {}),
    }))
  return declarations.length ? [{ functionDeclarations: declarations }] : []
}

export function createGoogleLiveProtocol() {
  const responseIds = new Set()
  const callNames = new Map()
  let activeResponseId = ''
  let interrupted = false
  let automaticResponsePending = false

  const ensureResponse = events => {
    if (!activeResponseId) activeResponseId = id('response')
    if (!responseIds.has(activeResponseId)) {
      responseIds.add(activeResponseId)
      events.push({
        type: 'response.created',
        response: { id: activeResponseId },
      })
    }
    return activeResponseId
  }

  const finishResponse = events => {
    if (!activeResponseId) return
    events.push({
      type: 'response.done',
      response: { id: activeResponseId, status: interrupted ? 'cancelled' : 'completed' },
    })
    responseIds.delete(activeResponseId)
    activeResponseId = ''
    interrupted = false
    automaticResponsePending = false
  }

  return Object.freeze({
    encodeOutgoing: payload => payload,

    normalizeIncoming: event => {
      if (event?.error) return { type: 'error', error: event.error }
      if (event?.setupComplete) {
        return {
          type: 'session.updated',
          session: { id: id('google_session') },
        }
      }

      const events = []
      const serverContent = event?.serverContent
      if (serverContent) {
        if (serverContent.interrupted) interrupted = true
        const responseId = (
          serverContent.modelTurn
          || serverContent.outputTranscription
        ) ? ensureResponse(events) : activeResponseId

        for (const part of serverContent.modelTurn?.parts || []) {
          if (typeof part.text === 'string' && part.text) {
            events.push({
              type: 'response.text.delta',
              response_id: responseId || ensureResponse(events),
              delta: part.text,
            })
          }
          if (part.inlineData?.data) {
            events.push({
              type: 'response.audio.delta',
              response_id: responseId || ensureResponse(events),
              delta: part.inlineData.data,
              sampleRate: audioRate(part.inlineData.mimeType),
            })
          }
        }

        if (serverContent.inputTranscription?.text) {
          events.push({
            type: serverContent.turnComplete
              ? 'conversation.item.input_audio_transcription.completed'
              : 'conversation.item.input_audio_transcription.delta',
            transcript: serverContent.inputTranscription.text,
            delta: serverContent.inputTranscription.text,
            item_id: id('input'),
          })
        }
        if (serverContent.outputTranscription?.text) {
          events.push({
            type: serverContent.turnComplete
              ? 'response.audio_transcript.done'
              : 'response.audio_transcript.delta',
            response_id: responseId || ensureResponse(events),
            transcript: serverContent.outputTranscription.text,
            delta: serverContent.outputTranscription.text,
          })
        }
        // generationComplete can precede playback/turn completion. Keep the
        // response slot occupied until the service actually closes the turn.
        if (serverContent.turnComplete) {
          finishResponse(events)
        }
      }

      const calls = event?.toolCall?.functionCalls || []
      if (calls.length) {
        const responseId = ensureResponse(events)
        for (const call of calls) {
          const callId = String(call.id || id('call'))
          callNames.set(callId, String(call.name || ''))
          events.push({
            type: 'response.function_call_arguments.done',
            response_id: responseId,
            call_id: callId,
            name: call.name,
            arguments: JSON.stringify(call.args || {}),
          })
        }
        finishResponse(events)
      }

      if (event?.toolCallCancellation) {
        events.push({
          type: 'error',
          error: {
            message: 'Google Live cancelled one or more tool calls.',
            type: 'tool_call_cancelled',
          },
        })
      }

      return events.length ? events : event
    },

    connectionMessages: ({ session }) => [{
      setup: session,
    }],

    sessionUpdate: session => ({
      setup: session,
    }),

    audioAppend: audio => ({
      realtimeInput: {
        audio: {
          data: audio,
          mimeType: 'audio/pcm;rate=16000',
        },
      },
    }),

    imageAppend: image => ({
      realtimeInput: {
        video: {
          data: image,
          mimeType: 'image/jpeg',
        },
      },
    }),

    clearImageBuffer: () => {},

    conversationItemId: () => id('msg'),

    conversationItemCreate: (item, { contextOnly = true } = {}) => {
      if (item?.type === 'function_call_output') {
        automaticResponsePending = true // toolResponse resumes generation itself.
        const output = parseJson(item.output, item.output)
        const callId = String(item.call_id || '')
        const name = callNames.get(callId) || ''
        callNames.delete(callId)
        return {
          toolResponse: {
            functionResponses: [{
              id: callId,
              name,
              response: output && typeof output === 'object'
                ? output
                : { result: output },
            }],
          },
        }
      }
      const text = textFromItem(item)
      if (!text) return null
      automaticResponsePending = !contextOnly
      if (!contextOnly) return { realtimeInput: { text } }
      // Realtime text counts as user activity; only clientContent can append
      // history without starting a reply. See the Live WebSockets API contract.
      return { clientContent: {
        turns: [{ role: item.role === 'assistant' ? 'model' : 'user', parts: [{ text }] }],
        turnComplete: false,
      } }
    },

    responseCreate: response => {
      const text = String(response?.instructions || '').trim()
      const automatic = automaticResponsePending
      automaticResponsePending = false
      if (text) return { realtimeInput: { text } }
      return automatic ? null : { clientContent: { turnComplete: true } }
    },

    correlateResponseCreate: payload => payload,
    responseCorrelationId: () => '',

    // clientContent interrupts generation; false prevents another response.
    responseCancel: () => ({ clientContent: { turnComplete: false } }),

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

    googleTools,
  })
}
