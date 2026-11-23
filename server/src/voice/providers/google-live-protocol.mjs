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
  const callNames = new Map()
  let activeResponseId = ''
  let interrupted = false
  let automaticResponsePending = false
  let input = null
  let responseInput = null
  let outputTranscript = ''
  let outputTranscriptFinished = false

  const ensureResponse = events => {
    if (!activeResponseId) {
      activeResponseId = id('response')
      responseInput = input
      events.push({
        type: 'response.created',
        response: { id: activeResponseId },
      })
    }
    return activeResponseId
  }

  const finishResponse = events => {
    if (!activeResponseId) return
    if (!interrupted && outputTranscript.trim()) {
      events.push({
        type: 'response.audio_transcript.done',
        response_id: activeResponseId,
        transcript: outputTranscript,
      })
    }
    events.push({
      type: 'response.done',
      response: { id: activeResponseId, status: interrupted ? 'cancelled' : 'completed' },
    })
    activeResponseId = ''
    responseInput = null
    outputTranscript = ''
    outputTranscriptFinished = false
    automaticResponsePending = false
  }

  const newInput = () => ({ id: id('input'), text: '' })

  const finishInput = events => {
    if (!input?.text.trim() || input.finalized) return
    input.finalized = true
    events.push({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: input.id,
      transcript: input.text,
    })
  }

  const handleActivity = (type, events) => {
    if (type === 'ACTIVITY_START') {
      if (input?.activity === 'speaking') return
      if (input?.activity === 'ended' || input?.finalized) {
        finishInput(events)
        input = null
      }
      if (!input) {
        input = newInput()
        events.push({
          type: 'input_audio_buffer.speech_started',
          item_id: input.id,
          providerHandlesInterruption: true,
        })
      }
      input.activity = 'speaking'
    } else if (type === 'ACTIVITY_END' && input?.activity === 'speaking') {
      input.activity = 'ended'
      events.push({ type: 'input_audio_buffer.speech_stopped', item_id: input.id })
      if (input.finished) finishInput(events)
    }
  }

  const handleInputTranscript = (transcription, events) => {
    if (!transcription) return
    const text = transcription.text
    if (input?.finalized) {
      if (input.activity || !input.modelTurnEnded) return
      // An id-less explicit final that arrived after the model turn can be
      // repeated. A new fragment or voice activity opens the next input.
      if (transcription.finished === true && text === input.finalFragment) return
      input = null
    }
    if (!input && typeof text === 'string' && text) {
      input = newInput()
      events.push({
        type: 'conversation.item.input_audio_transcription.started',
        item_id: input.id,
      })
    }
    if (!input || input.finished) return
    if (typeof text === 'string' && text) {
      input.text += text
      events.push({
        type: 'conversation.item.input_audio_transcription.delta',
        item_id: input.id,
        text: input.text,
      })
    }
    if (typeof transcription.finished === 'boolean') input.finished = transcription.finished
    if (input.finished) input.finalFragment = text
    if (input.activity !== 'speaking' && (input.finished || (input.modelTurnEnded && input.finished !== false))) {
      finishInput(events)
    }
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
      handleActivity(event?.voiceActivity?.type, events)
      const serverContent = event?.serverContent
      if (serverContent) {
        if (serverContent.interrupted && !interrupted) {
          interrupted = true
          events.push({ type: 'response.interrupted', response_id: activeResponseId })
        }
        handleInputTranscript(serverContent.inputTranscription, events)
        if (
          serverContent.turnComplete && !interrupted
          && input && input.activity !== 'speaking'
          && (!responseInput || responseInput === input)
        ) {
          // A previous response can close while the next voice input is open.
          // Keep an ended activity available for independently delivered ASR.
          input.modelTurnEnded = true
          if (input.finished !== false) finishInput(events)
          if (!input.activity && input.finalized) input = null
        }

        const modelTurn = interrupted ? null : serverContent.modelTurn
        const modelResponseId = modelTurn ? ensureResponse(events) : activeResponseId
        for (const part of modelTurn?.parts || []) {
          if (typeof part.text === 'string' && part.text) {
            events.push({
              type: 'response.text.delta',
              response_id: modelResponseId,
              delta: part.text,
            })
          }
          if (part.inlineData?.data) {
            events.push({
              type: 'response.audio.delta',
              response_id: modelResponseId,
              delta: part.inlineData.data,
              sampleRate: audioRate(part.inlineData.mimeType),
            })
          }
        }

        const output = serverContent.outputTranscription
        if (!interrupted && output && !outputTranscriptFinished) {
          if (typeof output.text === 'string' && output.text) {
            const responseId = ensureResponse(events)
            outputTranscript += output.text
            if (!serverContent.turnComplete) {
              events.push({
                type: 'response.audio_transcript.delta',
                response_id: responseId,
                delta: output.text,
              })
            }
          }
          outputTranscriptFinished = output.finished === true
        }
        // generationComplete can precede playback/turn completion. Keep the
        // response slot occupied until the service actually closes the turn.
        if (serverContent.turnComplete) {
          finishResponse(events)
        }
      }

      const calls = event?.toolCall?.functionCalls || []
      if (calls.length && !interrupted) {
        if (input?.activity !== 'speaking' && input?.finished !== false) finishInput(events)
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

      if (serverContent?.turnComplete) interrupted = false
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
