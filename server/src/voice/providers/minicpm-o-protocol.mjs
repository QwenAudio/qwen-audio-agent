import { randomUUID } from 'node:crypto'

function decodeBase64(value) {
  return Buffer.from(String(value || ''), 'base64')
}

export function pcm16Base64ToFloat32(value) {
  const input = decodeBase64(value)
  if (input.length % 2 !== 0) {
    throw new Error('MiniCPM-o 输入 PCM16 长度必须是 2 字节的倍数')
  }
  const output = Buffer.allocUnsafe((input.length / 2) * 4)
  for (let source = 0, target = 0; source < input.length; source += 2, target += 4) {
    output.writeFloatLE(input.readInt16LE(source) / 32768, target)
  }
  return output.toString('base64')
}

export function float32Base64ToPcm16(value) {
  const input = decodeBase64(value)
  if (input.length % 4 !== 0) {
    throw new Error('MiniCPM-o 输出 Float32 PCM 长度必须是 4 字节的倍数')
  }
  const output = Buffer.allocUnsafe((input.length / 4) * 2)
  for (let source = 0, target = 0; source < input.length; source += 4, target += 2) {
    const sample = Math.max(-1, Math.min(1, input.readFloatLE(source)))
    const pcm = sample < 0
      ? Math.round(sample * 32768)
      : Math.round(sample * 32767)
    output.writeInt16LE(pcm, target)
  }
  return output.toString('base64')
}

function responseId(event) {
  return String(event?.response_id || '')
}

/**
 * Stateful adapter for the official MiniCPM-o 4.5 audio full-duplex wire
 * protocol. The shared runtime sees an OpenAI-like lifecycle while all
 * MiniCPM-o-specific queueing, initialization and PCM conversion stay here.
 */
export function createMiniCpmOProtocol() {
  let activeResponseId = ''
  let pendingPcm16 = Buffer.alloc(0)
  let pendingVideoFrame = ''
  const inputChunkBytes = 16000 * 2

  const finishActiveResponse = (id = activeResponseId) => {
    if (!id) return []
    activeResponseId = ''
    return [{
      type: 'response.done',
      response: { id, status: 'completed' },
      response_id: id,
    }]
  }

  return {
    encodeOutgoing: payload => (
      payload?.type === 'minicpm-o.unsupported' ? null : payload
    ),

    normalizeIncoming: event => {
      switch (event?.type) {
        case 'session.queue_done':
          // RealtimeFrontend responds to session.created with updateSession();
          // for MiniCPM-o that first update is the required session.init.
          return {
            type: 'session.created',
            session: { id: event.session_id || null },
          }
        case 'session.created':
          // session.created from MiniCPM-o acknowledges session.init.
          return {
            type: 'session.updated',
            session: {
              id: event.session_id || null,
              mode: event.mode || 'full_duplex',
            },
          }
        case 'response.output.delta': {
          const id = responseId(event) || activeResponseId
          if (event.kind === 'listen') return finishActiveResponse(id)
          const effectiveId = id || `resp_${randomUUID().replaceAll('-', '')}`
          const events = []
          if (activeResponseId && activeResponseId !== effectiveId) {
            events.push(...finishActiveResponse())
          }
          if (activeResponseId !== effectiveId) {
            activeResponseId = effectiveId
            events.push({
              type: 'response.created',
              response: { id: effectiveId, status: 'in_progress' },
              response_id: effectiveId,
            })
          }
          if (event.kind === 'text' && event.text) {
            events.push({
              type: 'response.text.delta',
              response_id: effectiveId,
              delta: event.text,
            })
          } else if (event.kind === 'audio' && event.audio) {
            events.push({
              type: 'response.audio.delta',
              response_id: effectiveId,
              delta: float32Base64ToPcm16(event.audio),
            })
          }
          return events
        }
        case 'response.done': {
          const id = responseId(event) || activeResponseId
          const events = []
          if (event.text) {
            if (activeResponseId !== id) {
              activeResponseId = id
              events.push({
                type: 'response.created',
                response: { id, status: 'in_progress' },
                response_id: id,
              })
            }
            events.push({
              type: 'response.text.delta',
              response_id: id,
              delta: event.text,
            })
          }
          if (event.audio) {
            if (activeResponseId !== id) {
              activeResponseId = id
              events.push({
                type: 'response.created',
                response: { id, status: 'in_progress' },
                response_id: id,
              })
            }
            events.push({
              type: 'response.audio.delta',
              response_id: id,
              delta: float32Base64ToPcm16(event.audio),
            })
          }
          events.push(...finishActiveResponse(id))
          return events
        }
        default:
          return event
      }
    },

    sessionUpdate: session => ({
      type: 'session.init',
      payload: {
        system_prompt: String(session?.instructions || '').trim(),
        config: session?.config || {},
        ...(session?.voice ? { voice: session.voice } : {}),
      },
    }),

    audioAppend: audio => {
      pendingPcm16 = Buffer.concat([pendingPcm16, decodeBase64(audio)])
      if (pendingPcm16.length < inputChunkBytes) {
        return { type: 'minicpm-o.unsupported' }
      }
      const chunk = pendingPcm16.subarray(0, inputChunkBytes)
      pendingPcm16 = pendingPcm16.subarray(inputChunkBytes)
      const videoFrame = pendingVideoFrame
      pendingVideoFrame = ''
      return {
        type: 'input.append',
        input: {
          audio: pcm16Base64ToFloat32(chunk.toString('base64')),
          ...(videoFrame ? { video_frames: [videoFrame] } : {}),
          force_listen: false,
        },
      }
    },

    imageAppend: image => {
      pendingVideoFrame = String(image || '')
      return { type: 'minicpm-o.unsupported' }
    },

    clearImageBuffer: () => {
      pendingVideoFrame = ''
    },

    conversationItemId: () => `item_${randomUUID().replaceAll('-', '')}`,
    conversationItemCreate: () => ({ type: 'minicpm-o.unsupported' }),
    responseCreate: () => ({ type: 'minicpm-o.unsupported' }),
    correlateResponseCreate: payload => payload,
    responseCorrelationId: () => '',
    responseCancel: () => ({ type: 'minicpm-o.unsupported' }),
    sessionClose: reason => ({
      type: 'session.close',
      reason: String(reason || 'client_closed'),
    }),
    userTextItem: text => ({ type: 'message', role: 'user', text }),
    functionOutputItem: (callId, output) => ({ callId, output }),
  }
}
