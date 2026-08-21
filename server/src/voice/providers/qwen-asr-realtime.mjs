import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'

function withModel(baseUrl, model) {
  const url = new URL(baseUrl)
  url.searchParams.set('model', model)
  return url.toString()
}

export function createQwenAsrTranscriber({
  apiKey,
  baseUrl = 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime',
  model = 'qwen3-asr-flash-realtime',
  WebSocketClass = WebSocket,
  id = randomUUID,
} = {}) {
  let socket = null
  let callbacks = {}
  let intentionallyClosed = false
  let pendingAudio = []
  let pendingAudioCharacters = 0
  const maxPendingAudioCharacters = 1024 * 1024
  const send = event => {
    if (socket?.readyState !== WebSocketClass.OPEN) return false
    socket.send(JSON.stringify({ event_id: `event_${id()}`, ...event }))
    return true
  }
  const close = () => {
    intentionallyClosed = true
    pendingAudio = []
    pendingAudioCharacters = 0
    if (socket?.readyState === WebSocketClass.OPEN) {
      send({ type: 'session.finish' })
    }
    socket?.close?.(1000, 'dictation ended')
  }
  return {
    start(nextCallbacks = {}) {
      if (!apiKey) {
        nextCallbacks.error?.(new Error('Qwen ASR 听写密钥未配置'))
        return false
      }
      callbacks = nextCallbacks
      intentionallyClosed = false
      socket = new WebSocketClass(withModel(baseUrl, model), {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'OpenAI-Beta': 'realtime=v1',
        },
      })
      socket.on('open', () => {
        send({
          type: 'session.update',
          session: {
            modalities: ['text'],
            input_audio_format: 'pcm',
            sample_rate: 16000,
            turn_detection: {
              type: 'server_vad',
              threshold: 0.2,
              silence_duration_ms: 400,
            },
          },
        })
        for (const audio of pendingAudio) {
          send({ type: 'input_audio_buffer.append', audio })
        }
        pendingAudio = []
        pendingAudioCharacters = 0
        callbacks.ready?.()
      })
      socket.on('message', raw => {
        let event
        try { event = JSON.parse(raw.toString()) } catch { return }
        if (event.type === 'conversation.item.input_audio_transcription.text') {
          callbacks.partial?.(String(event.text || ''))
        } else if (event.type === 'conversation.item.input_audio_transcription.completed') {
          callbacks.final?.(String(event.transcript || event.text || ''))
        } else if (
          event.type === 'conversation.item.input_audio_transcription.failed'
          || event.type === 'error'
        ) {
          callbacks.error?.(new Error(
            event.error?.message || event.message || 'Qwen ASR 听写失败',
          ))
        }
      })
      socket.on('error', error => {
        if (!intentionallyClosed) callbacks.error?.(error)
      })
      socket.on('close', () => {
        if (!intentionallyClosed) callbacks.error?.(new Error('Qwen ASR 连接已关闭'))
      })
      return true
    },
    append(audio) {
      const value = String(audio || '')
      if (socket?.readyState === WebSocketClass.OPEN) {
        return send({ type: 'input_audio_buffer.append', audio: value })
      }
      if (!socket || intentionallyClosed) return false
      if (pendingAudioCharacters + value.length > maxPendingAudioCharacters) {
        return false
      }
      pendingAudio.push(value)
      pendingAudioCharacters += value.length
      return true
    },
    // Pause is local audio gating. Keeping the ASR socket open avoids silently
    // creating a second provider session when the user resumes.
    pause() { return true },
    resume() { return true },
    close,
  }
}

export function qwenAsrAdapter(configuration = {}) {
  return {
    inputSampleRate: 16000,
    isConfigured: () => Boolean(configuration.apiKey),
    createTranscriber: () => createQwenAsrTranscriber(configuration),
  }
}
