import { useCallback, useEffect, useRef, useState } from 'react'
import { BrowserWebRtcConnection } from '../../../shared/gateway/webrtc-browser.mjs'
import { gatewayFetch } from './gateway-fetch.js'

// Bounded avatar-mode voice transport. This example has no WebSocket voice path
// at all: avatar video and its paired audio only exist on a WebRTC recvonly
// track, so this hook drives the whole voice session over the framework's
// BrowserWebRtcConnection. It intentionally covers voice + transcript + avatar
// state only; task/permission/history panels stay out of avatar mode.

const MESSAGE_LIMIT = 200
const HISTORY_LIMIT = 40

function messageText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map(part => part.text || part.transcript || '').join('\n')
  }
  return ''
}

export function useWebRtcVoice({
  sessionId,
  avatarPersonaId = null,
  takeover = false,
  clientActions = [],
} = {}) {
  const connectionRef = useRef(null)
  const messagesRef = useRef([])
  const videoRef = useRef(null)
  const audioRef = useRef(null)
  // Props read inside the connect effect without retriggering it: changing the
  // takeover flag or client action list must not tear down a live session.
  const takeoverRef = useRef(takeover)
  const clientActionsRef = useRef(clientActions)
  takeoverRef.current = takeover
  clientActionsRef.current = clientActions

  const active = Boolean(avatarPersonaId)
  // The session connection is persistent (established as soon as avatar mode is
  // active), and the microphone is only a capture toggle on top of it — so text
  // turns and the avatar downlink keep working while the mic is muted, matching
  // the product's original behaviour. `micIntentRef` lets a toggle that fires
  // before the connection finishes opening still apply once it is ready.
  const [micEnabled, setMicEnabled] = useState(false)
  const micIntentRef = useRef(false)
  const reconnectTimerRef = useRef(null)
  const [generation, setGeneration] = useState(0)
  const [state, setState] = useState('idle')
  const [playback, setPlayback] = useState('idle')
  const [messages, setMessages] = useState([])
  const [avatarState, setAvatarState] = useState(null)
  const [error, setError] = useState(null)

  const commitMessages = useCallback(() => {
    setMessages(messagesRef.current.slice(-MESSAGE_LIMIT))
  }, [])

  const applyTranscript = useCallback(event => {
    const role = event.type.startsWith('conversation.item.') ? 'user' : 'assistant'
    const final = event.type.endsWith('.completed') || event.type.endsWith('.done')
    const text = final ? event.transcript : event.delta
    if (typeof text !== 'string') return
    const id = `${role}:${event.response_id || event.item_id || 'current'}`
    const list = messagesRef.current
    let message = list.find(item => item.id === id)
    if (!message && role === 'user') {
      message = list.find(item => item.pending && item.content === text)
    }
    if (!message) {
      message = { id, role, content: '', live: true }
      list.push(message)
    }
    message.id = id
    message.pending = false
    message.content = final || text.startsWith(message.content) ? text : message.content + text
    message.live = !final
    commitMessages()
  }, [commitMessages])

  // A new session id (the header's 新会话 button) starts the avatar transcript
  // over. The connect effect re-runs on the same id change and rebinds the
  // session, so dropping the cached turns here keeps the panel consistent.
  useEffect(() => {
    messagesRef.current = []
    commitMessages()
  }, [sessionId, commitMessages])

  useEffect(() => {
    if (!active) return undefined
    let cancelled = false
    let historyRequested = false

    const received = event => {
      if (event.type === 'session.updated' && !historyRequested) {
        historyRequested = true
        connectionRef.current?.command({
          type: 'conversation.history',
          session_id: sessionId,
        })
      }
      if (
        event.type.includes('audio_transcription.')
        || event.type.startsWith('response.audio_transcript.')
      ) applyTranscript(event)
      if (event.type === 'output_audio_buffer.cleared') {
        for (const message of messagesRef.current) {
          if (message.live && message.role === 'assistant') {
            message.live = false
            message.interrupted = true
          }
        }
        commitMessages()
      }
      if (event.type === 'response.done' && event.response?.status === 'failed') {
        setError('本次模型回复失败，请重试。')
      }
      if (event.type === 'error') setError(event.error?.message || '网关返回错误')
      if (event.type === 'qwaudio.event') {
        const item = event.event
        if (item.type === 'conversation.history.result') {
          const history = (item.messages || [])
            .filter(message => ['user', 'assistant'].includes(message.role))
            .slice(-HISTORY_LIMIT)
            .map((message, index) => ({
              id: `history:${message.id || index}`,
              role: message.role,
              content: messageText(message.content),
            }))
          const pending = messagesRef.current.filter(message => message.pending)
          messagesRef.current = [
            ...history,
            ...pending.filter(message => !history.some(
              saved => saved.role === message.role && saved.content === message.content,
            )),
          ]
          commitMessages()
        }
        if (item.type === 'voice.connection' && item.state === 'unavailable') {
          setError(item.message || '语音服务暂不可用')
        }
        if (item.type === 'transcript.discard') {
          const id = item.itemId || item.turnId
          messagesRef.current = messagesRef.current.filter(
            message => !id || message.id !== `user:${id}`,
          )
          commitMessages()
        }
      }
    }

    const connection = new BrowserWebRtcConnection({
      sessionId,
      clientActions: clientActionsRef.current,
      takeover: takeoverRef.current,
      avatarPersonaId,
      video: videoRef.current,
      audio: audioRef.current,
      fetch: (url, init = {}) => gatewayFetch(url, init),
      onEvent: received,
      onState: value => {
        if (cancelled) return
        setState(value)
        // An unexpected drop retries on its own after a short backoff; there is
        // no manual reconnect control. Unmount/generation churn sets `cancelled`
        // first, so teardown never schedules a stray retry.
        if (value === 'disconnected') {
          clearTimeout(reconnectTimerRef.current)
          reconnectTimerRef.current = setTimeout(
            () => setGeneration(current => current + 1),
            2000,
          )
        }
      },
      onError: event => { if (!cancelled) setError(event?.message || String(event)) },
      onPlayback: value => { if (!cancelled) setPlayback(value) },
      onAvatarState: item => { if (!cancelled) setAvatarState(item) },
    })
    connectionRef.current = connection

    void (async () => {
      setError(null)
      setAvatarState(null)
      setPlayback('idle')
      setState('connecting')
      try {
        await connection.connect()
        if (cancelled || connection.closed) return
        await connection.activateAudio()
        // Restore the user's mic intent; a fresh page load connects muted.
        if (micIntentRef.current) await connection.setMicrophoneEnabled(true)
      } catch (connectError) {
        if (cancelled) return
        setError(connectError?.message || String(connectError))
        setState('error')
      }
    })()

    return () => {
      cancelled = true
      clearTimeout(reconnectTimerRef.current)
      connectionRef.current = null
      void connection.close()
    }
  }, [active, generation, sessionId, avatarPersonaId, applyTranscript, commitMessages])

  const toggleMic = useCallback(() => {
    setError(null)
    const connection = connectionRef.current
    // A mic toggle is a user gesture, so it is also the earliest reliable point
    // to unlock audio playback while the session is already connected.
    void connection?.activateAudio()
    const next = !micIntentRef.current
    micIntentRef.current = next
    setMicEnabled(next)
    void connection?.setMicrophoneEnabled(next)
  }, [])

  const send = useCallback(text => {
    const connection = connectionRef.current
    const value = String(text || '').trim()
    if (!connection?.ready || !value) return false
    // Sending is a user gesture, so a text-first turn also unlocks audio playback
    // while the microphone stays muted.
    void connection.activateAudio()
    const queued = connection.send({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: value }] },
    })
    if (!queued) return false
    connection.send({ type: 'response.create' })
    messagesRef.current.push({
      id: `local:${crypto.randomUUID()}`,
      role: 'user',
      content: value,
      pending: true,
    })
    commitMessages()
    return true
  }, [commitMessages])

  const clearError = useCallback(() => setError(null), [])

  return {
    state,
    playback,
    messages,
    avatarState,
    micEnabled,
    error,
    videoRef,
    audioRef,
    toggleMic,
    send,
    clearError,
  }
}
