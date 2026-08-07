import { useCallback, useEffect, useRef, useState } from 'react'
import {
  GatewayClientEvent,
  GatewayServerEvent,
} from '../../shared/realtime-events.mjs'
import { decodePcm, pcmBase64, resample } from './audio.js'
import { confirmTrackedPlaybackStart } from './playback-lifecycle.js'
import { t } from './i18n.js'

const DEFAULT_INPUT_RATE = 16000
const OUTPUT_RATE = 24000

function socketUrl(sessionId) {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const basePath = location.pathname.endsWith('/')
    ? location.pathname
    : location.pathname.replace(/[^/]*$/, '')
  return `${protocol}//${location.host}${basePath}api/realtime?sessionId=${encodeURIComponent(sessionId)}`
}

export function acceptsVoiceState(event, currentTurnId) {
  return (
    !event.turnId
    || event.turnId === currentTurnId
    || event.origin !== 'model'
  )
}

export function visualVoiceState(state, inputActive, enabled) {
  return enabled && inputActive ? 'listening' : state
}

export function shouldClaimReleasedVoice(event, waitingForVoice) {
  return (
    waitingForVoice === true
    && event?.type === 'voice.ownership'
    && event.state === 'available'
  )
}

export function shouldAdvertiseVoice(enabled, inputReady) {
  return enabled === true && inputReady === true
}

// Keeps a persisted front end selection only while the server still offers it.
// A stale key would be refused on every connect, so it degrades to the empty
// value that means "use the server default".
export function retainedRealtimeProvider(selected, providers) {
  if (!selected) return ''
  const offered = (providers || []).some(provider => provider.key === selected)
  return offered ? selected : ''
}

export function microphoneControlEvent({
  enabled,
  inputOnlyMute = false,
  takeover = false,
} = {}) {
  if (inputOnlyMute) {
    return enabled
      ? { type: GatewayClientEvent.INPUT_UNMUTE, takeover }
      : { type: GatewayClientEvent.INPUT_MUTE }
  }
  return enabled
    ? { type: GatewayClientEvent.UNMUTE, takeover }
    : { type: GatewayClientEvent.MUTE }
}

export default function useRealtimeVoice({
  sessionId,
  enabled,
  suspended = false,
  outputMuted = false,
  inputOnlyMute = false,
  clientType = 'web',
  clientLabel = 'WebUI',
  clientStates = [],
  takeover = false,
  realtimeProvider = '',
  onEvent,
  onInputError,
}) {
  const [state, setState] = useState('idle')
  const [inputActive, setInputActive] = useState(false)
  const [inputReady, setInputReady] = useState(false)
  const [error, setError] = useState('')
  const [visualError, setVisualError] = useState(false)
  const [connectionState, setConnectionState] = useState('connecting')
  const [wakeWordActive, setWakeWordActive] = useState(false)
  const [ownership, setOwnership] = useState({
    state: 'available',
    holder: null,
  })
  const eventRef = useRef(onEvent)
  const inputErrorRef = useRef(onInputError)
  const socketRef = useRef(null)
  const audioRef = useRef(null)
  const levelElementRef = useRef(null)
  const currentTurnId = useRef('')
  const clientInstanceId = useRef(crypto.randomUUID())
  const inputSampleRate = useRef(DEFAULT_INPUT_RATE)
  const clientStatesSignature = [...new Set(
    (Array.isArray(clientStates) ? clientStates : [])
      .filter(state => typeof state === 'string' && state),
  )].sort().join(',')
  const enabledRef = useRef(enabled)
  const inputReadyRef = useRef(false)
  const outputMutedRef = useRef(outputMuted)
  const mutedPlaybackResponses = useRef(new Set())
  const playbackRef = useRef({
    cursor: 0,
    sources: [],
    startTimers: new Map(),
    startedResponses: new Set(),
    sourceCounts: new Map(),
    doneResponses: new Set(),
    failedResponses: new Set(),
  })
  eventRef.current = onEvent
  inputErrorRef.current = onInputError
  enabledRef.current = enabled
  outputMutedRef.current = outputMuted

  const setAudioLevel = useCallback(value => {
    levelElementRef.current?.style.setProperty('--level', String(value))
  }, [])

  const activateAudio = useCallback(() => {
    const AudioContext = window.AudioContext || window.webkitAudioContext
    if (!AudioContext) {
      setError(t('当前浏览器不支持实时语音播放'))
      setVisualError(true)
      return false
    }
    if (!audioRef.current || audioRef.current.state === 'closed') {
      audioRef.current = new AudioContext()
    }
    audioRef.current.resume().catch(reason => {
      setError(reason?.message || t('语音播放没有成功启用，请再点一次开启语音'))
      setVisualError(true)
    })
    return true
  }, [])

  const sendSocketEvent = useCallback(event => {
    const socket = socketRef.current
    if (socket?.readyState !== WebSocket.OPEN) return false
    socket.send(JSON.stringify(event))
    return true
  }, [])

  const sendPlaybackEvent = useCallback((type, responseId, reason = '') => {
    if (responseId) {
      sendSocketEvent({
        type,
        responseId,
        ...(reason ? { reason } : {}),
      })
    }
  }, [sendSocketEvent])

  const stopPlayback = useCallback((reason = '') => {
    const playback = playbackRef.current
    const activeResponseIds = new Set([
      ...playback.startTimers.keys(),
      ...playback.startedResponses,
      ...playback.sourceCounts.keys(),
    ])
    for (const timer of playback.startTimers.values()) {
      clearTimeout(timer)
    }
    for (const responseId of activeResponseIds) {
      sendPlaybackEvent(GatewayClientEvent.PLAYBACK_CANCELLED, responseId, reason)
    }
    playbackRef.current.sources.forEach(source => {
      try {
        source.stop()
      } catch {
        // Source already stopped.
      }
    })
    playbackRef.current = {
      cursor: 0,
      sources: [],
      startTimers: new Map(),
      startedResponses: new Set(),
      sourceCounts: new Map(),
      doneResponses: new Set(),
      failedResponses: new Set(),
    }
  }, [sendPlaybackEvent])

  const finishPlaybackIfReady = useCallback(responseId => {
    if (!responseId) return
    const playback = playbackRef.current
    if (
      !playback.startedResponses.has(responseId)
      || !playback.doneResponses.has(responseId)
      || (playback.sourceCounts.get(responseId) || 0) > 0
    ) return
    sendPlaybackEvent(GatewayClientEvent.PLAYBACK_ENDED, responseId)
    playback.startedResponses.delete(responseId)
    playback.sourceCounts.delete(responseId)
    playback.doneResponses.delete(responseId)
  }, [sendPlaybackEvent])

  const markAudioDone = useCallback(responseId => {
    if (!responseId) return
    const playback = playbackRef.current
    if (playback.failedResponses.delete(responseId)) return
    playback.doneResponses.add(responseId)
    finishPlaybackIfReady(responseId)
  }, [finishPlaybackIfReady])

  const failPlayback = useCallback((responseId, reason) => {
    const playback = playbackRef.current
    if (responseId && !playback.failedResponses.has(responseId)) {
      playback.failedResponses.add(responseId)
      const timer = playback.startTimers.get(responseId)
      if (timer !== undefined) clearTimeout(timer)
      playback.startTimers.delete(responseId)
      playback.startedResponses.delete(responseId)
      playback.sourceCounts.delete(responseId)
      playback.doneResponses.delete(responseId)
      sendPlaybackEvent(
        GatewayClientEvent.PLAYBACK_CANCELLED,
        responseId,
        'playback_error',
      )
    }
    setError(reason?.message || String(reason || t('语音播放失败')))
    setVisualError(true)
  }, [sendPlaybackEvent])

  const consumeMutedAudio = useCallback(responseId => {
    if (!responseId || mutedPlaybackResponses.current.has(responseId)) return
    mutedPlaybackResponses.current.add(responseId)
    sendPlaybackEvent(GatewayClientEvent.PLAYBACK_STARTED, responseId)
  }, [sendPlaybackEvent])

  const finishMutedAudio = useCallback(responseId => {
    if (!responseId || !mutedPlaybackResponses.current.has(responseId)) return
    mutedPlaybackResponses.current.delete(responseId)
    sendPlaybackEvent(GatewayClientEvent.PLAYBACK_ENDED, responseId)
  }, [sendPlaybackEvent])

  const play = useCallback((base64, sampleRate = OUTPUT_RATE, responseId = '') => {
    const context = audioRef.current
    if (!context) {
      failPlayback(responseId, t('语音播放尚未启用'))
      return
    }
    const playback = playbackRef.current
    if (responseId && playback.failedResponses.has(responseId)) return
    if (context.state === 'suspended') {
      context.resume().catch(reason => failPlayback(responseId, reason))
    }
    let source
    let start
    try {
      const samples = decodePcm(base64)
      const buffer = context.createBuffer(1, samples.length, sampleRate)
      buffer.copyToChannel(samples, 0)
      source = context.createBufferSource()
      source.buffer = buffer
      source.connect(context.destination)
      start = Math.max(context.currentTime + 0.02, playback.cursor)
      playback.cursor = start + buffer.duration
      playback.sources.push(source)
      if (responseId) {
        playback.sourceCounts.set(
          responseId,
          (playback.sourceCounts.get(responseId) || 0) + 1,
        )
      }
    } catch (reason) {
      failPlayback(responseId, reason)
      return
    }
    if (
      responseId
      && !playback.startedResponses.has(responseId)
      && !playback.startTimers.has(responseId)
    ) {
      const checkStarted = () => {
        const current = playbackRef.current
        if (!current.startTimers.has(responseId)) return
        if (context.state !== 'running' || context.currentTime + 0.005 < start) {
          const timer = setTimeout(checkStarted, 20)
          current.startTimers.set(responseId, timer)
          return
        }
        confirmTrackedPlaybackStart(
          current,
          responseId,
          id => sendPlaybackEvent(GatewayClientEvent.PLAYBACK_STARTED, id),
        )
      }
      const delay = Math.max(0, (start - context.currentTime) * 1000)
      const timer = setTimeout(checkStarted, delay)
      playback.startTimers.set(responseId, timer)
    }
    source.onended = () => {
      const current = playbackRef.current
      current.sources = current.sources.filter(item => item !== source)
      if (responseId && current.sourceCounts.has(responseId)) {
        // Web Audio can keep rendering while Electron throttles renderer
        // timers. Reaching onended proves that this tracked source traversed
        // the playback timeline, so it is a safe fallback acknowledgement.
        confirmTrackedPlaybackStart(
          current,
          responseId,
          id => sendPlaybackEvent(GatewayClientEvent.PLAYBACK_STARTED, id),
        )
        current.sourceCounts.set(
          responseId,
          Math.max(0, (current.sourceCounts.get(responseId) || 0) - 1),
        )
        finishPlaybackIfReady(responseId)
      }
    }
    try {
      source.start(start)
    } catch (reason) {
      playback.sources = playback.sources.filter(item => item !== source)
      failPlayback(responseId, reason)
    }
  }, [failPlayback, finishPlaybackIfReady, sendPlaybackEvent])

  useEffect(() => {
    if (suspended) {
      setState('idle')
      setInputActive(false)
      setInputReady(false)
      setAudioLevel(0)
      setError('')
      setVisualError(false)
      setConnectionState('hidden')
      return undefined
    }
    let disposed = false
    let reconnectTimer
    let reconnectDelay = 500
    const mutedResponses = mutedPlaybackResponses.current
    const connect = () => {
      if (disposed) return
      const socket = new WebSocket(socketUrl(sessionId))
      socketRef.current = socket
      socket.onopen = () => {
        reconnectDelay = 500
        setError('')
        setVisualError(false)
        setConnectionState('connecting')
        eventRef.current?.({ type: GatewayServerEvent.GATEWAY_CONNECTED })
        const inputEnabled = shouldAdvertiseVoice(
          enabledRef.current,
          inputReadyRef.current,
        )
        const outputEnabled = inputOnlyMute || inputEnabled
        socket.send(JSON.stringify({
          type: GatewayClientEvent.CONNECT,
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          locale: navigator.language,
          voiceEnabled: outputEnabled,
          inputEnabled,
          outputEnabled,
          clientType,
          clientLabel,
          clientStates: clientStatesSignature
            ? clientStatesSignature.split(',')
            : [],
          clientInstanceId: clientInstanceId.current,
          takeover,
          // Empty means "keep the server default front end".
          ...(realtimeProvider ? { provider: realtimeProvider } : {}),
        }))
      }
      socket.onmessage = message => {
        let event
        try {
          event = JSON.parse(message.data)
        } catch {
          return
        }
        if (event.type === GatewayServerEvent.VOICE_READY && event.inputSampleRate) {
          inputSampleRate.current = event.inputSampleRate
          setConnectionState('connected')
          setError('')
          setVisualError(false)
        }
        if (event.type === GatewayServerEvent.VOICE_CONNECTION) {
          setConnectionState(event.state || 'connecting')
          if (event.state === 'connected') {
            setError('')
            setVisualError(false)
          } else if (event.state === 'unavailable') {
            setError(event.message || t('语音前台连接异常，正在重试'))
            setVisualError(true)
          }
        }
        if (event.type === GatewayServerEvent.VOICE_SLEEP) {
          if (event.state === 'enabled') {
            setWakeWordActive(true)
          } else if (event.state === 'disabled') {
            setWakeWordActive(false)
          }
        }
        if (event.type === GatewayServerEvent.VOICE_OWNERSHIP) {
          setOwnership({
            state: event.state || 'available',
            holder: event.holder || null,
          })
        }
        if (event.type === GatewayServerEvent.VOICE_DEACTIVATED) {
          setOwnership({
            state: 'busy',
            holder: event.holder || null,
          })
        }
        if (event.type === GatewayServerEvent.TURN_STARTED) {
          currentTurnId.current = event.turnId || ''
        }
        if (event.type === GatewayServerEvent.VOICE_STATE) {
          if (acceptsVoiceState(event, currentTurnId.current)) {
            setState(event.state)
            if (event.state === 'listening') {
              stopPlayback('user_interruption')
            }
          }
        }
        if (event.type === GatewayServerEvent.PLAYBACK_CLEAR) {
          stopPlayback(event.reason || '')
        }
        if (event.type === GatewayServerEvent.AUDIO_DELTA) {
          if (outputMutedRef.current) {
            consumeMutedAudio(event.responseId)
          } else {
            play(event.audio, event.sampleRate, event.responseId)
          }
        }
        if (event.type === GatewayServerEvent.AUDIO_DONE) {
          if (mutedPlaybackResponses.current.has(event.responseId)) {
            finishMutedAudio(event.responseId)
          } else {
            markAudioDone(event.responseId)
          }
        }
        if (event.type === GatewayServerEvent.ERROR) setError(event.message)
        eventRef.current?.(event)
      }
      socket.onerror = () => {
        if (!disposed) {
          setConnectionState('unavailable')
          setError(t('实时语音连接中断，正在重连'))
          setVisualError(true)
        }
      }
      socket.onclose = () => {
        if (socketRef.current === socket) socketRef.current = null
        if (disposed) return
        stopPlayback()
        setState('idle')
        setConnectionState('unavailable')
        setError(t('实时语音连接中断，正在重连'))
        setVisualError(true)
        eventRef.current?.({ type: GatewayServerEvent.GATEWAY_DISCONNECTED })
        reconnectTimer = setTimeout(connect, reconnectDelay)
        reconnectDelay = Math.min(5000, reconnectDelay * 2)
      }
    }
    setError('')
    setConnectionState('connecting')
    connect()

    return () => {
      disposed = true
      clearTimeout(reconnectTimer)
      stopPlayback(suspended ? 'desktop_hidden' : 'connection_closed')
      socketRef.current?.close()
      socketRef.current = null
      mutedResponses.clear()
    }
  }, [
    clientLabel,
    clientStatesSignature,
    clientType,
    consumeMutedAudio,
    finishMutedAudio,
    inputOnlyMute,
    markAudioDone,
    play,
    realtimeProvider,
    sessionId,
    setAudioLevel,
    stopPlayback,
    suspended,
    takeover,
  ])

  useEffect(() => {
    if (outputMuted) stopPlayback()
  }, [outputMuted, stopPlayback])

  useEffect(() => {
    if (!enabled || suspended) {
      inputReadyRef.current = false
      setInputReady(false)
      sendSocketEvent(microphoneControlEvent({
        enabled: false,
        inputOnlyMute,
      }))
      setAudioLevel(0)
      setInputActive(false)
      return undefined
    }

    let disposed = false
    let media
    let source
    let processor
    let analyser
    let animation
    let visualInputActive = false
    let lastVoiceAt = 0
    inputReadyRef.current = false
    const failInput = reason => {
      const message = reason?.message || String(reason || t('无法打开麦克风'))
      inputReadyRef.current = false
      setInputReady(false)
      sendSocketEvent(microphoneControlEvent({
        enabled: false,
        inputOnlyMute,
      }))
      setAudioLevel(0)
      setInputActive(false)
      media?.getTracks().forEach(track => track.stop())
      processor?.disconnect()
      source?.disconnect()
      analyser?.disconnect()
      setError(message)
      setVisualError(true)
      inputErrorRef.current?.(message)
    }
    const startAudio = async () => {
      try {
        if (!activateAudio()) {
          failInput(t('当前浏览器不支持实时语音播放'))
          return
        }
        const context = audioRef.current
        if (!context) {
          failInput(t('无法初始化实时语音播放'))
          return
        }
        if (context.state === 'suspended') await context.resume()
        media = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        })
        if (disposed) return media.getTracks().forEach(track => track.stop())
        setVisualError(false)
        source = context.createMediaStreamSource(media)
        analyser = context.createAnalyser()
        analyser.fftSize = 512
        source.connect(analyser)
        processor = context.createScriptProcessor(2048, 1, 1)
        processor.onaudioprocess = event => {
          const socket = socketRef.current
          if (socket?.readyState !== WebSocket.OPEN) return
          const audio = resample(
            event.inputBuffer.getChannelData(0),
            context.sampleRate,
            inputSampleRate.current,
          )
          socket.send(JSON.stringify({
            type: GatewayClientEvent.AUDIO_APPEND,
            audio: pcmBase64(audio),
          }))
        }
        source.connect(processor)
        processor.connect(context.destination)
        inputReadyRef.current = true
        setInputReady(true)
        sendSocketEvent(microphoneControlEvent({
          enabled: true,
          inputOnlyMute,
          takeover,
        }))
        const samples = new Float32Array(analyser.fftSize)
        const tick = () => {
          analyser.getFloatTimeDomainData(samples)
          const power = samples.reduce((sum, value) => sum + value * value, 0)
          const level = Math.min(1, Math.sqrt(power / samples.length) / 0.18)
          setAudioLevel(level)
          const now = performance.now()
          if (level >= 0.075) {
            lastVoiceAt = now
            if (!visualInputActive) {
              visualInputActive = true
              setInputActive(true)
            }
          } else if (visualInputActive && now - lastVoiceAt >= 140) {
            visualInputActive = false
            setInputActive(false)
          }
          animation = requestAnimationFrame(tick)
        }
        tick()
      } catch (reason) {
        if (!disposed) failInput(reason)
      }
    }
    startAudio()

    return () => {
      disposed = true
      inputReadyRef.current = false
      setInputReady(false)
      cancelAnimationFrame(animation)
      setInputActive(false)
      media?.getTracks().forEach(track => track.stop())
      processor?.disconnect()
      source?.disconnect()
      analyser?.disconnect()
    }
  }, [
    activateAudio,
    enabled,
    inputOnlyMute,
    sendSocketEvent,
    sessionId,
    setAudioLevel,
    suspended,
    takeover,
  ])

  useEffect(() => {
    if (!suspended) return
    const audio = audioRef.current
    audioRef.current = null
    audio?.close()
  }, [suspended])

  useEffect(() => () => {
    audioRef.current?.close()
    audioRef.current = null
  }, [])

  const interrupt = () => {
    stopPlayback('user_interruption')
    sendSocketEvent({ type: 'interrupt' })
  }

  // 桌面唤起（快捷键/托盘）时显式唤醒 Gateway：唤醒词开启时 socket 在休眠
  // 期间保持连接，不会重发 connect，需要专门的事件恢复前台语音连接。
  const wake = useCallback(() => (
    sendSocketEvent({ type: GatewayClientEvent.WAKE })
  ), [sendSocketEvent])

  return {
    state,
    visualState: visualVoiceState(state, inputActive, enabled && !suspended),
    inputReady,
    error,
    visualError,
    connectionState,
    wakeWordActive,
    ownership,
    levelElementRef,
    activateAudio,
    interrupt,
    wake,
  }
}
