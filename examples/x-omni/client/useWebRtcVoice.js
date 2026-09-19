import { useCallback, useEffect, useRef, useState } from 'react'
import { BrowserWebRtcConnection } from '../../../shared/gateway/webrtc-browser.mjs'
import { gatewayFetch } from '../../../web/src/gateway-transport.js'

export default function useWebRtcVoice({ sessionId, enabled, additionalCapabilities, onEvent, onClientAction }) {
  const connection = useRef(null)
  const callbacks = useRef({ enabled, onEvent, onClientAction })
  callbacks.current = { enabled, onEvent, onClientAction }
  const [connectionState, setConnectionState] = useState('connecting')
  const [state, setState] = useState('idle')
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const actions = JSON.stringify(additionalCapabilities.filter(name => name.startsWith('client.actions.')).map(name => name.slice(15)))

  useEffect(() => {
    setError('')
    const current = new BrowserWebRtcConnection({ sessionId, clientActions: JSON.parse(actions), fetch: gatewayFetch,
      onState(value) {
        if (connection.current !== current) return
        setConnectionState(value)
        if (value === 'connected') current.setMicrophoneEnabled(callbacks.current.enabled).catch(reason => {
          if (connection.current === current) setError(reason.message)
        })
      },
      onError: reason => { if (connection.current === current) setError(reason.message) },
      onEvent(event) {
        if (connection.current !== current) return
        if (event.type === 'error') setError(event.error?.message || 'WebRTC error')
        if (event.type === 'response.done' && event.response?.status === 'failed') setError('本次模型回复失败，请重试。')
        if (event.type === 'qwaudio.event') {
          const item = event.event
          callbacks.current.onEvent?.(item)
          if (item.type === 'voice.state') setState(item.state)
          if (item.type === 'client.action.request') {
            Promise.resolve().then(() => callbacks.current.onClientAction?.(item)).catch(reason => ({
              status: 'failed', error: { code: 'capture_failed', message: reason.message },
            })).then(result => {
              // Late captures must not cross reconnects or revive observers.
              if (connection.current !== current || current.closed) return
              current.command({ type: 'client.action.result', request_event_id: item.event_id,
                ...(result || { status: 'unsupported', error: { code: 'unsupported_action', message: 'Unsupported client action' } }) })
            })
          }
        } else if (event.type.includes('audio_transcription.') || event.type.startsWith('response.audio_transcript.')) {
          const final = event.type.endsWith('.completed') || event.type.endsWith('.done')
          callbacks.current.onEvent?.({ type: final ? 'transcript.final' : 'transcript.delta',
            role: event.type.startsWith('conversation.') ? 'user' : 'assistant',
            responseId: event.response_id, itemId: event.item_id, content: final ? event.transcript : event.delta })
        }
      },
    })
    connection.current = current
    const dispose = () => { if (connection.current === current) connection.current = null; void current.close() }
    window.addEventListener('pagehide', dispose)
    void current.connect()
    return () => { window.removeEventListener('pagehide', dispose); dispose() }
  }, [sessionId, actions, attempt])

  useEffect(() => {
    const current = connection.current
    current?.setMicrophoneEnabled(enabled).catch(reason => { if (connection.current === current) setError(reason.message) })
  }, [enabled])
  const activateAudio = useCallback(async () => { await connection.current?.activateAudio(); setError('') }, [])
  const sendInput = useCallback(parts => {
    const current = connection.current
    if (!current?.ready || !parts.length || parts.some(part => part.type !== 'text')) return false
    // Same manual-input priority as the WebSocket client. Merely editing or
    // previewing a source never interrupts speech or suspends the microphone.
    current.interrupt()
    return current.send({ type: 'conversation.item.create', item: { type: 'message', role: 'user',
      content: parts.map(part => ({ type: 'input_text', text: part.text })) } }) && current.send({ type: 'response.create' })
  }, [])
  const publishClientEvent = useCallback((name, data) => connection.current?.command({ type: 'client.event.publish', name, data }), [])
  const sendImageFrame = useCallback(image => connection.current?.sendImageFrame(image), [])
  const clearImageBuffer = useCallback(() => connection.current?.clearVideo(), [])
  const reconnect = useCallback(() => setAttempt(value => value + 1), [])
  return { connectionState, state, error, activateAudio, sendInput, publishClientEvent, sendImageFrame, clearImageBuffer,
    imageBufferAvailable: connectionState === 'connected' && connection.current?.config?.video_input === true, reconnect }
}
