import { useCallback, useEffect, useRef, useState } from 'react'
import { GatewayClient } from 'qwen-audio-agent/gateway-client-sdk'
import { acceptsGatewayVoiceState } from 'qwen-audio-agent/gateway-client-state'
import { getRendererAdapter } from './renderer-adapters.mjs'

// This example is a normal Gateway Client. The renderer is a second,
// independently replaceable service; it never becomes a Gateway transport.
const MAX_BUFFERED_INPUT = 128 * 1024

function socketUrl(path, sessionId) {
  const url = new URL(path, window.location.origin)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  if (sessionId) url.searchParams.set('sessionId', sessionId)
  return url.href
}

function base64(bytes) {
  let binary = ''
  for (const value of new Uint8Array(bytes)) binary += String.fromCharCode(value)
  return btoa(binary)
}

function stopCapture(runtime) {
  runtime.micEpoch += 1
  runtime.capture?.close()
  runtime.capture = null
}

export function useDualConnection({ sessionId, config }) {
  const runtimeRef = useRef(null)
  const canvasRef = useRef(null)
  const videoRef = useRef(null)
  const messagesRef = useRef([])
  const [state, setState] = useState('idle')
  const [playback, setPlayback] = useState('idle')
  const [avatarState, setAvatarState] = useState(null)
  const [frameCount, setFrameCount] = useState(0)
  const [messages, setMessages] = useState([])
  const [micEnabled, setMicEnabled] = useState(false)
  const [rendererAvailable, setRendererAvailable] = useState(false)
  const [error, setError] = useState(null)

  const commitMessages = useCallback(() => {
    messagesRef.current = messagesRef.current.slice(-200)
    setMessages([...messagesRef.current])
  }, [])

  const interruptMessages = useCallback(responseId => {
    for (const message of messagesRef.current) {
      if (message.role === 'assistant' && message.live
        && (!responseId || message.responseId === responseId)) {
        message.live = false
        message.interrupted = true
      }
    }
    commitMessages()
  }, [commitMessages])

  const transcript = useCallback(event => {
    if (!['transcript.delta', 'transcript.final'].includes(event.type)) return
    const role = event.role
    const content = event.content
    if (!['user', 'assistant'].includes(role) || typeof content !== 'string') return
    const id = `${role}:${event.responseId || event.itemId || event.turnId || 'current'}`
    let message = messagesRef.current.find(item => item.id === id)
    if (!message && role === 'user') {
      message = messagesRef.current.find(item => item.pending && item.content === content)
    }
    if (!message) {
      message = { id, role, content: '' }
      messagesRef.current.push(message)
    }
    message.id = id
    message.responseId = event.responseId
    message.content = event.type === 'transcript.final' || content.startsWith(message.content)
      ? content : message.content + content
    message.live = event.type !== 'transcript.final'
    message.pending = false
    commitMessages()
  }, [commitMessages])

  const disconnect = useCallback((reason = 'client_closed') => {
    const runtime = runtimeRef.current
    if (!runtime) return
    runtime.closed = true
    // Clear the scheduler before sockets: cancellation receipts may still use
    // the active Gateway connection, but stale queued media can never survive.
    stopCapture(runtime)
    runtime.controller?.close(reason)
    runtime.gateway?.stop()
    runtime.renderer?.close()
    clearTimeout(runtime.connectTimeout)
    void runtime.context.close().catch(() => {})
    runtimeRef.current = null
  }, [])

  useEffect(() => {
    messagesRef.current = []
    setMessages([])
    setState('idle')
    setPlayback('idle')
    setAvatarState(null)
    setFrameCount(0)
    setMicEnabled(false)
    setRendererAvailable(false)
    setError(null)
    return () => disconnect('session_changed')
  }, [sessionId, disconnect])

  const start = useCallback(async () => {
    if (!config || runtimeRef.current?.connecting
      || (runtimeRef.current?.gateway?.ready && !runtimeRef.current?.rendererLost)) return
    disconnect('reconnect')
    setError(null)
    setState('connecting')
    setAvatarState(null)
    setPlayback('idle')
    setFrameCount(0)
    setMicEnabled(false)
    setRendererAvailable(false)
    // Both construction and resume happen directly inside the click gesture.
    // No autoplay override, silent oscillator or pretend playback receipt.
    let context, resume
    try {
      context = new AudioContext()
      resume = context.resume()
    } catch (cause) {
      setState('error')
      setError(cause?.message || '当前浏览器不支持音频播放。')
      return
    }
    const runtime = { context, closed: false, connecting: true, micEpoch: 0 }
    runtimeRef.current = runtime
    const current = () => runtimeRef.current === runtime && !runtime.closed
    const fail = message => {
      if (!current()) return
      disconnect('connection_lost')
      setMicEnabled(false)
      setRendererAvailable(false)
      setPlayback('idle')
      setAvatarState(null)
      setState('error')
      setError(message)
    }
    try {
      await resume
      if (!current()) return
      if (context.state !== 'running') throw new Error('请点击连接以启用浏览器音频。')
      const adapter = getRendererAdapter(config.renderer?.id || 'dhav')
      const player = await adapter.createPlayer({
        audioContext: context,
        canvas: canvasRef.current,
        video: videoRef.current,
        onFrame: () => { if (current()) setFrameCount(value => value + 1) },
      })
      if (!current()) { player.close?.(); return }
      const renderer = new WebSocket(socketUrl(config.rendererPath))
      renderer.binaryType = 'arraybuffer'
      runtime.renderer = renderer
      const controller = adapter.createController({
        player,
        sendRenderer: event => {
          if (renderer.readyState !== WebSocket.OPEN || renderer.bufferedAmount > 4 * 1024 * 1024) return false
          renderer.send(JSON.stringify(event))
          return true
        },
        sendGateway: event => runtime.gateway?.send(event) || false,
        onStatus: status => {
          if (!current()) return
          setAvatarState(status.state === 'idle' ? null : status)
          setPlayback(status.state === 'speaking' ? 'speaking' : 'idle')
          if (status.state === 'error') setError(status.reason || '数字人播放失败，请重试。')
        },
      })
      runtime.controller = controller
      runtime.connectTimeout = setTimeout(() => fail('数字人服务连接超时，请重试。'), 12_000)
      renderer.onmessage = event => {
        if (!current()) return
        try {
          controller.handleRenderer(event.data)
          // All adapters expose a bridge-ready notification; renderer-specific
          // session IDs/credentials and DHAV records stay inside the adapter.
          const message = typeof event.data === 'string' ? JSON.parse(event.data) : null
          if (message?.type !== 'session.ready' || runtime.gateway) return
          setRendererAvailable(true)
          clearTimeout(runtime.connectTimeout)
          const gateway = new GatewayClient({
            url: socketUrl(config.gatewayPath, sessionId),
            createSocket: url => new WebSocket(url),
            clientType: 'web',
            clientLabel: 'Digital human example',
            capabilities: ['input.audio', 'input.text', 'playback.receipts'],
            configure: { voiceEnabled: true, inputEnabled: false, outputEnabled: true },
            reconnect: false,
            onEvent: event => {
              if (!current()) return
              if (event.type === 'turn.started') runtime.currentTurnId = event.turnId || ''
              controller.handleGateway(event)
              transcript(event)
              if (event.type === 'playback.clear'
                || (event.type === 'voice.state' && event.state === 'listening'
                  && acceptsGatewayVoiceState(event, runtime.currentTurnId))) interruptMessages()
              if (event.type === 'response.interrupted') interruptMessages(event.responseId)
              if (event.type === 'error') setError(event.message || event.error?.message)
              if (event.type === 'input.suspend') {
                stopCapture(runtime)
                setMicEnabled(false)
                gateway.send({ type: 'input.suspend.ack', owner: event.owner })
              }
              if (event.type === 'voice.deactivated') fail('当前会话的语音控制权已转移，请重新连接。')
            },
            onStatus: status => {
              if (!current()) return
              if (status.state === 'ready') {
                runtime.connecting = false
                setState('connected')
              } else if (['disconnected', 'unavailable', 'occupied', 'replaced', 'revoked'].includes(status.state)) {
                fail(status.state === 'occupied' ? '会话已被其他客户端使用，请选择新会话。' : 'Gateway 连接已断开，请重新连接。')
              }
            },
          })
          runtime.gateway = gateway
          gateway.start()
        } catch (cause) {
          fail(cause?.message || String(cause))
        }
      }
      const rendererLost = () => {
        if (!current() || runtime.rendererLost) return
        runtime.rendererLost = true
        controller.rendererDisconnected('renderer_disconnected')
        setRendererAvailable(false)
        if (!runtime.gateway?.ready) fail('数字人服务连接失败，请重试。')
        else setError('数字人服务已断开；未开始播放的回复可降级为纯音频，或点击重新连接。')
      }
      renderer.onclose = rendererLost
      renderer.onerror = rendererLost
    } catch (cause) {
      fail(cause?.message || String(cause))
    }
  }, [config, sessionId, disconnect, transcript, interruptMessages])

  const toggleMic = useCallback(async () => {
    const runtime = runtimeRef.current
    if (!runtime?.gateway?.ready || runtime.closed) return
    if (runtime.capture || runtime.micPending) {
      runtime.micPending = false
      stopCapture(runtime)
      runtime.gateway.send({ type: 'input.mute' })
      setMicEnabled(false)
      return
    }
    setError(null)
    runtime.micPending = true
    const epoch = ++runtime.micEpoch
    let media
    const stillCurrent = () => !runtime.closed && runtime.micEpoch === epoch
    try {
      await runtime.context.resume()
      media = await navigator.mediaDevices.getUserMedia({ audio: {
        channelCount: 1, echoCancellation: true, noiseSuppression: true,
      } })
      if (!stillCurrent()) { media.getTracks().forEach(track => track.stop()); return }
      await runtime.context.audioWorklet.addModule(new URL('./microphone-worklet.js', import.meta.url))
      if (!stillCurrent()) { media.getTracks().forEach(track => track.stop()); return }
      const source = runtime.context.createMediaStreamSource(media)
      const node = new AudioWorkletNode(runtime.context, 'digital-human-microphone', { channelCount: 1 })
      const silent = runtime.context.createGain()
      silent.gain.value = 0
      node.port.onmessage = event => {
        if (!stillCurrent() || !runtime.gateway.ready) return
        if (runtime.gateway.bufferedAmount > MAX_BUFFERED_INPUT) {
          stopCapture(runtime)
          runtime.gateway.send({ type: 'input.mute' })
          setMicEnabled(false)
          setError('麦克风网络积压，已停止采集，请重新开启。')
          return
        }
        runtime.gateway.send({ type: 'input_audio_buffer.append', audio: base64(event.data) })
      }
      runtime.capture = {
        close() {
          media.getTracks().forEach(track => track.stop())
          node.port.onmessage = null
          node.port.close()
          source.disconnect()
          node.disconnect()
          silent.disconnect()
        },
      }
      runtime.gateway.send({ type: 'input.unmute' })
      source.connect(node).connect(silent).connect(runtime.context.destination)
      setMicEnabled(true)
    } catch (cause) {
      media?.getTracks().forEach(track => track.stop())
      if (stillCurrent()) setError(cause?.message || '无法开启麦克风。')
    } finally {
      if (stillCurrent()) runtime.micPending = false
    }
  }, [])

  const send = useCallback(text => {
    const value = String(text || '').trim()
    const runtime = runtimeRef.current
    if (!runtime?.gateway?.ready || runtime.closed || !value) return false
    void runtime.context.resume()
    // Stop local output synchronously; the normal Gateway text-input path also
    // interrupts upstream. Never wait for a round trip to stop the old voice.
    runtime.controller.handleGateway({ type: 'playback.clear', reason: 'new_text_input' })
    interruptMessages()
    if (!runtime.gateway.send({ type: 'text.message', text: value })) return false
    messagesRef.current.push({ id: `local:${crypto.randomUUID()}`, role: 'user', content: value, pending: true })
    commitMessages()
    return true
  }, [commitMessages, interruptMessages])

  return {
    state, playback, avatarState, frameCount, messages, micEnabled, rendererAvailable, error,
    canvasRef, videoRef, start, toggleMic, send,
    clearError: () => setError(null),
  }
}
