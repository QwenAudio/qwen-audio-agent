import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'

function eventId() {
  return `event_${randomUUID().replaceAll('-', '')}`
}
function languageForLocale(locale) {
  const language = String(locale || '').toLowerCase().split(/[-_]/, 1)[0]
  return language || undefined
}

function providerError(event) {
  return new Error(
    String(event?.error?.message || event?.message || 'Qwen ASR provider error'),
  )
}

export function createQwenAsrTranscriber({
  baseUrl,
  model,
  apiKey,
  WebSocketImpl = WebSocket,
  onDelta = () => {},
  onFinal = () => {},
  onError = () => {},
} = {}) {
  let socket = null
  let paused = false
  let configured = false
  let finishing = false
  let resolveStart
  let rejectStart

  const send = event => {
    if (socket?.readyState !== WebSocketImpl.OPEN) return false
    socket.send(JSON.stringify({ event_id: eventId(), ...event }))
    return true
  }

  const handleMessage = raw => {
    let event
    try {
      event = JSON.parse(raw.toString())
    } catch {
      return
    }
    if (event.type === 'session.updated') {
      configured = true
      resolveStart?.()
      resolveStart = null
      rejectStart = null
      return
    }
    if (event.type === 'conversation.item.input_audio_transcription.text') {
      onDelta(String(event.transcript || event.text || ''))
      return
    }
    if (event.type === 'conversation.item.input_audio_transcription.completed') {
      Promise.resolve(onFinal(String(event.transcript || event.text || '')))
        .catch(onError)
      return
    }
    if (event.type === 'session.finished') {
      socket?.close()
      return
    }
    if (event.type === 'error') onError(providerError(event))
  }

  return {
    start({ locale } = {}) {
      if (socket) return Promise.reject(new Error('Qwen ASR session already started'))
      if (!baseUrl || !model || !apiKey) {
        return Promise.reject(new Error('Qwen ASR configuration is incomplete'))
      }
      const url = new URL(baseUrl)
      url.searchParams.set('model', model)
      const promise = new Promise((resolve, reject) => {
        resolveStart = resolve
        rejectStart = reject
      })
      socket = new WebSocketImpl(url.toString(), {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'OpenAI-Beta': 'realtime=v1',
        },
      })
      socket.on('open', () => {
        const language = languageForLocale(locale)
        send({
          type: 'session.update',
          session: {
            modalities: ['text'],
            input_audio_format: 'pcm',
            sample_rate: 16000,
            ...(language
              ? { input_audio_transcription: { language } }
              : {}),
            turn_detection: {
              type: 'server_vad',
              threshold: 0,
              silence_duration_ms: 400,
            },
          },
        })
      })
      socket.on('message', handleMessage)
      socket.on('error', error => {
        if (!configured) rejectStart?.(error)
        else onError(error)
      })
      socket.on('close', () => {
        if (!configured && !finishing) {
          rejectStart?.(new Error('Qwen ASR connection closed during setup'))
        }
        resolveStart = null
        rejectStart = null
      })
      return promise
    },

    appendAudio(audio) {
      if (paused || finishing) return false
      return send({ type: 'input_audio_buffer.append', audio: String(audio || '') })
    },

    pause() {
      paused = true
    },

    resume() {
      if (!finishing) paused = false
    },

    close({ finish = false } = {}) {
      if (!socket) return
      paused = true
      finishing = true
      if (finish && socket.readyState === WebSocketImpl.OPEN) {
        send({ type: 'session.finish' })
      } else socket.close()
    },
  }
}
